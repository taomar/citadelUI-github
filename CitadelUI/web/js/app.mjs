/**
 * Citadel UI application shell.
 *
 * State model: the loaded document is never mutated locally. Edits accumulate as
 * path-addressed operations which are previewed server-side and then committed.
 * The browser and the file on disk therefore cannot drift, and the diff the user
 * approves is exactly the text that gets written.
 *
 * Navigation is built around the three areas that are edited in normal
 * operation. Every other parameter file in the repository stays reachable behind
 * a disclosure, so nothing is hidden -- it is just not competing for attention.
 *
 * The shell is three persistent panes plus a title block: areas rail, context
 * rail (contract list and/or section index), and the sheet. Save, discard and
 * the pending count live in the title block rather than in a header that
 * scrolls away, because the one thing a control plane must never lose is
 * whether there is unsaved work.
 */

import { api } from './api.mjs';
import { h, mount, clear } from './dom.mjs';
import { renderDiff } from './diff.mjs';
import { renderParamDocument, renderOutlineNav } from './paramview.mjs';
import { previewDocument, queueOperation } from './preview.mjs';
import { renderPolicy } from './policyview.mjs';
import { decoratePolicy } from './policynav.mjs';
import { editableValue, validateDocument } from './validation.mjs';
import { APIM_SKUS, LOGIC_APPS_TEMPLATE } from './azuremeta.mjs';

const state = {
  areas: [],
  area: null,
  catalog: null,
  contracts: null,
  contractId: null,
  contract: null,
  onboardedModels: [],
  accessTargets: null,
  policyVariables: [],
  throttleSpecs: null,
  semanticCacheSpec: null,
  contentSafetySpec: null,
  policyPreview: null,
  current: null,
  operations: [],
  policyChanges: {},
  policyRaw: null,
  policyMode: 'guided',
  tab: 'params',
  open: new Map(),
  filter: '',
  showAll: false,
  environment: null,
  envEntries: [],
  status: null,
};

const els = {};

/* ------------------------------------------------------------------ status */

let statusTimer = null;

function setStatus(message, tone = 'info', sticky = false) {
  state.status = message ? { message, tone } : null;
  clearTimeout(statusTimer);
  // Transient notices must clear themselves. A toast that is only dismissed on
  // the success path stays pinned forever the moment anything throws.
  if (message && !sticky && tone !== 'error') {
    statusTimer = setTimeout(() => {
      state.status = null;
      renderStatus();
    }, 4000);
  }
  renderStatus();
}

function renderStatus() {
  if (!state.status) {
    els.status.hidden = true;
    return;
  }
  els.status.hidden = false;
  els.status.className = `status status-${state.status.tone}`;
  mount(
    els.status,
    h('span', {}, state.status.message),
    h('button', { class: 'status-x', onclick: () => setStatus(null) }, '\u2715')
  );
}

/** Every async entry point runs through here so status can never stick. */
async function withStatus(message, fn) {
  setStatus(message, 'info', true);
  try {
    const result = await fn();
    setStatus(null);
    return result;
  } catch (err) {
    setStatus(err.message, 'error');
    return undefined;
  }
}

/* -------------------------------------------------------------- operations */

function pathKey(path) {
  return JSON.stringify(path);
}

function pushOperation(op) {
  state.operations = queueOperation(state.operations, op, state.current);
  render();
}

function pushOperations(operations) {
  for (const operation of operations) {
    state.operations = queueOperation(state.operations, operation, state.current);
  }
  render();
}

function dirtyParams() {
  return new Set(state.operations.map((o) => o.path && o.path[0]).filter(Boolean));
}

/**
 * The document as the user has expressed it: server truth plus queued edits.
 *
 * Every render rebuilds its controls from the loaded document, but queued edits
 * do not reach that document until the save is confirmed. Rendering the server
 * copy directly would therefore discard uncommitted work on screen -- a typed
 * value would snap back, and an appended backend or model would never appear.
 * Routing every render through here keeps the form showing what the user has
 * done while the file and the server's copy stay untouched until commit.
 */
function viewOf(doc) {
  return doc ? previewDocument(doc, state.operations) : doc;
}

function hasPolicyEdits() {
  return Object.keys(state.policyChanges).length > 0 || state.policyRaw !== null;
}

function pendingCount() {
  return state.operations.length + (hasPolicyEdits() ? 1 : 0);
}

/* Pending edits live only in memory: a reload discards them with no warning,
   which is how a configured throttle block was lost once already. The browser
   owns the wording of the prompt; all we control is whether it appears. */
window.addEventListener('beforeunload', (event) => {
  if (pendingCount() === 0) return;
  event.preventDefault();
  event.returnValue = '';
  return '';
});

/* -------------------------------------------------------------- edit context */

function editContext(doc) {
  const dirty = dirtyParams();
  const params = new Map((doc.params || []).map((param) => [param.name, param]));
  const findings = validateDocument(doc);
  return {
    onChange: (path, value) => pushOperation({ op: 'set', path, value }),
    onAppend: (path, value) => pushOperation({ op: 'append', path, value }),
    onRemove: (path) => pushOperation({ op: 'remove', path }),
    // `set` rewrites an existing span, so a property the file does not yet
    // carry has to be created instead of assigned.
    onAddProperty: (path, key, value) => pushOperation({ op: 'addProperty', path, key, value }),
    rerender: () => render(),
    onEditEnv: (variable) => openEnvEditor(variable),
    resolveEnv: (name) => {
      const hit = state.envEntries.find((e) => e.key === name);
      return hit ? { source: 'environment', value: hit.value } : null;
    },
    schemaFor: (name) => {
      const schema = doc.schema;
      if (!schema || !schema.available) return null;
      const definition = schema.parameters[name] || null;
      if (!definition) return null;
      if (name === 'apimSkuUnits') {
        const selected = editableValue(params.get('apimSku') && params.get('apimSku').value);
        const bounds = APIM_SKUS[selected];
        return bounds ? { ...definition, minValue: bounds.min, maxValue: bounds.max } : definition;
      }
      if (name === 'logicAppsSkuCapacityUnits') {
        return { ...definition, minValue: LOGIC_APPS_TEMPLATE.min, maxValue: LOGIC_APPS_TEMPLATE.max };
      }
      return definition;
    },
    paramValue: (name) => editableValue(params.get(name) && params.get(name).value),
    findingsFor: (name) => findings.filter((finding) => finding.param === name),
    accessTargets: state.accessTargets,
    applyObject: (path, source, fields) => {
      const target = path.reduce((value, segment) => value && value[segment], Object.fromEntries(
        (doc.params || []).map((param) => [param.name, param.value])
      ));
      const operations = fields.map((field) =>
        target && Object.prototype.hasOwnProperty.call(target, field)
          ? { op: 'set', path: [...path, field], value: source[field] }
          : { op: 'addProperty', path, key: field, value: source[field] }
      );
      pushOperations(operations);
    },
    pendingFor: (name) => dirty.has(name),
    isOpen: (id, fallback) => (state.open.has(id) ? state.open.get(id) : fallback),
    setOpen: (id, value) => state.open.set(id, value),
  };
}

/* ------------------------------------------------------------------ sidebar */

function areaButton(area) {
  const active = state.area === area.id;
  return h(
    'button',
    { class: `area${active ? ' active' : ''}`, onclick: () => selectArea(area.id) },
    h('span', { class: 'area-title' }, area.title),
    h('span', { class: 'area-sub' }, area.subtitle)
  );
}

function matchesFilter(text) {
  return !state.filter || text.toLowerCase().includes(state.filter.toLowerCase());
}

function renderSidebar() {
  const areas = h('div', { class: 'areas' }, state.areas.map(areaButton));

  const catalog = state.catalog;
  const extras = catalog
    ? catalog.files.filter(
        (f) => !state.areas.some((a) => a.path === f.path) && matchesFilter(f.path)
      )
    : [];

  const all = h(
    'details',
    { class: 'all-deployments', open: state.showAll },
    h('summary', {}, `All parameter files (${catalog ? catalog.files.length : 0})`),
    h('input', {
      class: 'ctl ctl-sm',
      type: 'search',
      placeholder: 'Filter\u2026',
      value: state.filter,
      oninput: (e) => {
        state.filter = e.target.value;
        renderSidebar();
      },
    }),
    h(
      'div',
      { class: 'all-list' },
      extras.length
        ? extras.map((f) =>
            h(
              'button',
              {
                class: `nav-item${
                  state.area === 'other' && state.current && state.current.path === f.path
                    ? ' active'
                    : ''
                }`,
                onclick: () => openOther(f.path),
              },
              h('span', { class: 'nav-name' }, f.name),
              h('span', { class: 'nav-meta' }, f.path)
            )
          )
        : h('p', { class: 'empty' }, 'No matches.')
    )
  );
  all.addEventListener('toggle', () => {
    state.showAll = all.open;
  });

  mount(els.sidebar, areas, all);
}

/* ---------------------------------------------------------------- contracts */

function contractList() {
  const data = state.contracts;
  if (!data) return h('p', { class: 'empty' }, 'Loading contracts\u2026');

  return h(
    'div',
    { class: 'contract-list' },
    h(
      'header',
      { class: 'contract-list-head' },
      h('h3', {}, 'Contracts'),
      h('button', { class: 'btn btn-sm btn-primary', onclick: openCreateContract }, 'New')
    ),
    data.contracts.map((c) =>
      h(
        'button',
        {
          class: `contract-item${state.contractId === c.id ? ' active' : ''}${
            c.isTemplate ? ' contract-template' : ''
          }`,
          onclick: () => selectContract(c.id),
        },
        h('span', { class: 'contract-name', title: c.dir }, c.name),
        h(
          'span',
          { class: 'contract-meta' },
          c.isTemplate ? h('span', { class: 'chip chip-note' }, 'template') : null,
          h('span', { class: 'chip chip-count' }, `${c.paramCount}`),
          c.hasPolicy
            ? h('span', { class: 'chip chip-ok' }, 'policy')
            : h('span', { class: 'chip chip-warn' }, 'default')
        )
      )
    ),
    data.recoverable && data.recoverable.length
      ? h(
          'p',
          { class: 'hint hint-warn' },
          `${data.recoverable.length} missing \u2014 recover from the sheet.`
        )
      : null,
    h(
      'p',
      { class: 'hint' },
      h('code', {}, `${data.root}/${data.parent}/`),
      ' is git-ignored \u2014 contracts you create stay local until you add them deliberately.'
    )
  );
}

async function restoreContract(id) {
  const res = await withStatus('Restoring contract\u2026', () => api.restoreContract(id));
  if (!res) return;
  state.contracts = await api.contracts();
  render();
  selectContract(id);
}

function openCreateContract() {
  const input = h('input', { class: 'ctl', placeholder: 'hr-chatagent' });
  const preview = h('p', { class: 'hint hint-preview' }, '');
  input.addEventListener('input', () => {
    const name = input.value.trim().toLowerCase();
    preview.textContent = name
      ? `Creates ${state.contracts.root}/${state.contracts.parent}/${name}/ containing main.bicepparam and ai-product-policy.xml`
      : '';
  });

  showModal(
    'New access contract',
    h(
      'div',
      {},
      h(
        'p',
        { class: 'hint' },
        'Copied from the module template and its default policy, with the module path and the policy reference rewired automatically.'
      ),
      h('label', { class: 'pol-label' }, 'Contract name'),
      input,
      h(
        'p',
        { class: 'hint' },
        'Lowercase letters, digits and hyphens. The name feeds Azure resource names, so it is normalised to lowercase.'
      ),
      preview
    ),
    [
      h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      h(
        'button',
        {
          class: 'btn btn-primary',
          onclick: async () => {
            const name = input.value.trim();
            if (!name) return;
            const result = await withStatus('Creating\u2026', () => api.createContract({ name }));
            if (!result) return;
            closeModal();
            state.contracts = await api.contracts();
            await selectContract(result.id);
            setStatus(`Created ${result.dir}`, 'ok');
          },
        },
        'Create'
      ),
    ]
  );
  requestAnimationFrame(() => input.focus());
}

async function selectContract(id) {
  const loaded = await withStatus('Loading contract\u2026', () =>
    Promise.all([api.contract(id), api.accessContractTargets(state.environment)])
  );
  if (!loaded) return;
  const [contract, accessTargets] = loaded;
  state.contractId = id;
  state.contract = contract;
  state.accessTargets = accessTargets;
  state.current = contract.param;
  state.operations = [];
  state.policyChanges = {};
  state.policyRaw = null;
  state.policyPreview = null;
  state.open = new Map();
  render();

  // The onboarded-model list only shapes a suggestion, so it is fetched after
  // the contract is on screen rather than made a precondition for showing it.
  if (!state.onboardedModels.length) {
    try {
      const [{ models }, specs] = await Promise.all([
        api.onboardedModels(),
        api.policyVariables(),
      ]);
      state.onboardedModels = models || [];
      state.policyVariables = specs.variables || [];
      state.throttleSpecs = specs.throttles || null;
      state.semanticCacheSpec = specs.semanticCache || null;
      state.contentSafetySpec = specs.contentSafety || null;
      render();
    } catch {
      state.onboardedModels = [];
    }
  }
}

/* ------------------------------------------------------------------- policy */

let policyPreviewToken = 0;

/**
 * Drop control entries whose payload has been emptied out.
 *
 * Adding a per-model limit and then removing it again leaves the entry present
 * but inert. Left in place the header would claim unsaved changes while the
 * diff showed none, which is exactly the kind of thing that makes the editor
 * feel untrustworthy.
 */
function pruneEmptyChanges(changes) {
  const kept = {};
  for (const [control, payload] of Object.entries(changes)) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      kept[control] = payload;
      continue;
    }
    const live = Object.entries(payload).filter(([, v]) => {
      if (Array.isArray(v)) return v.length > 0;
      if (v && typeof v === 'object') return Object.keys(v).length > 0;
      return v !== undefined;
    });
    if (live.length) kept[control] = Object.fromEntries(live);
  }
  return kept;
}

function foldPolicyChange(change) {
  const next = { ...state.policyChanges };
  if (change.control === 'allowedModels') next.allowedModels = change.value;
  else if (change.control === 'responseHeaders') next.responseHeaders = change.value;
  else if (change.control === 'tokenLimit') {
    const tl = { ...(next.tokenLimit || {}) };
    if (change.attribute) {
      tl.attributes = { ...(tl.attributes || {}), [change.attribute]: change.value };
    }
    if (change.enabled !== undefined) tl.enabled = change.enabled;
    next.tokenLimit = tl;
  } else if (
    change.control === 'tokenLimits' ||
    change.control === 'rateLimits' ||
    change.control === 'quotaLimits'
  ) {
    const key = change.control;
    const tl = { ...(next[key] || {}) };
    // Accumulated as lists so a second click does not overwrite the first: the
    // whole payload is replayed against the file on every preview and save.
    if (change.addModel) tl.addModels = [...(tl.addModels || []), change.addModel];
    if (change.removeModel) {
      // Removing something this session added cancels the addition outright,
      // rather than queuing a removal for a branch the file never had.
      const pending = (tl.addModels || []).includes(change.removeModel);
      tl.addModels = (tl.addModels || []).filter((m) => m !== change.removeModel);
      if (!pending) tl.removeModels = [...(tl.removeModels || []), change.removeModel];
    }
    if (change.perModel) {
      tl.perModel = { ...(tl.perModel || {}) };
      for (const [model, attrs] of Object.entries(change.perModel)) {
        tl.perModel[model] = { ...(tl.perModel[model] || {}), ...attrs };
      }
    }
    if (change.universal) tl.universal = { ...(tl.universal || {}), ...change.universal };
    next[key] = tl;
  } else if (change.control === 'variable') {
    next.variables = { ...(next.variables || {}), [change.key]: change.value };
  } else if (change.control === 'semanticCache') {
    const block = { ...(next.semanticCache || {}) };
    if (change.enable !== undefined) block.enable = change.enable;
    if (change.enabled !== undefined) block.enabled = change.enabled;
    if (change.lookup) block.lookup = { ...(block.lookup || {}), ...change.lookup };
    if (change.store) block.store = { ...(block.store || {}), ...change.store };
    if (change.varyBy) block.varyBy = { ...(block.varyBy || {}), ...change.varyBy };
    next.semanticCache = block;
  } else if (
    change.control === 'contentSafety' ||
    change.control === 'rateLimit' ||
    change.control === 'callQuota'
  ) {
    const block = { ...(next[change.control] || {}) };
    if (change.attributes) block.attributes = { ...(block.attributes || {}), ...change.attributes };
    if (change.categories) block.categories = { ...(block.categories || {}), ...change.categories };
    if (change.enable) block.enable = true;
    if (change.enabled !== undefined) block.enabled = change.enabled;
    if (change.addCategory) {
      const queued = (block.removeCategories || []).includes(change.addCategory);
      block.removeCategories = (block.removeCategories || []).filter((c) => c !== change.addCategory);
      if (!queued) block.addCategories = [...(block.addCategories || []), change.addCategory];
    }
    if (change.removeCategory) {
      const pending = (block.addCategories || []).includes(change.removeCategory);
      block.addCategories = (block.addCategories || []).filter((c) => c !== change.removeCategory);
      if (!pending) block.removeCategories = [...(block.removeCategories || []), change.removeCategory];
    }
    if (change.outputType) block.outputType = change.outputType;
    if (change.addBlocklist) {
      const queued = (block.removeBlocklists || []).includes(change.addBlocklist);
      block.removeBlocklists = (block.removeBlocklists || []).filter((b) => b !== change.addBlocklist);
      if (!queued) block.addBlocklists = [...(block.addBlocklists || []), change.addBlocklist];
    }
    if (change.removeBlocklist) {
      const pending = (block.addBlocklists || []).includes(change.removeBlocklist);
      block.addBlocklists = (block.addBlocklists || []).filter((b) => b !== change.removeBlocklist);
      if (!pending) block.removeBlocklists = [...(block.removeBlocklists || []), change.removeBlocklist];
    }
    next[change.control] = block;
  }
  state.policyChanges = pruneEmptyChanges(next);
  // Structured edits and hand-edited XML are mutually exclusive: mixing them
  // would splice spans computed against text the user has since rewritten.
  state.policyRaw = null;
  render();
  refreshPolicyPreview();
}

/**
 * Re-read the controls from the edited XML.
 *
 * The controls carry character spans into the policy text, so a pending change
 * cannot be projected onto them client-side the way a parameter edit can --
 * adding a per-model limit moves every span after it. The server already owns
 * the splice logic, so it re-parses the result and the screen renders that.
 */
async function refreshPolicyPreview() {
  const policy = state.contract && state.contract.policy;
  if (!policy) return;
  const token = ++policyPreviewToken;

  if (!Object.keys(state.policyChanges).length) {
    state.policyPreview = null;
    render();
    return;
  }

  try {
    const res = await api.previewPolicy(policy.path, state.policyChanges);
    if (token !== policyPreviewToken) return;
    state.policyPreview = { text: res.after, controls: res.controls };
  } catch (err) {
    if (token !== policyPreviewToken) return;
    state.policyPreview = null;
    state.status = err.message;
  }
  render();
}

function policyContext() {
  return {
    policyMode: state.policyMode,
    /**
     * Guided and raw are two views of the same file, but only one direction is
     * lossless. Guided hands the previewed XML to the textarea, so nothing is
     * lost going that way. Coming back means dropping hand-written XML that has
     * no structured equivalent, so say so before it happens rather than after.
     */
    setPolicyMode: (mode) => {
      const losing = mode === 'guided' && state.policyRaw !== null;
      if (!losing) {
        state.policyMode = mode;
        render();
        return;
      }
      showModal(
        'Discard hand-edited XML?',
        h(
          'div',
          {},
          h(
            'p',
            { class: 'hint' },
            'The guided editor works from the file on disk. Switching back now discards the XML you typed here, because the form has no way to represent it.'
          )
        ),
        [
          h('button', { class: 'btn', onclick: closeModal }, 'Stay in Raw XML'),
          h(
            'button',
            {
              class: 'btn btn-primary',
              onclick: () => {
                state.policyRaw = null;
                state.policyMode = 'guided';
                closeModal();
                render();
              },
            },
            'Discard and switch'
          ),
        ]
      );
    },
    onPolicyChange: foldPolicyChange,
    policyVariables: state.policyVariables,
    throttleSpecs: state.throttleSpecs,
    semanticCacheSpec: state.semanticCacheSpec,
    contentSafetySpec: state.contentSafetySpec,
    onboardedModels: state.onboardedModels,
    onPolicyRaw: (text) => {
      state.policyRaw = text;
      state.policyChanges = {};
    },
  };
}

async function savePolicy() {
  const policy = state.contract && state.contract.policy;
  if (!policy) return;

  const raw = state.policyRaw;
  const payload = {
    path: policy.path,
    expectedMtimeMs: policy.mtimeMs,
    ...(raw !== null ? { text: raw } : { changes: state.policyChanges }),
  };

  const preview =
    raw !== null
      ? { before: policy.text, after: raw, changed: raw !== policy.text }
      : await withStatus('Preparing preview\u2026', () =>
          api.previewPolicy(policy.path, state.policyChanges)
        );
  if (!preview) return;
  if (!preview.changed) {
    setStatus('Nothing changed in the policy.', 'info');
    return;
  }

  const { node, stats } = renderDiff(preview.before, preview.after);
  showModal(
    'Review policy changes',
    h(
      'div',
      {},
      h('p', { class: 'hint' }, `${stats.added} added, ${stats.removed} removed in ${policy.name}.`),
      node
    ),
    [
      h('button', { class: 'btn', onclick: closeModal }, 'Back'),
      h(
        'button',
        {
          class: 'btn btn-primary',
          onclick: async () => {
            const result = await withStatus('Saving\u2026', () => api.savePolicy(payload));
            if (!result) return;
            closeModal();
            await selectContract(state.contractId);
            setStatus(
              result.changed
                ? `Saved ${result.path}. Previous revision archived to ${result.archived}`
                : 'Nothing changed.',
              'ok'
            );
          },
        },
        'Save policy'
      ),
    ]
  );
}

/* --------------------------------------------------------------- environment */

function renderEnvironment() {
  const catalog = state.catalog;
  const meta = state.current.meta;
  const vars = (meta && meta.envVars) || [];

  const picker = h(
    'div',
    { class: 'env-picker' },
    h('label', {}, 'Environment'),
    h(
      'select',
      {
        class: 'ctl',
        onchange: async (e) => {
          state.environment = e.target.value || null;
          await loadEnvironment();
          render();
        },
      },
      h('option', { value: '' }, '\u2014 none selected \u2014'),
      ...catalog.environments.map((env) =>
        h('option', { value: env.name, selected: env.name === state.environment }, env.name)
      )
    ),
    h('button', { class: 'btn btn-sm', onclick: createEnvironment }, 'New environment')
  );

  if (!vars.length) {
    return h(
      'div',
      { class: 'env' },
      picker,
      h('p', { class: 'empty' }, 'This deployment does not read any environment variables.')
    );
  }

  const rows = vars.map((v) => {
    const hit = state.envEntries.find((e) => e.key === v.name);
    return h(
      'div',
      { class: 'env-row' },
      h('code', { class: 'env-key' }, v.name),
      h('input', {
        class: 'ctl',
        value: hit ? hit.value : '',
        placeholder: v.default === null || v.default === undefined ? '' : String(v.default),
        dataset: { envKey: v.name },
      }),
      h('span', { class: `chip chip-${hit ? 'ok' : 'note'}` }, hit ? 'set' : 'default')
    );
  });

  return h(
    'div',
    { class: 'env' },
    picker,
    h(
      'p',
      { class: 'hint' },
      'These values live in ',
      h('code', {}, `.azure/${state.environment || '<env>'}/.env`),
      '. The parameter file reads them at deployment time, so this is the right place to change them.'
    ),
    h('div', { class: 'env-rows' }, rows),
    h(
      'button',
      { class: 'btn btn-primary', disabled: !state.environment, onclick: saveEnvironment },
      'Save environment'
    )
  );
}

async function loadEnvironment() {
  if (!state.environment) {
    state.envEntries = [];
    return;
  }
  const env = await api.environment(state.environment);
  state.envEntries = env.entries || [];
}

async function createEnvironment() {
  const name = prompt('Environment name (e.g. dev)');
  if (!name) return;
  const ok = await withStatus('Creating\u2026', () => api.saveEnvironment(name, {}));
  if (!ok) return;
  state.catalog = await api.deployments();
  state.environment = name;
  await loadEnvironment();
  setStatus(`Created .azure/${name}/.env`, 'ok');
  render();
}

async function saveEnvironment() {
  const updates = {};
  els.workspace.querySelectorAll('[data-env-key]').forEach((input) => {
    updates[input.dataset.envKey] = input.value;
  });
  const result = await withStatus('Saving\u2026', () =>
    api.saveEnvironment(state.environment, updates)
  );
  if (!result) return;
  await loadEnvironment();
  setStatus(`Saved ${result.file} (${result.updated.length} variables)`, 'ok');
  render();
}

function openEnvEditor(variable) {
  state.tab = 'env';
  render();
  requestAnimationFrame(() => {
    const target = els.workspace.querySelector(`[data-env-key="${variable}"]`);
    if (target) {
      target.focus();
      target.scrollIntoView({
        block: 'center',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
    }
  });
}

/* -------------------------------------------------------------- review/save */

async function openReview() {
  if (!state.operations.length) {
    setStatus('No pending changes.', 'info');
    return;
  }
  const findings = validateDocument(viewOf(state.current));
  if (findings.length) {
    setStatus(`Resolve ${findings.length} validation ${findings.length === 1 ? 'error' : 'errors'} before review.`, 'error');
    return;
  }
  const preview = await withStatus('Preparing preview\u2026', () =>
    api.preview(state.current.path, state.operations)
  );
  if (!preview) return;

  const { node, stats } = renderDiff(preview.before, preview.after);
  showModal(
    'Review changes',
    h(
      'div',
      {},
      h(
        'p',
        { class: 'hint' },
        `${stats.added} added, ${stats.removed} removed. Comments and formatting outside these lines are preserved byte-for-byte.`
      ),
      node
    ),
    [
      h('button', { class: 'btn', onclick: closeModal }, 'Back'),
      h('button', { class: 'btn btn-primary', onclick: commitSave }, 'Save changes'),
    ]
  );
}

async function commitSave() {
  const findings = validateDocument(viewOf(state.current));
  if (findings.length) {
    closeModal();
    setStatus('The document became invalid. Resolve validation errors before saving.', 'error');
    return;
  }
  const result = await withStatus('Saving\u2026', () =>
    api.save(state.current.path, state.operations, state.current.mtimeMs)
  );
  if (!result) return;
  closeModal();
  state.operations = [];
  if (state.area === 'access-contracts') await selectContract(state.contractId);
  else await loadDocument(state.current.path);
  setStatus(
    result.changed
      ? `Saved ${result.path}. Previous revision archived to ${result.archived}`
      : 'Nothing changed.',
    'ok'
  );
}

/* --------------------------------------------------------------------- modal */

function showModal(title, body, actions) {
  mount(
    els.modal,
    h(
      'div',
      {
        class: 'modal-backdrop',
        onclick: (e) => e.target.classList.contains('modal-backdrop') && closeModal(),
      },
      h(
        'div',
        { class: 'modal' },
        h(
          'header',
          { class: 'modal-head' },
          h('h2', {}, title),
          h('button', { class: 'btn btn-ghost', onclick: closeModal }, '\u2715')
        ),
        h('div', { class: 'modal-body' }, body),
        h('footer', { class: 'modal-foot' }, actions)
      )
    )
  );
  els.modal.hidden = false;
}

function closeModal() {
  els.modal.hidden = true;
  clear(els.modal);
}

/* ----------------------------------------------------------------- rendering */

/**
 * Global actions.
 *
 * These sit in the title block, outside every scroll container, because unsaved
 * work is the state a control plane must never let out of sight. The count is
 * always present -- "no pending changes" is information, not the absence of it,
 * and a control that only appears when it matters teaches nobody where it is.
 */
function renderActions() {
  if (!state.current) {
    clear(els.tbActions);
    return;
  }
  const pending = pendingCount();
  const policyTab = state.tab === 'policy';

  // Pending work is counted globally because unsaved edits must never be
  // hidden, but each tab can only save its own file. When the two disagree the
  // button says where the work actually is and goes there, rather than sitting
  // inert next to a count that claims there is something to save.
  const savableHere = policyTab ? hasPolicyEdits() : state.operations.length > 0;
  const validation = policyTab ? [] : validateDocument(viewOf(state.current));
  const elsewhere = pending > 0 && !savableHere;
  const target = policyTab ? 'params' : 'policy';
  const targetLabel = policyTab ? 'parameters' : 'policy';

  mount(
    els.tbActions,
    h(
      'span',
      { class: `tb-pending${pending ? ' is-dirty' : ''}` },
      validation.length
        ? `${validation.length} validation ${validation.length === 1 ? 'error' : 'errors'}`
        : pending ? `${pending} unsaved ${pending === 1 ? 'change' : 'changes'}` : 'no pending changes'
    ),
    h(
      'button',
      {
        class: 'btn',
        disabled: !pending,
        onclick: () => {
          state.operations = [];
          state.policyChanges = {};
          state.policyRaw = null;
          state.policyPreview = null;
          render();
        },
      },
      'Discard'
    ),
    elsewhere
      ? h(
          'button',
          {
            class: 'btn',
            title: `The unsaved changes are on the ${targetLabel} tab`,
            onclick: () => {
              state.tab = target;
              render();
            },
          },
          `Review on ${targetLabel}\u2026`
        )
      : policyTab
        ? h(
            'button',
            { class: 'btn btn-primary', disabled: !savableHere, onclick: savePolicy },
            'Review & save policy'
          )
        : h(
            'button',
            {
              class: 'btn btn-primary',
              disabled: !savableHere || validation.length > 0,
              title: validation.length ? 'Resolve validation errors before review' : '',
              onclick: openReview,
            },
            'Review & save'
          )
  );
}

/**
 * The sheet's masthead: what this file is, where it lives, and its tabs.
 *
 * Sticky, and deliberately short -- two rows -- because every pixel it takes is
 * a parameter the user cannot see. Section headers stick underneath it.
 */
function sheetStrip(title, doc, tabs, extraMeta) {
  const meta = (doc && doc.meta) || {};
  return h(
    'header',
    { class: 'sheet-strip' },
    h(
      'div',
      { class: 'strip-top' },
      h('h2', { class: 'strip-title' }, title),
      doc ? h('code', { class: 'strip-path', title: doc.path }, doc.path) : null,
      h(
        'div',
        { class: 'strip-meta' },
        extraMeta || null,
        doc && doc.schema && doc.schema.available
          ? h('span', { class: 'chip chip-ok' }, 'schema')
          : h('span', { class: 'chip chip-warn' }, 'no schema'),
        meta.envVarCount ? h('span', { class: 'chip chip-env' }, `${meta.envVarCount} env`) : null
      )
    ),
    tabs ? h('div', { class: 'strip-tabs' }, tabBar(tabs)) : null
  );
}

/**
 * The context rail: contract list and/or section index.
 *
 * Persistent rather than stacked above the content, so a ninety-seven parameter
 * file starts at its first parameter instead of below a wall of links, and so
 * position is still legible after scrolling. The rail collapses out entirely
 * when there is nothing worth pinning -- an empty pane is a worse answer than
 * no pane.
 */
function railDoc() {
  if (state.contract) return viewOf(state.contract.param);
  return viewOf(state.current);
}

/**
 * Where the section index lives.
 *
 * A parameter row costs about 640px: an identifier that does not wrap plus a
 * control at the width its value needs. Two of those side by side is the whole
 * point of the datasheet -- it is what turns twenty-two visible records into
 * forty-four -- and two of those plus the gutter needs about 1310px of sheet.
 * Below roughly 1600px of window, keeping a 214px section rail costs exactly
 * the column it was helping you navigate. So the index moves: same nav, same
 * state, rendered once, as a strip above the sheet instead of a rail beside it.
 */
const SECTIONS_IN_RAIL = window.matchMedia('(min-width: 100rem)');
SECTIONS_IN_RAIL.addEventListener('change', () => render());

function renderContextRail() {
  const area = state.areas.find((a) => a.id === state.area) || null;
  const blocks = [];

  if (area && area.kind === 'contracts') {
    blocks.push(h('div', { class: 'rail-block' }, contractList()));
    const policyNav = state.tab === 'policy' ? els.workspace.querySelector('.policy .pnav') : null;
    if (policyNav) {
      policyNav.parentElement.classList.add('policy-nav-external');
      blocks.push(h('div', { class: 'rail-block rail-block-grow rail-policy' }, policyNav));
    }
  }

  const doc = railDoc();
  const sections = (doc && doc.outline && doc.outline.sections) || [];
  if (doc && state.tab === 'params' && sections.length >= 3 && SECTIONS_IN_RAIL.matches) {
    const nav = renderOutlineNav(doc, editContext(doc), markCurrentSection);
    if (nav) {
      blocks.push(
        h(
          'div',
          { class: 'rail-block rail-block-grow' },
          h(
            'div',
            { class: 'rail-head' },
            h('span', {}, 'Sections'),
            h('span', { class: 'rail-count' }, `${sections.length}`)
          ),
          nav
        )
      );
    }
  }

  if (!blocks.length) {
    els.shell.dataset.rail = 'off';
    clear(els.contextRail);
    return;
  }

  els.shell.dataset.rail = 'on';
  mount(els.contextRail, ...blocks);
}

/**
 * Keep the rail's current-section marker honest while the sheet scrolls.
 *
 * A cheap geometric read on scroll beats IntersectionObserver here: sections are
 * collapsible, so the observed set changes constantly and re-registering
 * observers on every toggle costs more than measuring on demand.
 */
function markCurrentSection() {
  const links = els.contextRail.querySelectorAll('.outline-link');
  if (!links.length) return;
  const line = els.workspace.getBoundingClientRect().top + 96;
  let current = links[0];
  for (const link of links) {
    const sec = document.getElementById(`section-${link.dataset.section}`);
    if (sec && sec.getBoundingClientRect().top <= line) current = link;
  }
  for (const link of links) link.classList.toggle('current', link === current);
}

function tabBar(tabs) {
  return h(
    'nav',
    { class: 'tabs' },
    tabs.map(([id, label]) =>
      h(
        'button',
        {
          class: `tab${state.tab === id ? ' active' : ''}`,
          onclick: () => {
            state.tab = id;
            render();
          },
        },
        label
      )
    )
  );
}

function renderWorkspace() {
  const area = state.areas.find((a) => a.id === state.area) || null;
  if (area && area.kind === 'contracts') return renderContractsArea(area);

  const doc = viewOf(state.current);
  if (!doc) {
    mount(
      els.workspace,
      h(
        'div',
        { class: 'welcome' },
        h('h2', {}, 'Bicep parameters, as a control plane'),
        h(
          'p',
          {},
          'Citadel reads the parameter files already in this repository, renders them as forms, and writes your changes back with every comment intact. Nothing leaves this machine and nothing deploys.'
        ),
        h(
          'ul',
          { class: 'welcome-list' },
          h(
            'li',
            {},
            h('strong', {}, 'Main deployment'),
            ' \u2014 the core Azure infrastructure configuration.'
          ),
          h(
            'li',
            {},
            h('strong', {}, 'LLM onboarding'),
            ' \u2014 register providers and models onto the gateway.'
          ),
          h(
            'li',
            {},
            h('strong', {}, 'Access contracts'),
            ' \u2014 per-product parameters and their APIM policy.'
          )
        ),
        h('p', { class: 'hint' }, 'Choose an area in the left rail to begin.')
      )
    );
    return;
  }

  const meta = doc.meta || {};
  const tabs = [
    ['params', `Parameters (${doc.params.length})`],
    meta.envVarCount ? ['env', `Environment (${meta.envVarCount})`] : null,
    ['raw', 'Raw file'],
  ].filter(Boolean);

  const body =
    state.tab === 'raw'
      ? h('pre', { class: 'raw' }, doc.text)
      : state.tab === 'env'
        ? renderEnvironment()
        : renderParamDocument(doc, editContext(doc));

  const outlineStrip =
    state.tab === 'params' && !SECTIONS_IN_RAIL.matches
      ? renderOutlineNav(doc, editContext(doc), markCurrentSection, 'strip')
      : null;

  mount(
    els.workspace,
    h(
      'div',
      { class: 'sheetwrap' },
      sheetStrip(area ? area.title : doc.path, doc, tabs),
      area && area.blurb ? h('p', { class: 'sheet-blurb' }, area.blurb) : null,
      outlineStrip,
      h('div', { class: 'sheet-body' }, body)
    )
  );
}

/**
 * Data recovery, at the size of the stakes.
 *
 * This panel exists because contracts have gone missing from disk and the app
 * keeps a copy of the last save. It is the only screen in the product that can
 * give a user their work back, and it used to be four small buttons and a
 * 12px sentence at 4.17:1 in a 214px rail -- literally the weakest element on
 * screen. It is now the first thing on the sheet, full width, with the ink
 * token that clears AA on the wash and one outlined action per contract.
 */
function recoveryBanner() {
  const data = state.contracts;
  const list = (data && data.recoverable) || [];
  if (!list.length) return null;

  return h(
    'section',
    { class: 'recover', role: 'alert' },
    h(
      'div',
      { class: 'recover-head' },
      h(
        'h2',
        { class: 'recover-title' },
        `${list.length} contract${list.length === 1 ? ' is' : 's are'} missing from disk`
      ),
      h(
        'p',
        { class: 'recover-lede' },
        'A copy of each was kept the last time it was saved. Restoring writes the folder back to ',
        h('code', {}, `${data.root}/${data.parent}/`),
        ' with its parameter file and its policy.'
      )
    ),
    h(
      'ul',
      { class: 'recover-list' },
      list.map((r) => {
        const name = r.id.replace(/^contracts\//, '');
        return h(
          'li',
          { class: 'recover-item' },
          h('span', { class: 'recover-name' }, name),
          h('span', { class: 'recover-when' }, savedWhen(r)),
          h(
            'button',
            { class: 'btn btn-sm btn-recover', onclick: () => restoreContract(r.id) },
            'Restore'
          )
        );
      })
    )
  );
}

/** The snapshot's own timestamp when the server sends one; silence otherwise. */
function savedWhen(entry) {
  const raw = entry.savedAt || entry.mtime || entry.modified || null;
  if (!raw) return 'copy kept at last save';
  const when = new Date(raw);
  if (Number.isNaN(when.getTime())) return 'copy kept at last save';
  return `saved ${when.toLocaleString()}`;
}

/**
 * The landing view for the contracts area.
 *
 * A list of names in a rail plus an empty pane answered none of the questions
 * an operator actually arrives with -- which contracts exist, what each one
 * allows, whether its policy is its own or the default. The overview states
 * them in one table, and picking a row opens the contract.
 */
function contractsOverview(area) {
  const data = state.contracts || { contracts: [] };
  const rows = data.contracts || [];

  return h(
    'div',
    { class: 'sheetwrap' },
    h(
      'header',
      { class: 'sheet-strip' },
      h(
        'div',
        { class: 'strip-top' },
        h('h2', { class: 'strip-title' }, area.title),
        h('code', { class: 'strip-path' }, `${data.root}/${data.parent}/`),
        h(
          'div',
          { class: 'strip-meta' },
          h(
            'button',
            { class: 'btn btn-primary btn-sm', onclick: openCreateContract },
            'New contract'
          )
        )
      )
    ),
    area.blurb ? h('p', { class: 'sheet-blurb' }, area.blurb) : null,
    h(
      'div',
      { class: 'sheet-body' },
      recoveryBanner(),
      rows.length
        ? h(
            'table',
            { class: 'otable' },
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                h('th', { class: 'otable-name' }, 'Contract'),
                h('th', {}, 'Parameters'),
                h('th', {}, 'Policy'),
                h('th', {}, 'Folder')
              )
            ),
            h(
              'tbody',
              {},
              rows.map((c) =>
                h(
                  'tr',
                  {
                    class: `otable-row${c.isTemplate ? ' otable-template' : ''}`,
                    tabindex: '0',
                    role: 'link',
                    onclick: () => selectContract(c.id),
                    onkeydown: (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        selectContract(c.id);
                      }
                    },
                  },
                  h(
                    'td',
                    { class: 'otable-name' },
                    h('span', { class: 'otable-link' }, c.name),
                    c.isTemplate ? h('span', { class: 'chip chip-note' }, 'template') : null
                  ),
                  h('td', { class: 'otable-num' }, String(c.paramCount)),
                  h(
                    'td',
                    {},
                    c.hasPolicy
                      ? h('span', { class: 'chip chip-ok' }, 'own policy')
                      : h('span', { class: 'chip chip-warn' }, 'default')
                  ),
                  h('td', { class: 'otable-path' }, h('code', {}, c.dir))
                )
              )
            )
          )
        : h('p', { class: 'hint' }, 'No contracts yet. Create one to begin.')
    )
  );
}

function renderContractsArea(area) {
  const contract = state.contract;

  if (!contract) {
    mount(els.workspace, contractsOverview(area));
    return;
  }

  const doc = viewOf(contract.param);
  const tabs = [
    ['params', `Parameters (${doc.params.length})`],
    ['policy', contract.policy ? 'Policy' : 'Policy (default)'],
    ['raw', 'Raw file'],
  ];

  const body =
    state.tab === 'policy'
      ? decoratePolicy(
          renderPolicy(
            state.policyPreview
              ? { ...contract.policy, text: state.policyPreview.text, controls: state.policyPreview.controls }
              : contract.policy,
            policyContext()
          ),
          {
            isOpen: (id, fallback) => (state.open.has(id) ? state.open.get(id) : fallback),
            setOpen: (id, value) => state.open.set(id, value),
          }
        )
      : state.tab === 'raw'
        ? h('pre', { class: 'raw' }, doc.text)
        : renderParamDocument(doc, editContext(doc));

  mount(
    els.workspace,
    h(
      'div',
      { class: 'sheetwrap' },
      sheetStrip(
        contract.name,
        doc,
        tabs,
        contract.isTemplate ? h('span', { class: 'chip chip-note' }, 'template') : null
      ),
      contract.isTemplate
        ? h(
            'p',
            { class: 'banner banner-warn' },
            'This is the template every new contract is copied from. Editing it changes the starting point for future contracts.'
          )
        : null,
      h('div', { class: 'sheet-body' }, body)
    )
  );
}

function render() {
  renderSidebar();
  renderActions();
  renderWorkspace();
  renderContextRail();
  markCurrentSection();
}

/* ------------------------------------------------------------------ loading */

async function loadDocument(path) {
  const doc = await withStatus('Loading\u2026', () => api.deployment(path));
  if (!doc) return;
  state.current = doc;
  state.operations = [];
  state.open = new Map();
  if (state.tab === 'policy') state.tab = 'params';
  if (state.tab === 'env' && !(doc.meta && doc.meta.envVarCount)) state.tab = 'params';
  render();
}

async function selectArea(id) {
  const area = state.areas.find((a) => a.id === id);
  if (!area) return;
  state.area = id;
  state.tab = 'params';
  state.contract = null;
  state.contractId = null;
  state.accessTargets = null;

  if (area.kind === 'contracts') {
    state.current = null;
    render();
    const data = await withStatus('Loading contracts\u2026', () => api.contracts());
    if (!data) return;
    state.contracts = data;
    render();
    return;
  }
  await loadDocument(area.path);
}

async function openOther(path) {
  state.area = 'other';
  state.contract = null;
  state.tab = 'params';
  await loadDocument(path);
}

async function init() {
  els.shell = document.querySelector('.shell');
  els.sidebar = document.getElementById('sidebar');
  els.contextRail = document.getElementById('context-rail');
  els.tbActions = document.getElementById('tb-actions');
  els.workspace = document.getElementById('workspace');
  els.status = document.getElementById('status');
  els.modal = document.getElementById('modal');

  // Position feedback has to survive scrolling, so the rail marker is refreshed
  // from the sheet's own scroll rather than from renders.
  let ticking = false;
  els.workspace.addEventListener(
    'scroll',
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        markCurrentSection();
      });
    },
    { passive: true }
  );

  try {
    const health = await api.health();
    document.getElementById('repo-path').textContent = health.repoRoot;

    const [focus, catalog] = await Promise.all([api.focus(), api.deployments()]);
    state.areas = focus.areas;
    state.catalog = catalog;

    render();
    await selectArea(state.areas[0].id);

  } catch (err) {
    setStatus(err.message, 'error');
  }
}

init();
