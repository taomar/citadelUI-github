import { configurationKey, unitForAlias, unitDependencyAlias, workspaceScope } from '../workspace-configuration.mjs';
import { sha256 } from '../source-scope.mjs';
import { applyNativeEdits, isExactNumber, nativeError, parseNativeValues, NATIVE_PARSER_VERSION, initializeNativeParser } from './parser.mjs';
import { assertNonsecretValues, parseNativeSchema, validateNativeValues } from './schema.mjs';
import { assertBalancedXml } from '../policy.mjs';

export function nativeShapeAt(parameters, path) {
  let shape = Object.hasOwn(parameters, path?.[0]) ? parameters[path[0]] : null;
  for (const key of (path || []).slice(1)) {
    if (shape?.type === 'array' && Number.isInteger(key)) shape = shape.item || shape.items?.[key];
    else if (shape?.type === 'object' && typeof key === 'string') shape = shape.properties && Object.hasOwn(shape.properties, key) ? shape.properties[key] : shape.item;
    else return null;
  }
  return shape || null;
}

export function nativePreview(document, operations) {
  for (const operation of operations) {
    const path = operation.op === 'addProperty' ? [...operation.path, operation.key] : operation.path;
    const shape = nativeShapeAt(document.schema.parameters, path);
    if (!shape || shape.type === 'unknown' || shape.secure || document.schema.parameters[path[0]]?.secure) {
      throw nativeError('An edit addresses an undeclared, unsupported or sensitive native field. It is read-only in this workspace.', null, 'NATIVE_FIELD_READ_ONLY');
    }
  }
  return validateNativeAfter(document, applyNativeEdits(document.text, operations, document.unit.syntax));
}

function assertEditableChanges(before, after, parameters, path = []) {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const shape = path.length ? nativeShapeAt(parameters, path) : { type: 'object' };
  if (!shape || !shape.type || shape.type === 'unknown' || shape.secure ||
      path.length && parameters[path[0]]?.secure) {
    throw nativeError('An undeclared, unsupported or sensitive field changed. Preserve it read-only.', null, 'NATIVE_FIELD_READ_ONLY');
  }
  if (shape.type === 'any') return;
  const container = (value) => value && typeof value === 'object' && !isExactNumber(value);
  if (!container(before) && !container(after)) return;
  for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    const segment = Array.isArray(before) || Array.isArray(after) ? Number(key) : key;
    assertEditableChanges(Object.hasOwn(before || {}, key) ? before[key] : undefined,
      Object.hasOwn(after || {}, key) ? after[key] : undefined, parameters, [...path, segment]);
  }
}

export function validateNativeAfter(document, after) {
  const parsed = parseNativeValues(after, document.unit.syntax);
  assertNonsecretValues(parsed.value, document.schema.parameters, after);
  const beforeValues = document.parsed?.value || parseNativeValues(document.text, document.unit.syntax).value;
  assertEditableChanges(beforeValues, parsed.value, document.schema.parameters);
  if (document.unit.area === 'access' && Array.isArray(parsed.value.services)) {
    const before = beforeValues.services;
    for (const [index, service] of parsed.value.services.entries()) {
      if (typeof service?.policy_xml === 'string' && service.policy_xml !== before?.[index]?.policy_xml) {
        try { assertBalancedXml(service.policy_xml); }
        catch (error) { throw nativeError(`The service policy has unbalanced XML: ${error.message}`, null, 'NATIVE_POLICY_XML'); }
      }
    }
  }
  const findings = validateNativeValues(parsed.value, document.schema.parameters);
  const baseline = new Set(document.findings.filter((finding) => finding.severity === 'error').map((finding) => JSON.stringify([finding.path, finding.message])));
  if (findings.some((finding) => finding.severity === 'error' && !baseline.has(JSON.stringify([finding.path, finding.message])))) {
    throw nativeError('The native draft introduces a type, requiredness, nullability or supported-validation error. Correct the highlighted field before review.', null, 'NATIVE_VALIDATION');
  }
  return { after, parsed, findings };
}

export async function validateNativeTransactionProof(configuration, aliases, input) {
  await initializeNativeParser();
  if (!input || input.version !== NATIVE_PARSER_VERSION ||
      input.configuration !== configurationKey(configuration) || !Array.isArray(input.units) ||
      input.units.length !== aliases.length || aliases.length > 24) {
    throw nativeError('The native transaction requires its registered unit and schema proof.', null, 'NATIVE_PROOF_REQUIRED');
  }
  const scope = workspaceScope(configuration);
  const units = [];
  for (const alias of aliases) {
    scope.write(alias);
    const unit = unitForAlias(configuration, alias);
    const proof = input.units.find((entry) => entry?.valueAlias === alias);
    if (!proof || proof.unitId !== unit.id || !Array.isArray(proof.dependencies) || proof.dependencies.length > 150 ||
        !Array.isArray(proof.schemas) || proof.schemas.length !== 2) throw nativeError('Native unit proof does not match its immutable bindings.', null, 'NATIVE_PROOF_REQUIRED');
    const dependencies = [];
    const seen = new Set();
    for (const dependency of proof.dependencies) {
      if (!unitDependencyAlias(unit, dependency?.alias) || !/^[a-f0-9]{64}$/.test(dependency?.hash || '') || seen.has(dependency.alias)) {
        throw nativeError('Invalid or overlapping native dependency proof.');
      }
      seen.add(dependency.alias);
      dependencies.push({ alias: dependency.alias, hash: dependency.hash });
    }
    const prefix = unit.rootAlias ? `${unit.rootAlias}/` : '';
    const parameters = Object.create(null);
    for (const name of ['variables.tf', 'main.tf']) {
      const schemaAlias = prefix + name;
      const schema = proof.schemas.find((entry) => entry?.alias === schemaAlias);
      if (typeof schema?.text !== 'string' || await sha256(new TextEncoder().encode(schema.text)) !== dependencies.find((entry) => entry.alias === schemaAlias)?.hash) {
        throw nativeError('Native schema bytes do not match the reviewed dependency hash.');
      }
      for (const [key, field] of Object.entries(parseNativeSchema(schema.text, schemaAlias))) {
        if (Object.hasOwn(parameters, key)) throw nativeError('Duplicate native variable definitions.');
        if (field.sensitiveDefault) throw nativeError('A native schema contains a literal sensitive default. Use a nonsecret source root.', null, 'NATIVE_SENSITIVE_FILE');
        parameters[key] = field;
      }
    }
    units.push({ unitId: unit.id, valueAlias: alias, dependencies,
      // Names and type flags only: never retain schema text/default values.
      sensitiveParameters: Object.entries(parameters).filter(([, field]) => field.secure).map(([name]) => name) });
  }
  return { version: NATIVE_PARSER_VERSION, configuration: configurationKey(configuration), units };
}

export async function assertNativeBackupSafe(configuration, proof, alias, text) {
  await initializeNativeParser();
  workspaceScope(configuration).write(alias);
  const unit = unitForAlias(configuration, alias);
  const info = proof?.units.find((entry) => entry.valueAlias === alias && entry.unitId === unit.id);
  if (!info) throw nativeError('Native backup has no owning unit proof.', null, 'NATIVE_PROOF_REQUIRED');
  const values = parseNativeValues(text, unit.syntax).value;
  assertNonsecretValues(values, Object.fromEntries(info.sensitiveParameters.map((name) => [name, { secure: true }])), text);
}

export function nativeTransactionProof(configuration, document) {
  return { version: NATIVE_PARSER_VERSION, configuration: configurationKey(configuration), units: [{
    unitId: document.unit.id, valueAlias: document.path, dependencies: document.nativeIdentity.dependencies,
    schemas: document.nativeSchemas,
  }] };
}
