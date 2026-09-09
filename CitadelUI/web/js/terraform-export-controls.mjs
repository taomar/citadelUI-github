import { h } from './dom.mjs';
import { renderValue } from './fields.mjs';
import { recordOptions, renderParameterValue } from './paramview.mjs';
import { rawXmlEditor } from './policyview.mjs';
import { SOURCE_MAPPING, TARGET_SHAPES } from '../../shared/terraform-contract.mjs';
import { EXPORT_STATUS, exportPathKey } from '../../shared/terraform-export.mjs';
import { hclLiteral } from '../../shared/terraform-literals.mjs';
import { sameLiteralValue } from '../../shared/migration-input.mjs';

const isObject = (value) => value !== null && typeof value === 'object';
const prefix = (path, root) => root.every((part, index) => path[index] === part);
const at = (value, path) => path.reduce((node, key) =>
  isObject(node) && Object.hasOwn(node, key) ? node[key] : undefined, value);
const targetPath = (path) => path.map((key, index) => typeof key === 'number' ? `[${key}]` :
  /^[A-Za-z_]\w*$/.test(key) ? `${index ? '.' : ''}${key}` : `[${JSON.stringify(key)}]`).join('');
const targetParts = (name) => /^[A-Za-z_]\w*(?:\.\w+|\[\d+\])*$/.test(name)
  ? [...name.matchAll(/[A-Za-z_]\w*|\[(\d+)\]/g)].map((match) => match[1] === undefined ? match[0] : Number(match[1]))
  : null;
const statusBadge = (status) => h('span', { class: `tf-field-status tf-status-${status}` }, EXPORT_STATUS[status]);
const typeOf = (value) => value === null ? 'object' : Array.isArray(value) ? 'array' :
  ({ boolean: 'bool', number: 'int' })[typeof value] || typeof value;

function targetSchema(area, path, descriptor) {
  let shape = TARGET_SHAPES[area]?.[path[0]];
  for (const key of path.slice(1)) {
    shape = shape?.kind === 'list' || shape?.kind === 'map' ? shape.item : shape?.properties?.[key];
  }
  const type = typeof shape === 'string' ? ({ number: 'int' })[shape] || shape
    : shape?.kind === 'list' ? 'array' : shape ? 'object' : undefined;
  const enums = {
    'foundry_config.connection_category': ['ApiManagement', 'ModelGateway'],
    'foundry_config.deployment_in_path': ['true', 'false'],
    'foundry_config.deployment_provider': ['', 'AzureOpenAI', 'OpenAI'],
    network_acl_default_action: ['Allow', 'Deny'],
  };
  return {
    type,
    allowedValues: enums[targetPath(path)] || (path[0] === 'model_aliases' && path.at(-1) === 'strategy' ? ['priority', 'weighted'] :
      path.length === 1 && !descriptor?.rule ? descriptor?.enum : undefined),
    minValue: path.length === 1 ? descriptor?.min : undefined,
  };
}

/** An explicit field-address adapter, not a Bicep AST or a second export mapper. */
export function parameterPresentation(area, row) {
  const descriptor = SOURCE_MAPPING[area].find((item) => item.source === row.source);
  const emitted = Object.entries(row.proposed).filter(([, value]) => value !== undefined);
  const mappings = row.nested.map((entry) => ({
    ...entry, target: entry.targets.map(targetParts).find((path) => path && at(row.proposed, path) !== undefined),
  }));
  let value = structuredClone(row.sourceValue);
  // Identity-shaped maps/arrays keep payload keys exactly. Renamed structures
  // instead use only the projection's explicit source/target path metadata.
  const direct = !mappings.length && emitted.length === 1;
  if (direct) {
    const [name, proposed] = emitted[0];
    value = structuredClone(proposed);
    mappings.push({ path: [row.source], targets: [name], target: [name], status: row.status, reason: '' });
  } else {
    for (const entry of mappings) {
      if (!entry.target) continue;
      const parts = entry.path.slice(1), parent = at(value, parts.slice(0, -1));
      if (isObject(parent)) parent[parts.at(-1)] = structuredClone(at(row.proposed, entry.target));
    }
  }
  const notesAt = (path) => row.notes.filter((note) => note.path && prefix(note.path, path));
  function field(path) {
    const entry = mappings.filter((item) => prefix(path, item.path)).sort((a, b) => b.path.length - a.path.length)[0];
    const relative = entry ? path.slice(entry.path.length) : [];
    const target = entry?.target ? [...entry.target, ...relative] : null;
    const proposed = target ? at(row.proposed, target) : undefined;
    const notes = notesAt(path).filter((note) => note.path.length === path.length);
    const status = notes.some((note) => note.status === 'change') ? 'change' :
      notes.some((note) => note.status === 'input') ? 'input' : entry?.status || row.status;
    return {
      target, name: target ? targetPath(target) : entry?.targets.join(', '),
      value: proposed, source: at(row.sourceValue, path.slice(1)), status,
      reasons: [...new Set([entry?.reason, ...notes.map((note) => note.reason)].filter(Boolean))],
      schema: target ? targetSchema(area, target, descriptor) : null,
    };
  }
  return { row, value, field, notesAt, multiple: !mappings.length && emitted.length > 1, emitted };
}

/** Shared Bicepparam controls populated with exact proposed target values. */
export function exportControlContext(area, projection, base) {
  const presentations = new Map(projection.rows.map((row) => [row.source, parameterPresentation(area, row)]));
  const presentationAt = (path) => presentations.get(path[0]);
  const plain = { ...base, decorateValue: undefined, schemaForValue: undefined };

  function decorate(path, rendered) {
    const presentation = presentationAt(path);
    if (!presentation) return rendered;
    const info = presentation.field(path);
    const displayed = at(presentation.value, path.slice(1));
    if (isObject(displayed) && Object.keys(displayed).length &&
      (!Array.isArray(displayed) || Object.values(displayed).some(isObject))) return rendered;
    if (!info.name && !info.reasons.length && (info.source === undefined || isObject(info.source))) return rendered;
    // Parent containers already expose their individual fields. Annotate leaves,
    // empty collections and scalar-list controls, not a second object dump.
    if (isObject(info.value) && Object.values(info.value).some(isObject)) return rendered;
    if (isObject(info.value) && !Array.isArray(info.value) && Object.keys(info.value).length) return rendered;
    const controls = rendered.matches('input, select, textarea') ? [rendered] : [...rendered.querySelectorAll('input, select, textarea')];
    const exact = info.value !== undefined && (typeof info.value === 'boolean' ||
      (typeof info.value === 'string' && info.value.length > 40 && !info.value.includes('\n') && !controls.some((control) => control.classList.contains('policy-raw'))) ||
      controls.some((control) => control.tagName === 'SELECT'));
    const changed = info.value !== undefined && !sameLiteralValue(info.source, info.value);
    const scope = path[0] === 'llmBackendConfig' && info.target &&
      ((path.length === 3 && path[2] === 'backendId') || (path.length === 5 && path[4] === 'name'))
      ? targetPath(info.target.slice(0, -1)) : null;
    const node = h('div', {
      class: `tf-field${path[0] === 'llmBackendConfig' && path.length >= 5 ? ' tf-model-field' : ''}${rendered.classList.contains('lf-wide') ? ' lf-wide' : ''}`,
      dataset: { sourcePath: exportPathKey(path), terraformPath: info.name || '' },
    }, rendered, scope ? h('code', { class: 'tf-structure-path' }, scope) : null,
    h('div', { class: 'tf-field-mapping' },
      info.name ? h('code', { class: 'tf-field-name', title: info.name },
        info.target ? String(info.target.at(-1)) : info.name) : null,
      info.value === undefined ? h('span', { class: 'hint' }, 'Saved Bicep only; no emitted value') : statusBadge(info.status),
      exact ? h('code', { class: 'tf-exact-value' }, hclLiteral(info.value)) : null),
    changed ? h('div', { class: 'hint tf-source-difference' }, info.source === undefined
      ? 'Target default; not written to Bicep.'
      : `Saved Bicep: ${hclLiteral(info.source)}`) : null,
    info.reasons.map((reason) => ['change', 'input'].includes(info.status)
      ? h('p', { class: 'field-error' }, reason)
      : h('details', { class: 'tf-field-reason' }, h('summary', {}, 'Mapping reason'), h('p', { class: 'hint' }, reason))));
    if (path[0] === 'llmBackendConfig' && path.length === 3 && path[2] === 'authType') {
      const scheme = presentation.field([path[0], path[1], 'authScheme']);
      if (scheme.value !== undefined) node.append(h('div', { class: 'tf-derived-field' },
        h('span', { class: 'hint' }, 'Computed authentication scheme'),
        h('code', {}, `${scheme.name} = ${hclLiteral(scheme.value)}`)));
    }
    return node;
  }

  function blockerStatus(path) {
    const notes = presentationAt(path)?.notesAt(path).filter((note) => ['change', 'input'].includes(note.status)) || [];
    if (!notes.length) return null;
    const text = [...new Set(notes.map((note) => note.reason))].join('\n');
    return h('span', { class: 'chip chip-bad tf-blocker-summary', title: text, 'aria-label': text },
      notes.some((note) => note.status === 'change') ? 'Requires Terraform change' : 'Needs input');
  }

  const ctx = {
    ...base,
    valueHeading: 'Proposed Terraform value',
    backendTypes: ['ai-foundry', 'azure-openai', 'external'],
    authTypes: ['managed-identity', 'api-key-bearer', 'api-key-header', 'none'],
    decorateValue: decorate,
    decorateBackendValue: decorate,
    decorateRecordValue: decorate,
    modelStatus: blockerStatus,
    backendStatus: blockerStatus,
    paramValue: (name) => presentations.get(name)?.value,
    schemaForValue: (path, schema) => {
      const info = presentationAt(path)?.field(path);
      return info?.schema ? { ...schema, ...info.schema } : schema;
    },
    renderParameterValue: (param) => {
      const presentation = presentations.get(param.name);
      if (!presentation) return renderParameterValue(param, ctx);
      if (presentation.multiple) {
        return h('div', { class: 'tf-local-values' },
          h('p', { class: 'hint' }, `Saved Bicep: ${hclLiteral(presentation.row.sourceValue)}`),
          presentation.emitted.map(([name, value]) => h('div', { class: 'tf-local-value', dataset: { terraformPath: name } },
            h('div', { class: 'tf-field-mapping' }, h('code', {}, name), statusBadge(presentation.row.status)),
            renderValue(value, ['terraform-output', name], plain, { ...targetSchema(area, [name]), type: typeOf(value) }))));
      }
      let options = recordOptions(param.name, ctx);
      if (['foundryConfig', 'apiNameMapping'].includes(param.name)) options = { object: 'fields' };
      if (param.name === 'modelAliases') options = { record: {
        visibleColumns: ['name', 'strategy', 'models', 'weights'], maxVisible: 4,
      } };
      if (param.name === 'services') options = { record: {
        visibleColumns: ['code', 'endpointSecretName', 'apiKeySecretName'], maxVisible: 3,
        controls: { policyXml: ({ value }) => typeof value === 'string' ? rawXmlEditor({ text: value }, { ...plain, onPolicyRaw: plain.onChange }) : null },
      } };
      const value = renderParameterValue({ ...param, value: presentation.value }, ctx, options);
      return value;
    },
  };
  return ctx;
}
