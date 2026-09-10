import { h } from './dom.mjs';
import { editorField } from './editor-focus.mjs';
import { renderValue } from './fields.mjs';
import { renderLlmBackends } from './llmview.mjs';
import { rawXmlEditor } from './policyview.mjs';
import { exactNumber, isExactNumber, nativeLiteral } from '../../shared/terraform/parser.mjs';
import { nativeShapeAt } from '../../shared/terraform/review.mjs';
import { knownSensitiveValue } from '../../shared/terraform/schema.mjs';

export function nativeBlank(shape) {
  if (shape?.secure) return null;
  if (shape?.type === 'string') return '';
  if (shape?.type === 'bool') return false;
  if (shape?.type === 'number') return exactNumber('0');
  if (shape?.type === 'array') return shape.collection === 'tuple' ? shape.items.map(nativeBlank) : [];
  if (shape?.type === 'object') return Object.fromEntries(Object.entries(shape.properties || {})
    .filter(([, field]) => !field.optional && !field.secure).map(([name, field]) => [name, nativeBlank(field)]));
  return null;
}

function label(key) {
  return key.replace(/([a-z\d])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
}

export function nativeEditContext(document, base) {
  const parameters = document.schema.parameters;
  const schemaForValue = (path) => {
    const shape = nativeShapeAt(parameters, path);
    return shape ? { ...shape, native: true, name: path.at(-1), syntax: document.unit.syntax,
      secure: shape.secure || parameters[path[0]]?.secure ||
        knownSensitiveValue('nonempty-marker', null, path) } : null;
  };
  const ctx = {
    ...base, native: true, allParameters: true, backendRoot: 'llm_backend_config',
    schemaFor: (name) => parameters[name] ? { ...parameters[name], native: true } : null, schemaForValue,
    newValue: (path) => nativeBlank(schemaForValue(path)),
    newArrayItem: (path, index = 0) => nativeBlank(schemaForValue([...path, index])),
    decorateValue(path, rendered) {
      if (rendered.dataset?.nativeValueDecorated) return rendered;
      const schema = schemaForValue(path);
      const parameter = document.params.find((entry) => entry.name === path[0]);
      let value = parameter?.value;
      for (const key of path.slice(1)) value = value?.[key];
      if (!schema || schema.secure || schema.type === 'unknown' || value === undefined) return rendered;
      const optional = path.length === 1 ? !schema.required : schema.optional ||
        schemaForValue(path.slice(0, -1))?.collection === 'map';
      const actions = h('div', { class: 'form-actions' },
        value !== null && (path.length > 1 || schema.nullable !== false)
          ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => base.onChange(path, null) }, 'Set null') : null,
        optional ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => base.onRemove(path) },
          schema.hasDefault ? 'Omit; inherit default' : 'Omit input') : null);
      return h('div', { dataset: { nativeValueDecorated: 'true' } }, rendered, actions);
    },
    nativeValueControl(value, path, schema) {
      if (!schema || schema.type === 'unknown') return h('span', { class: 'hint' }, 'Undeclared or unsupported type. Preserved read-only.');
      if (schema.secure) return h('span', { class: 'hint' }, 'Sensitive input. Empty/null/absent slots are preserved; configure secrets outside Citadel.');
      if (value === undefined || value === null) {
        if (schema.type === 'any') return h('span', { class: 'hint' },
          `${value === null ? 'Explicit null.' : 'Not supplied.'} No concrete literal type is declared here. This input is read-only; configure it in an external editor.`);
        const absent = value === undefined;
        const defaultText = schema.hasDefault ? nativeLiteral(schema.defaultValue, document.unit.syntax) : '';
        return h('div', { class: 'expr expr-empty' },
          h('span', { class: 'hint' }, absent
            ? schema.hasDefault ? `Not supplied; schema default: ${defaultText.slice(0, 160)}` : 'Not supplied in this file.'
            : 'Explicit null in this file (not absence).'),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => base.onChange(path, nativeBlank(schema)) }, 'Set value'),
          absent && (path.length > 1 || schema.nullable !== false)
            ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => base.onChange(path, null) }, 'Set null') : null,
          absent && schema.hasDefault && schema.defaultValue !== undefined
            ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => base.onChange(path, structuredClone(schema.defaultValue)) }, 'Use schema default') : null);
      }
      if (path[0] === 'services' && path.at(-1) === 'policy_xml' && typeof value === 'string') {
        const editor = rawXmlEditor({ text: value }, {
          onPolicyRaw: (text) => (base.onNativePolicyChange || base.onChange)(path, text),
        });
        return editorField(h('div', { class: 'native-policy-editor' }, h('p', { class: 'hint' }, 'Literal XML in this service only. Empty uses the shared default policy, whose effects are shared and read-only here. Terraform templates must be escaped on disk; the editor handles literal escaping.'), editor), path);
      }
      return null;
    },
    optionsForValue(path, value, schema) {
      if (schema?.type === 'object') return { object: 'fields' };
      if (schema?.type === 'array' && schema.item?.type === 'object' && path[0] !== 'llm_backend_config') {
        if (path[0] === 'services' && schema.item.properties?.policy_xml) return { array: 'items', addLabel: 'Add service' };
        const columns = Object.keys(schema.item.properties || {});
        return { record: { columns, maxVisible: 4, visibleColumns: columns.slice(0, 4),
          newRecord: nativeBlank(schema.item), addLabel: path[0] === 'services' ? 'Add service' : 'Add entry' } };
      }
      return null;
    },
  };
  const field = (name, value, path) => h('div', { class: 'lf' },
    h('div', { class: 'lf-label' }, label(name)),
    h('div', { class: 'lf-ctl' }, renderValue(value, path, ctx, schemaForValue(path))));
  const backend = parameters.llm_backend_config?.item;
  const model = backend?.properties?.supported_models?.item;
  ctx.llmBinding = { root: 'llm_backend_config', id: 'backend_id', type: 'backend_type', models: 'supported_models' };
  ctx.nativeBackendFields = (entry, path) => h('div', { class: 'lf-grid' },
    Object.keys(backend?.properties || {}).filter((key) => key !== 'supported_models')
      .map((key) => field(key, entry[key], [...path, key])));
  ctx.nativeModelFields = Object.keys(model?.properties || {}).map((key) => ({ key, label: label(key) }));
  ctx.renderModelField = (descriptor, value, path) => field(descriptor.key, value, path);
  ctx.nativeDisplay = (value) => value === undefined ? 'Not supplied' : value === null ? 'null' :
    isExactNumber(value) ? value.__tfNumber : String(value);
  ctx.newBackend = () => nativeBlank(backend);
  ctx.newModel = (name) => ({ ...nativeBlank(model), name });
  ctx.renderParameterValue = (parameter) => parameter.name === 'llm_backend_config' && Array.isArray(parameter.value)
    ? renderLlmBackends(parameter.value, ctx)
    : renderValue(parameter.value, [parameter.name], ctx, parameters[parameter.name]);
  return ctx;
}

export function nativeReadonlyPolicy(document) {
  const policy = document.nativePolicySource;
  if (!policy) return null;
  return h('details', { class: 'technical-details' },
    h('summary', {}, 'Inspect shared policy source (read-only)'),
    h('p', { class: 'hint' }, policy.path),
    h('p', { class: 'hint' }, 'Other units may share this conventional policy source. The .tf configuration determines its use; Citadel does not evaluate it. Edit an owning service policy_xml literal for an isolated policy input.'),
    rawXmlEditor(policy, { readOnly: true, label: 'Shared policy XML (read-only)' }));
}
