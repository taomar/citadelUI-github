import {
  children, decodeHclString, isExactNumber, nativeError, objectKey,
  readHclLiteral, unwrap, withNativeCst,
} from './parser.mjs';
import { isRegionField } from '../region-fields.mjs';

const own = (value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key);
const presentSecret = (value) => Array.isArray(value) ? value.some(presentSecret) :
  value && typeof value === 'object' && !isExactNumber(value) ? Object.values(value).some(presentSecret) :
    value !== undefined && value !== null && value !== '';
const SECRET_KEY = /^(?:secretvalue|awsaccesskey|awssecretkey|entraclientsecret|piiservicekey|password|clientsecret|apikey|accesstoken|authorization|privatekey|connectionstring|sastoken)$/i;
const secretKey = (key) => SECRET_KEY.test(String(key || '').replace(/[\s_-]/g, ''));
const SECRET_CONTENT = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|(?:AccountKey|SharedAccessKey|client_secret)\s*=\s*(?!\$+\{|@\{|(?:var|local|data|module|each|self)\.)[^;\s]{8,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._~+/-]{16,}/i;

export function knownSensitiveValue(value, shape = null, path = []) {
  if (shape?.secure && presentSecret(value)) return true;
  if (secretKey(path.at(-1)) && presentSecret(value)) return true;
  if (typeof value === 'string') return SECRET_CONTENT.test(value) ||
    /<(?:set-header|set-variable)\b[^>]*name=["'](?:authorization|api-key|ocp-apim-subscription-key)["'][^>]*(?:value=["'][^"'{@][^"']+["']|>[^<]*<value>[^<{@][^<]+<\/value>)/i.test(value);
  if (Array.isArray(value)) return value.some((entry, index) => knownSensitiveValue(entry, shape?.item || shape?.items?.[index], [...path, index]));
  if (value && typeof value === 'object' && !isExactNumber(value)) {
    return Object.entries(value).some(([key, entry]) =>
      knownSensitiveValue(entry, shape?.properties?.[key] || shape?.item, [...path, key]));
  }
  return false;
}

export function assertNonsecretValues(values, parameters = {}, sourceText = null) {
  if (sourceText !== null && knownSensitiveValue(sourceText) ||
      Object.entries(values).some(([key, value]) => knownSensitiveValue(value, parameters[key], [key]))) {
    throw nativeError('This operator file contains a known sensitive value. Ordinary review/save/backup is blocked for the whole file. Move secrets to your external Terraform workflow; Citadel will not remove or persist them.', null, 'NATIVE_SENSITIVE_FILE');
  }
}

function attributes(body) {
  const result = new Map();
  for (const node of children(body, 'attribute')) {
    const [key, value] = children(node);
    if (result.has(key.text)) throw nativeError('Duplicate schema attribute.', node, 'NATIVE_DUPLICATE');
    result.set(key.text, value);
  }
  return result;
}

function callParts(input) {
  const node = unwrap(input);
  if (node.type !== 'function_call') return null;
  const [name, args] = children(node);
  return { name: name.text, args: children(args, 'expression') };
}

function parseType(input, depth = 0) {
  if (depth > 32) throw nativeError('Schema exceeds the type nesting limit.', input);
  const node = unwrap(input);
  if (node.type === 'variable_expr') {
    const name = children(node)[0]?.text;
    if (['string', 'number', 'bool', 'any'].includes(name)) return { type: name };
    return { type: 'unknown', reason: 'This type constraint is not locally interpreted.' };
  }
  const call = callParts(node);
  if (!call) return { type: 'unknown', reason: 'Unsupported type constraint.' };
  if (call.name === 'optional' && call.args.length >= 1 && call.args.length <= 2) {
    return { ...parseType(call.args[0], depth + 1), optional: true,
      ...(call.args.length === 2 ? { defaultValue: readHclLiteral(call.args[1]), hasDefault: true } : {}) };
  }
  if (['list', 'set', 'map'].includes(call.name) && call.args.length === 1) {
    return { type: call.name === 'map' ? 'object' : 'array', collection: call.name, item: parseType(call.args[0], depth + 1) };
  }
  if (call.name === 'object' && call.args.length === 1 && unwrap(call.args[0]).type === 'object') {
    const properties = {};
    for (const member of children(unwrap(call.args[0]), 'object_elem')) {
      const key = objectKey(member.childForFieldName('key'));
      if (own(properties, key)) throw nativeError('Duplicate schema object property.', member, 'NATIVE_DUPLICATE');
      Object.defineProperty(properties, key, { enumerable: true, writable: true, configurable: true,
        value: parseType(member.childForFieldName('val'), depth + 1) });
    }
    return { type: 'object', properties };
  }
  if (call.name === 'tuple' && call.args.length === 1 && unwrap(call.args[0]).type === 'tuple') {
    return { type: 'array', collection: 'tuple', items: children(unwrap(call.args[0]), 'expression').map((item) => parseType(item, depth + 1)) };
  }
  return { type: 'unknown', reason: 'Unsupported type constructor.' };
}

function referencePath(expression) {
  const list = children(expression);
  if (list[0]?.type !== 'variable_expr' || children(list[0])[0]?.text !== 'var' ||
      list.slice(1).some((node) => node.type !== 'get_attr')) return null;
  return list.slice(1).map((node) => children(node)[0].text);
}

function validationRule(node, parameter) {
  const attrs = attributes(children(node, 'body')[0]);
  const condition = attrs.get('condition');
  let call = null;
  try { call = condition && callParts(condition); }
  catch (error) { if (error.code !== 'NATIVE_EXPRESSION') throw error; }
  if (call?.name === 'contains' && call.args.length === 2) {
    const path = referencePath(call.args[1]);
    if (path?.[0] === parameter) {
      let options;
      try { options = readHclLiteral(call.args[0]); } catch (error) {
        if (error.code !== 'NATIVE_EXPRESSION') throw error;
      }
      if (Array.isArray(options) && options.every((value) => typeof value === 'string' || typeof value === 'boolean' || isExactNumber(value))) {
        return { kind: 'contains', path: path.slice(1), values: options, evaluated: true };
      }
    }
  }
  return { kind: 'unknown', evaluated: false,
    message: 'This Terraform validation expression is not locally evaluated. Validate it in your own Terraform workflow.' };
}

function shapeAt(shape, path) {
  for (const key of path) shape = shape?.properties && own(shape.properties, key) ? shape.properties[key] : shape?.item || shape?.items?.[key];
  return shape;
}

export function nativeSchemaAt(parameters, path) {
  return own(parameters, path[0]) ? shapeAt(parameters[path[0]], path.slice(1)) || null : null;
}

export function parseNativeSchema(text, alias = 'variables.tf') {
  return withNativeCst(text, 'hcl-tfvars', (root) => {
    const parameters = {};
    for (const block of children(children(root, 'body')[0], 'block')) {
      const list = children(block);
      if (list[0]?.text !== 'variable') continue;
      const labels = list.filter((node) => node.type === 'string_lit');
      if (labels.length !== 1) throw nativeError('A variable declaration must have one quoted name.', block);
      const name = decodeHclString(labels[0]);
      if (own(parameters, name)) throw nativeError('Duplicate variable declaration.', block, 'NATIVE_DUPLICATE');
      const body = children(block, 'body')[0];
      const attrs = attributes(body);
      const secure = attrs.has('sensitive') ? readHclLiteral(attrs.get('sensitive')) : false;
      const nullable = attrs.has('nullable') ? readHclLiteral(attrs.get('nullable')) : true;
      if (typeof secure !== 'boolean' || typeof nullable !== 'boolean') throw nativeError('sensitive and nullable must be literal booleans.', block);
      const type = attrs.has('type') ? parseType(attrs.get('type')) : { type: 'any' };
      const definition = { name, ...type, native: true, secure, nullable, required: !attrs.has('default'),
        hasDefault: attrs.has('default'), source: alias, validations: [] };
      if (attrs.has('description')) definition.description = readHclLiteral(attrs.get('description'));
      if (attrs.has('default')) {
        const defaultValue = readHclLiteral(attrs.get('default'));
        // The pinned gateway declares this public instruction as a default.
        // It is not an exemption for any value supplied in an operator file.
        const publicPlaceholder = secure && name === 'pii_service_key' &&
          defaultValue === 'replace-with-language-service-key-if-needed';
        if (knownSensitiveValue(defaultValue, definition, [name]) && !publicPlaceholder) definition.sensitiveDefault = true;
        else definition.defaultValue = defaultValue;
      }
      for (const validation of children(body, 'block').filter((entry) => children(entry)[0]?.text === 'validation')) {
        const rule = validationRule(validation, name);
        definition.validations.push(rule);
        if (rule.kind === 'contains') {
          const target = shapeAt(definition, rule.path);
          if (target) target.allowedValues = rule.values;
        }
      }
      Object.defineProperty(parameters, name, { value: definition, enumerable: true, configurable: true, writable: true });
    }
    return parameters;
  });
}

export function assertNonsecretConfiguration(text) {
  if (knownSensitiveValue(text) || Object.values(parseNativeSchema(text)).some((field) => field.sensitiveDefault)) {
    throw nativeError('A native configuration dependency contains a known sensitive literal. This source is blocked; use a nonsecret source root.', null, 'NATIVE_SENSITIVE_FILE');
  }
  withNativeCst(text, 'hcl-tfvars', (root) => {
    for (const node of root.descendantsOfType(['attribute', 'object_elem'])) {
      let key, expression, value;
      try {
        key = node.type === 'attribute' ? children(node)[0]?.text : objectKey(node.childForFieldName('key'));
        expression = node.type === 'attribute' ? children(node)[1] : node.childForFieldName('val');
      }
      catch (error) { if (error.code === 'NATIVE_EXPRESSION') continue; throw error; }
      try { value = readHclLiteral(expression); }
      catch (error) {
        if (error.code !== 'NATIVE_EXPRESSION') throw error;
        // Inspect literal arguments without evaluating the surrounding call or
        // traversal. A literal password inside a function is still source data.
        if (secretKey(key) && expression.descendantsOfType('string_lit').some((literal) => {
          try { return presentSecret(decodeHclString(literal)); }
          catch (failure) { if (failure.code === 'NATIVE_EXPRESSION') return true; throw failure; }
        })) {
          throw nativeError('A native dependency contains a potentially sensitive literal argument. This source is blocked.', null, 'NATIVE_SENSITIVE_FILE');
        }
        continue;
      }
      if (knownSensitiveValue(value, null, [key])) {
        throw nativeError('A native configuration dependency contains a known sensitive literal. This source is blocked; use a nonsecret source root.', null, 'NATIVE_SENSITIVE_FILE');
      }
    }
  });
}

/** Reference inventory, not evaluation, provider schema, or runtime evidence. */
export function configurationReferences(text) {
  return withNativeCst(text, 'hcl-tfvars', (root) => {
    const refs = new Set();
    for (const expression of root.descendantsOfType('expression')) {
      const path = referencePath(expression);
      if (path?.length) refs.add(path[0]);
    }
    return [...refs];
  });
}

function validateValue(value, shape, path, findings) {
  const add = (message, severity = 'error') => findings.push({ severity, param: path[0], path, message, code: 'native-schema' });
  if (!shape || shape.type === 'unknown') { add('This type is not locally interpreted; editing this field is read-only.'); return; }
  if (value === undefined) {
    if (shape.required && !shape.hasDefault && !shape.optional) add('Required native input is not supplied in this file.');
    return;
  }
  if (value === null) {
    if (shape.nullable === false) add('The variable declares nullable = false.');
    return;
  }
  if (shape.allowedValues?.length && !(isRegionField(path.at(-1)) && typeof value === 'string') &&
      !shape.allowedValues.some((entry) => nativeLiteralEqual(entry, value))) {
    add('Value is outside the values permitted by the native Terraform validation.');
  }
  if (shape.type === 'any') return;
  if (shape.type === 'number') { if (!isExactNumber(value) && !Number.isSafeInteger(value)) add('An exact Terraform number is required.'); return; }
  if (shape.type === 'bool') { if (typeof value !== 'boolean') add('A boolean is required.'); return; }
  if (shape.type === 'string') { if (typeof value !== 'string') add('A string is required.'); return; }
  if (shape.type === 'array') {
    if (!Array.isArray(value)) { add('A native list, set or tuple is required.'); return; }
    if (shape.collection === 'tuple' && value.length !== shape.items.length) add('Tuple length does not match the declared type.');
    value.forEach((entry, index) => validateValue(entry, shape.item || shape.items?.[index], [...path, index], findings));
  } else if (shape.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isExactNumber(value)) { add('A native object or map is required.'); return; }
    if (shape.properties) {
      for (const [key, field] of Object.entries(shape.properties)) {
        validateValue(own(value, key) ? value[key] : undefined, { required: !field.optional, ...field }, [...path, key], findings);
      }
      if (Object.keys(value).some((key) => !own(shape.properties, key))) add('Extra object properties are preserved but Terraform may discard them during type conversion.', 'warning');
    } else for (const [key, entry] of Object.entries(value)) validateValue(entry, shape.item, [...path, key], findings);
  }
}

function nativeLiteralEqual(left, right) {
  if (Number.isSafeInteger(left)) left = { __tfNumber: String(left) };
  if (Number.isSafeInteger(right)) right = { __tfNumber: String(right) };
  if (!isExactNumber(left) || !isExactNumber(right)) return JSON.stringify(left) === JSON.stringify(right);
  const canonical = ({ __tfNumber: text }) => {
    const parts = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
    if (!parts) throw nativeError('Unsupported exact number in validation.', null, 'NATIVE_NUMBER');
    const [, sign, whole, fraction = '', exponent = '0'] = parts;
    const digits = (whole + fraction).replace(/^0+/, '');
    if (!digits) return '0';
    const tail = /0*$/.exec(digits)[0].length;
    return `${sign}${digits.slice(0, digits.length - tail)}e${BigInt(exponent) - BigInt(fraction.length) + BigInt(tail)}`;
  };
  return canonical(left) === canonical(right);
}

export function validateNativeValues(values, parameters) {
  const findings = [];
  for (const [name, shape] of Object.entries(parameters)) {
    validateValue(own(values, name) ? values[name] : undefined, shape, [name], findings);
    if (shape.validations.some((rule) => !rule.evaluated)) {
      findings.push({ severity: 'warning', param: name, path: [name], code: 'native-validation-unevaluated',
        message: 'A declared Terraform validation is not locally evaluated. This is source editing, not Terraform validation.' });
    }
    if (shape.consumed === false) findings.push({ severity: 'warning', param: name, path: [name], code: 'native-unconsumed',
      message: 'Declared in this schema but not referenced by the inspected root configuration. Saving it does not establish a runtime effect.' });
  }
  for (const name of Object.keys(values)) if (!own(parameters, name)) findings.push({
    severity: 'warning', param: name, path: [name], code: 'native-undeclared',
    message: 'Not declared by the selected root schema. Preserved read-only; do not assume Terraform consumes it.',
  });
  return findings;
}
