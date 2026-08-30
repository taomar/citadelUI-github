/**
 * Section-based parameter view.
 *
 * Parameters are grouped exactly as their file groups them: each `====` banner
 * becomes a section, the banner prose becomes the section's explanation, and
 * dashed sub-banners become headings within it. The requirement badge comes
 * from the `REQUIRED:` / `OPTIONAL:` prefix the authors already write.
 *
 * The sheet is a datasheet, not a stack of cards. A section is a sticky band
 * with ruled rows running under it; a parameter is one record across five
 * columns -- name, type, value, environment variable, description -- under a
 * sticky column header. Nothing is boxed, so ninety-seven parameters read as
 * one continuous table rather than ninety-seven containers. `llmBackendConfig`
 * is the exception: it takes the full width and renders through the guided
 * provider editor.
 *
 * Two columns exist because the sheet had the room and nothing to say in it.
 * Ninety of ninety-seven values resolve from the environment, and forty-nine of
 * those hold no value in this file at all -- so a two-column layout printed
 * forty-nine identical empty boxes with no way to tell them apart. The variable
 * name is what distinguishes them and the description is what explains them;
 * both were previously reachable only by hovering. They are columns now.
 *
 * Ink follows data: a value the file actually sets is drawn as a filled control,
 * and a blank one is drawn as a hairline. A run of unset parameters therefore
 * reads as one quiet region rather than as a stack of identical inputs.
 *
 * Sections that carry documentation but no parameters (the trailing DEPLOYMENT
 * NOTES appendix, for example) are rendered as notes rather than as empty forms
 * -- they are reference material, not something to fill in.
 */

import { h } from './dom.mjs';
import { renderValue } from './fields.mjs';
import { picker } from './picker.mjs';
import { renderBlocks, summarise } from './docblocks.mjs';
import { renderLlmBackends } from './llmview.mjs';
import { explains } from './explain.mjs';
import { foundryCatalog } from './llmschema.mjs';
import { APIM_SKUS, API_CENTER_HELP, LOGIC_APPS_TEMPLATE } from './azuremeta.mjs';
import { editableValue } from './validation.mjs';

const ENV_CALL = 'readEnvironmentVariable';

const FOUNDRY_MODELS = foundryCatalog().map((model) => ({
  value: model.name,
  meta: [model.modelFormat, model.modelVersion, model.sku].filter(Boolean).join(' · '),
  group: model.kind || 'other',
  record: {
    publisher: model.modelFormat,
    version: model.modelVersion,
    sku: model.sku,
    capacity: model.capacity,
  },
}));

export function foundryServiceOptions(instances) {
  const options = Array.isArray(instances) ? instances : [];
  return [
    { value: '', label: 'All instances' },
    ...options.map((instance, index) => ({
      value: String(index),
      label: `${index} — ${editableValue(instance.name) || 'unnamed'} · ${editableValue(instance.location) || 'no location'}`,
    })),
  ];
}

function foundryIndexControl({ value, hasValue, index, path, ctx }) {
  const instances = ctx.paramValue('aiFoundryInstances');
  const options = Array.isArray(instances) ? instances : [];
  const choices = foundryServiceOptions(options);
  const select = h(
    'select',
    {
      class: 'ctl ctl-w-short',
      'aria-label': `AI service for model row ${index + 1}`,
      onchange: (event) => {
        if (event.target.value === '') {
          if (hasValue) ctx.onRemove([...path, index, 'aiserviceIndex']);
        } else if (hasValue) {
          ctx.onChange([...path, index, 'aiserviceIndex'], Number(event.target.value));
        } else {
          ctx.onAddProperty([...path, index], 'aiserviceIndex', Number(event.target.value));
        }
      },
    },
    h('option', { value: '', selected: !hasValue }, choices[0].label),
    hasValue && (!Number.isInteger(value) || value < 0 || value >= options.length)
      ? h('option', { value: String(value), selected: true }, `${value} — invalid index`)
      : null,
    choices.slice(1).map((choice) =>
      h(
        'option',
        { value: choice.value, selected: value === Number(choice.value) },
        choice.label
      )
    )
  );
  return select;
}

function additionalFoundryPicker({ value, path, ctx }) {
  const existing = new Set((value || []).map((entry) =>
    ['subscriptionId', 'resourceGroupName', 'accountName', 'projectName']
      .map((field) => String(entry && entry[field] || '').toLowerCase())
      .join('|')
  ));
  const targets = (ctx.accessTargets && ctx.accessTargets.foundries || []).filter((target) => {
    const key = ['subscriptionId', 'resourceGroupName', 'accountName', 'projectName']
      .map((field) => String(target[field] || '').toLowerCase())
      .join('|');
    return target.ready && !existing.has(key);
  });
  if (!targets.length) {
    const partial = (ctx.accessTargets && ctx.accessTargets.foundries || []).length;
    return h('p', { class: 'target-note' }, partial
      ? 'No ready local Foundry target. Missing coordinates are listed above.'
      : 'No Foundry instances are defined by the main deployment.');
  }

  const choose = picker(
    targets.map((target) => ({
      value: String(target.index),
      meta: `${target.accountName} · ${target.location || 'no location'} · ${target.projectName}`,
    })),
    (selected) => {
      const target = targets.find((entry) => String(entry.index) === selected);
      if (!target) return;
      ctx.onAppend(path, {
        subscriptionId: target.subscriptionId,
        resourceGroupName: target.resourceGroupName,
        accountName: target.accountName,
        projectName: target.projectName,
        endpointSource: '',
      });
    },
    {
      placeholder: 'Add existing Foundry…',
      ariaLabel: 'Add existing Foundry',
      freeText: false,
    }
  );
  return h('div', { class: 'target-action' }, choose.el);
}

function endpointSourceControl({ value, hasValue, index, path, ctx }) {
  const current = hasValue ? String(value || '') : '';
  const secondaryCount = Array.isArray(ctx.paramValue('additionalApimGateways'))
    ? ctx.paramValue('additionalApimGateways').length
    : 0;
  const legal = ['', 'global', 'primary', ...Array.from({ length: secondaryCount }, (_, item) => `secondary:${item}`)];
  return h(
    'select',
    {
      class: 'ctl ctl-w-short',
      'aria-label': `Endpoint source for additional Foundry row ${index + 1}`,
      onchange: (event) => {
        if (hasValue) ctx.onChange([...path, index, 'endpointSource'], event.target.value);
        else ctx.onAddProperty([...path, index], 'endpointSource', event.target.value);
      },
    },
    !legal.includes(current) ? h('option', { value: current, selected: true }, `${current} — invalid`) : null,
    legal.map((entry) => h('option', { value: entry, selected: entry === current }, entry || 'Effective global or primary'))
  );
}

function recordOptions(name, ctx) {
  const options = {
    aiFoundryModelsConfig: {
    record: {
      columns: ['aiserviceIndex'],
      visibleColumns: ['aiserviceIndex', 'name', 'publisher', 'version', 'sku', 'capacity'],
      maxVisible: 6,
      columnTracks: {
        aiserviceIndex: 'minmax(8rem, 0.85fr)',
        name: 'minmax(10rem, 1.8fr)',
        publisher: 'minmax(6.5rem, 0.75fr)',
        version: 'minmax(6rem, 0.9fr)',
        sku: 'minmax(6.5rem, 0.95fr)',
        capacity: 'minmax(4rem, 0.6fr)',
      },
      picker: {
        key: 'name',
        candidates: FOUNDRY_MODELS,
        placeholder: `Search ${FOUNDRY_MODELS.length} Foundry models…`,
        ariaLabel: 'Foundry model or custom deployment name',
        freeTextLabel: 'use custom deployment name',
        groups: [
          ['chat', 'Chat'],
          ['embeddings', 'Embeddings'],
          ['image', 'Image'],
        ],
      },
      controls: { aiserviceIndex: foundryIndexControl },
    },
  },
    additionalFoundries: {
      record: {
        columns: ['subscriptionId', 'resourceGroupName', 'accountName', 'projectName', 'endpointSource'],
        visibleColumns: ['accountName', 'projectName', 'endpointSource'],
        maxVisible: 3,
        before: additionalFoundryPicker,
        controls: { endpointSource: endpointSourceControl },
        newRecord: {
          subscriptionId: '',
          resourceGroupName: '',
          accountName: '',
          projectName: '',
          endpointSource: '',
        },
        addLabel: 'Add manually',
      },
    },
  };
  return options[name] || null;
}

export function logicAppsWorkerGuidance(skuName) {
  const worker = LOGIC_APPS_TEMPLATE.workerSizes[skuName];
  return worker
    ? `${skuName} provides ${worker.vCpu} vCPU and ${worker.memoryGb} GB memory.`
    : 'Choose WS1, WS2, or WS3.';
}

function guidanceFor(param, ctx) {
  if (param.name === 'apimSku') {
    return h('p', { class: 'param-guidance' }, 'Template-supported APIM tiers only. Capacity and capabilities vary by tier.');
  }
  if (param.name === 'apimSkuUnits') {
    const sku = ctx.paramValue('apimSku');
    const meta = APIM_SKUS[sku];
    return meta ? h('p', { class: 'param-guidance' }, `${meta.help} Capacity: ${meta.min === meta.max ? meta.min : `${meta.min}–${meta.max}`}.`) : null;
  }
  if (param.name === 'logicAppsSkuName') {
    return h(
      'div',
      { class: 'template-facts' },
      h('strong', {}, 'Worker size (vertical scale)'),
      h('span', {}, logicAppsWorkerGuidance(ctx.paramValue('logicAppsSkuName'))),
      h('span', {}, 'Assigned plan instances are configured independently.')
    );
  }
  if (param.name === 'logicAppsSkuCapacityUnits') {
    return h(
      'div',
      { class: 'template-facts' },
      h('strong', {}, 'Assigned plan instances (horizontal baseline capacity)'),
      h('span', {}, '1–20 under the current template, independent of worker size.'),
      h('span', {}, `Fixed by template: ${LOGIC_APPS_TEMPLATE.fixedFacts.join(' · ')}`)
    );
  }
  if (param.name === 'apicSku') return h('p', { class: 'param-guidance' }, API_CENTER_HELP);
  return null;
}

function targetAction(param, ctx) {
  const targets = ctx.accessTargets;
  if (!targets) return null;
  const definitions = {
    apim: {
      label: 'Use main deployment APIM',
      values: targets.apim ? [targets.apim] : [],
      fields: ['subscriptionId', 'resourceGroupName', 'name'],
      meta: (target) => `${target.name || 'unnamed'} · ${target.resourceGroupName || 'no resource group'}`,
    },
    foundry: {
      label: 'Choose existing Foundry',
      values: targets.foundries || [],
      fields: ['subscriptionId', 'resourceGroupName', 'accountName', 'projectName'],
      meta: (target) => `${target.accountName || 'unnamed'} · ${target.location || 'no location'} · ${target.projectName || 'no project'}`,
    },
    keyVault: {
      label: 'Use main deployment Key Vault',
      values: targets.keyVault ? [targets.keyVault] : [],
      fields: ['subscriptionId', 'resourceGroupName', 'name'],
      meta: (target) => `${target.name || 'unnamed'} · ${target.resourceGroupName || 'no resource group'}`,
    },
  };
  const definition = definitions[param.name];
  if (!definition) return null;
  const ready = definition.values.filter((value) => value.ready);
  const missing = [...new Set(definition.values.flatMap((value) => value.missingLocal || value.missing || []))];
  if (!ready.length) {
    return h('p', { class: 'target-note finding-error' }, `${definition.label} unavailable. Missing local fields: ${missing.join(', ') || 'target definition'}.`);
  }
  const control = picker(
    ready.map((target, index) => ({ value: String(index), meta: definition.meta(target) })),
    (selected) => ctx.applyObject([param.name], ready[Number(selected)], definition.fields),
    { placeholder: definition.label, ariaLabel: definition.label, freeText: false }
  );
  return h('div', { class: 'target-action' }, control.el);
}

/**
 * `scroll-behavior: auto !important` in a reduced-motion media query does not
 * override a `behavior: 'smooth'` passed to scrollIntoView -- the option wins.
 * The preference has to be read here or it is not honoured at all.
 */
function scrollBehavior() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

function requirementChip(requirement) {
  if (!requirement) return null;
  return h('span', { class: `chip chip-${requirement}` }, requirement);
}

/**
 * True when the value comes from the environment rather than from this file.
 * Mirrors the shape fields.mjs unwraps: a readEnvironmentVariable call, bare or
 * wrapped in a single int()/bool()/string() cast.
 */
function envCall(value) {
  if (!value || typeof value !== 'object' || !('__expr' in value)) return null;
  if (value.callee === ENV_CALL) return value;
  const inner = Array.isArray(value.args) && value.args.length === 1 ? value.args[0] : null;
  return inner && inner.callee === ENV_CALL ? inner : null;
}

function isEnvSourced(value) {
  return Boolean(envCall(value));
}

/** The environment variable a value reads, when it reads one. */
function envVarName(value) {
  const call = envCall(value);
  const name = call && call.args[0];
  return typeof name === 'string' ? name : null;
}

/**
 * The literal this file supplies, looking through an environment lookup to the
 * fallback that is the only part of it the file actually owns.
 */
function ownValue(value) {
  const call = envCall(value);
  if (!call) return value;
  return call.args.length > 1 ? call.args[1] : undefined;
}

/**
 * Blank means the file states no value here -- the parameter resolves entirely
 * from the environment at deployment time. Forty-nine of ninety-seven rows are
 * blank, so this is a layout-defining case, not an edge case.
 */
function isBlank(value) {
  const own = ownValue(value);
  return own === undefined || own === null || own === '';
}

/**
 * Content type of the control, so a toggle, a port number, a region name and a
 * sixty-character string are not all given the same width.
 */
function valueKind(param, schema) {
  const value = param.value;
  if (Array.isArray(value)) return 'array';
  if (value && typeof value === 'object' && !('__expr' in value)) return 'object';
  if (value && typeof value === 'object' && !envCall(value)) return 'raw';

  const own = ownValue(value);
  const type = (schema && schema.type) || param.kind;
  if (type === 'bool' || typeof own === 'boolean') return 'bool';
  if (type === 'int' || typeof own === 'number') return 'num';
  if (schema && Array.isArray(schema.allowedValues) && schema.allowedValues.length) return 'enum';
  if (typeof own === 'string' && (own.length > 40 || own.includes('\n'))) return 'long';
  return 'text';
}

function sectionState(params, ctx) {
  let env = 0;
  let dirty = 0;
  for (const p of params) {
    if (isEnvSourced(p.value)) env += 1;
    if (ctx.pendingFor(p.name)) dirty += 1;
  }
  return { env, dirty, total: params.length };
}

/**
 * Everything known about a parameter, assembled only when the popover opens.
 * The schema sentence comes from the Bicep type; the blocks come from the
 * comments above the parameter in the file itself; the variable and the
 * declared type are stated here rather than as columns, because ninety-seven
 * rows cannot each afford five columns and only one of the five is edited.
 */
function paramExplainer(param, schema, variable, type) {
  return () => [
    h('div', { class: 'explain-title' }, h('code', {}, param.name)),
    h(
      'dl',
      { class: 'explain-facts' },
      h('dt', {}, 'Type'),
      h('dd', {}, h('code', {}, type)),
      variable ? h('dt', {}, 'From environment') : null,
      variable ? h('dd', { class: 'is-env' }, h('code', {}, variable)) : null
    ),
    schema && schema.description ? h('p', { class: 'doc-para' }, schema.description) : null,
    renderBlocks(param.doc, 'doc doc-param'),
  ];
}

/** Column header. Stated once per run of rows, sticky under the section band. */
function headRow() {
  return h(
    'div',
    { class: 'prow prow-head' },
    h('div', { class: 'pcell pcell-gut' }),
    h('div', { class: 'pcell pcell-ident' }, 'Parameter'),
    h('div', { class: 'pcell pcell-val' }, 'Value in this file')
  );
}

/**
 * The type to show when the compiler has not told us one.
 *
 * `param.kind` describes the syntax that produced the value, so an
 * environment-backed parameter reports `call`. Unwrapping the cast recovers
 * something true: `int(...)` and `bool(...)` name the type outright, and a bare
 * lookup always yields a string.
 */
const CAST_TYPE = { int: 'int', bool: 'bool', string: 'string', json: 'object' };

function declaredKind(param) {
  const v = param.value;
  if (!v || typeof v !== 'object' || !('__expr' in v)) return param.kind;
  if (v.callee === ENV_CALL) return 'string';
  if (CAST_TYPE[v.callee]) return CAST_TYPE[v.callee];
  return param.kind;
}

/**
 * One record: a provenance gutter, an identity cell, and the control.
 *
 * Three columns, not five. The variable name and the description were columns
 * because nothing else on the row could tell two blank fields apart -- but a
 * blank field now says `— not set · APIM_SERVICE_NAME` in its own cell, which
 * is the same fact in the place the eye is already looking. What is left moves
 * into the popover the name has always carried, and the row loses 500px of
 * width it was spending to say things twice. That width is what pays for the
 * second column.
 */
function paramRow(param, ctx) {
  const schema = ctx.schemaFor(param.name);
  const pending = ctx.pendingFor(param.name);

  // The LLM backend array has a dedicated editor; it needs the full row width.
  if (param.name === 'llmBackendConfig') {
    return h(
      'div',
      { class: `prow prow-full${pending ? ' prow-dirty' : ''}`, id: `param-${param.name}` },
      h(
        'div',
        { class: 'prow-fullhead' },
        h('h3', { class: 'prow-name' }, param.name),
        h('span', { class: 'ptype' }, (schema && schema.type) || param.kind),
        pending ? h('span', { class: 'chip chip-dirty' }, 'edited') : null
      ),
      renderLlmBackends(param.value, ctx, ctx)
    );
  }

  const kind = valueKind(param, schema);
  const variable = envVarName(param.value);
  // The declared Bicep type, never the expression kind. `param.kind` is `call`
  // for anything wrapped in readEnvironmentVariable(), which says how the
  // value is produced rather than what it is.
  const type = (schema && schema.type) || declaredKind(param);
  const name = h('h3', { class: 'prow-name', title: param.name }, param.name);

  const valueCell = { kind };
  const findings = ctx.findingsFor(param.name);
  if (isBlank(param.value) && kind !== 'object' && kind !== 'array' && kind !== 'raw') {
    valueCell.blank = 'yes';
  }

  const ident = h(
    'div',
    { class: 'pcell pcell-ident' },
    explains(name, paramExplainer(param, schema, variable, type)),
    h('span', { class: 'ptype' }, type),
    schema && schema.secure ? h('span', { class: 'chip chip-secure' }, 'secure') : null,
    pending ? h('span', { class: 'chip chip-dirty' }, 'edited') : null
  );

  return h(
    'div',
    {
      class: `prow${pending ? ' prow-dirty' : ''}${variable ? ' prow-env' : ''}`,
      id: `param-${param.name}`,
      dataset: { kind },
    },
    // Provenance is a 2px spine in the gutter, not a column and not a chip on
    // the control. Ninety of ninety-seven rows are environment-backed, so the
    // marker has to cost almost nothing and still be scannable down the run.
    h('div', {
      class: 'pcell pcell-gut',
      title: variable ? `Resolved from ${variable} at deployment time` : '',
    }),
    ident,
    h(
      'div',
      { class: 'pcell pcell-val', dataset: valueCell },
      targetAction(param, ctx),
      renderValue(param.value, [param.name], ctx, schema, recordOptions(param.name, ctx)),
      guidanceFor(param, ctx),
      findings.map((finding) => h('p', { class: 'field-error', role: 'alert' }, finding.message))
    )
  );
}

/**
 * How many column-stacks a run of records is allowed to break into.
 *
 * A column has to hold enough records to read as a column: three rows split
 * across three stacks is a grid, not a datasheet. Four is the floor, so a
 * group earns its second stack at eight rows and its third at twelve.
 *
 * The earlier floor of six was measured and found to be the largest remaining
 * source of the defect this rebuild exists to remove. Thirteen of fifteen
 * groups fell under it, so thirteen groups rendered one stack, a 1331px row
 * and a 320px control -- 683px of dead width per row, which is the original
 * 767px complaint with a smaller number on it. Four is the smallest run that
 * still reads as a column, and it takes those thirteen groups to two.
 *
 * The CSS takes this as a maximum and the browser still refuses any stack
 * narrower than --stack-min, so the count is data-driven at both ends and
 * there is no breakpoint anywhere in it.
 */
const ROWS_PER_STACK = 4;

function stacksFor(count) {
  return Math.max(1, Math.min(3, Math.floor(count / ROWS_PER_STACK)));
}

function groupNode(group, byName, ctx) {
  const params = group.params.map((name) => byName.get(name)).filter(Boolean);
  if (!params.length && !group.label) return null;

  return h(
    'div',
    { class: 'grp' },
    group.label ? h('h4', { class: 'grp-label' }, sectionTitle(group.label)) : null,
    renderBlocks(group.blocks, 'doc doc-group'),
    h(
      'div',
      { class: 'prows', style: `--stacks: ${stacksFor(params.length)}` },
      params.map((p) => paramRow(p, ctx))
    )
  );
}

/**
 * Section titles come from banner comments, which are written in the file as
 * `// RESOURCE NAMES - Assign custom names to ...`. Shouting is a property of
 * the comment convention, not of the heading, and nine shouted bands down a
 * sheet read as nine alarms. Sentence case restores the hierarchy without
 * touching the file.
 *
 * Acronyms are the exception and they have to be enumerated: `LOG` and `SIZE`
 * are words that happen to be short, `SKU` and `API` are not, and no rule
 * about length can tell them apart.
 */
const ACRONYMS = new Set([
  'AI', 'API', 'APIM', 'CORS', 'DNS', 'ID', 'IP', 'JSON', 'JWT', 'LLM', 'MCP',
  'SDK', 'SKU', 'SKUS', 'SSL', 'TLS', 'TTL', 'URL', 'VM', 'VNET', 'XML',
]);

function sectionTitle(raw) {
  const text = String(raw || '');
  return text.replace(/\b[A-Z][A-Z0-9&/]*(?:\s+[A-Z][A-Z0-9&/]*)*\b/g, (run) => {
    const words = run.split(/\s+/);
    if (words.length === 1 && ACRONYMS.has(run)) return run;
    if (words.length === 1 && run.length < 3) return run;
    return words
      .map((w, i) => {
        if (ACRONYMS.has(w)) return w;
        return (i === 0 ? w.charAt(0) : w.charAt(0)) + w.slice(1).toLowerCase();
      })
      .join(' ');
  });
}

/**
 * The rail names sections; it does not gloss them. A banner comment usually
 * reads `NAME - one sentence about the name`, and the sentence is what made
 * every rail entry wrap onto a second line and then truncate mid-word. The
 * name alone fits; the full text stays on the title attribute.
 */
function shortTitle(raw) {
  const text = String(raw || '');
  const cut = text.split(/\s+[-\u2013\u2014:]\s+/)[0];
  return cut && cut.length >= 4 ? cut : text;
}

function sectionNode(section, byName, ctx) {  const params = section.params.map((n) => byName.get(n)).filter(Boolean);
  const isNote = params.length === 0;
  const st = sectionState(params, ctx);
  // Reference appendices stay folded; sections carrying controls open, because a
  // collapsed accordion showed four of ninety-seven rows on a full screen.
  const open = ctx.isOpen(section.id, !isNote);
  const blocks = section.blocks || [];

  const head = h(
    'summary',
    { class: 'sec-band' },
    h('span', { class: 'sec-caret' }, '\u203a'),
    h('span', { class: 'sec-title' }, sectionTitle(section.title)),
    h(
      'span',
      { class: 'sec-tokens' },
      requirementChip(section.requirement),
      isNote
        ? h('span', { class: 'chip chip-note' }, 'reference')
        : h('span', { class: 'chip chip-count' }, `${st.total}`),
      st.env ? h('span', { class: 'chip chip-env' }, `${st.env} env`) : null,
      st.dirty ? h('span', { class: 'chip chip-dirty' }, `${st.dirty} edited`) : null
    ),
    open
      ? h('span', { class: 'sec-spacer' })
      : h('span', { class: 'sec-summary' }, summarise(section.blocks))
  );

  // Some sections carry a full field-by-field reference in their comments. It is
  // worth keeping, but printing it above the controls buries the thing the user
  // came to change -- llmBackendConfig's notes alone run past two screens. Long
  // reference folds away; short prose stays where it explains.
  const prose =
    !isNote && blocks.length > 3
      ? (() => {
          const key = `${section.id}__doc`;
          const docOpen = ctx.isOpen(key, false);
          const el = h(
            'details',
            { class: 'secdoc', open: docOpen },
            h(
              'summary',
              { class: 'secdoc-toggle' },
              h('span', { class: 'secdoc-caret' }, '\u203a'),
              `Reference notes from the file (${blocks.length})`
            ),
            renderBlocks(blocks, 'doc doc-section')
          );
          el.addEventListener('toggle', () => ctx.setOpen(key, el.open));
          return el;
        })()
      : renderBlocks(blocks, 'doc doc-section');

  const body = h(
    'div',
    { class: 'sec-body' },
    prose,
    isNote
      ? null
      : [
          headRow(),
          ...(section.groups || [{ label: null, blocks: [], params: section.params }])
            .map((g) => groupNode(g, byName, ctx))
            .filter(Boolean)
        ]
  );

  const el = h(
    'details',
    { class: `sec${isNote ? ' sec-note' : ''}`, id: `section-${section.id}`, open },
    head,
    body
  );
  el.addEventListener('toggle', () => ctx.setOpen(section.id, el.open));
  return el;
}

/**
 * Section index for the context rail.
 *
 * Exported separately from the document body so the shell can pin it beside the
 * content rather than pushing the first parameter below a wall of links. The
 * `data-section` attribute is what the shell's scroll-spy reads to keep the
 * current section marked while the sheet moves.
 */
export function renderOutlineNav(doc, ctx, onNavigate, variant) {
  const outline = doc.outline || { sections: [] };
  const sections = outline.sections || [];
  if (!sections.length) return null;

  return h(
    'nav',
    { class: `outline${variant === 'strip' ? ' outline-strip' : ''}`, 'aria-label': 'Sections' },
    h(
      'ul',
      { class: 'outline-list' },
      sections.map((s) => {
        const params = s.params.map((n) => (doc.params || []).find((p) => p.name === n)).filter(Boolean);
        const st = sectionState(params, ctx);
        return h(
          'li',
          {},
          h(
            'button',
            {
              class: `outline-link${s.params.length ? '' : ' outline-note'}`,
              dataset: { section: s.id },
              title: s.title,
              onclick: () => {
                ctx.setOpen(s.id, true);
                const target = document.getElementById(`section-${s.id}`);
                if (target) {
                  target.open = true;
                  target.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
                }
                if (onNavigate) onNavigate(s.id);
              },
            },
            h('span', { class: 'outline-label' }, sectionTitle(shortTitle(s.title))),
            st.dirty ? h('span', { class: 'outline-badge outline-badge-dirty' }, '\u25cf') : null,
            s.params.length ? h('span', { class: 'outline-badge' }, s.params.length) : null,
            st.env
              ? h('span', { class: 'outline-env', title: `${st.env} sourced from the environment` }, st.env)
              : null
          )
        );
      })
    )
  );
}

export function renderParamDocument(doc, ctx) {
  const byName = new Map(doc.params.map((p) => [p.name, p]));
  const outline = doc.outline || { intro: null, sections: [] };
  const sections = outline.sections || [];

  // Anything the outline missed still has to be editable -- presentation must
  // never be able to hide a parameter.
  const covered = new Set(sections.flatMap((s) => s.params));
  const orphans = doc.params.filter((p) => !covered.has(p.name));

  return h(
    'div',
    { class: 'document' },
    outline.intro
      ? h(
          'section',
          { class: 'intro' },
          h('h2', { class: 'intro-title' }, outline.intro.title),
          renderBlocks(outline.intro.blocks, 'doc doc-intro')
        )
      : null,
    h(
      'div',
      { class: 'sections' },
      sections.map((s) => sectionNode(s, byName, ctx)),
      orphans.length
        ? h(
            'details',
            { class: 'sec', id: 'section-__other', open: true },
            h(
              'summary',
              { class: 'sec-band' },
              h('span', { class: 'sec-caret' }, '\u203a'),
              h('span', { class: 'sec-title' }, 'Other parameters'),
              h(
                'span',
                { class: 'sec-tokens' },
                h('span', { class: 'chip chip-count' }, `${orphans.length}`)
              ),
              h('span', { class: 'sec-spacer' })
            ),
            h(
              'div',
              { class: 'sec-body' },
              headRow(),
              h(
                'div',
                { class: 'prows', style: `--stacks: ${stacksFor(orphans.length)}` },
                orphans.map((p) => paramRow(p, ctx))
              )
            )
          )
        : null
    )
  );
}
