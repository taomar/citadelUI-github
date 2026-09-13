/**
 * Guided editor for `llmBackendConfig`.
 *
 * The parameter is an untyped Bicep array, so the generic value renderer can
 * only offer nested brackets. That is a poor trade for the file people edit
 * most: onboarding a model is the routine task, and getting it wrong is only
 * discovered at deploy time. This view replaces the brackets with the provider
 * vocabulary from llmschema.mjs -- known providers, their auth defaults, their
 * endpoint shapes and their model catalogues -- and predicts the backend pools
 * the deployment will create.
 *
 * It writes through the same operation pipeline as every other control, so the
 * file's comments survive untouched.
 */

import { h } from './dom.mjs';
import { explains } from './explain.mjs';
import { picker } from './picker.mjs';
import { editorField, preserveEditorFocus } from './editor-focus.mjs';
import {
  BACKEND_TYPES,
  AUTH_TYPES,
  MODEL_FIELDS,
  MODEL_FIELD_GROUPS,
  BACKEND_FIELD_GROUPS,
  backendType,
  authTypeInfo,
  effectiveAuthType,
  catalogFor,
  catalogEntry,
  backendTemplate,
  modelTemplate,
  validateBackends,
  predictPools,
} from './llmschema.mjs';

const ROOT = 'llmBackendConfig';
const DEFAULT_BINDING = Object.freeze({ root: ROOT, id: 'backendId', type: 'backendType', models: 'supportedModels' });

const modelFocus = (path, readOnly) => `${readOnly ? 'inspect' : 'llm:model'}:${JSON.stringify(path)}`;
const backendFocus = (path, readOnly) => `${readOnly ? 'inspect' : 'llm:backend'}:${JSON.stringify(path)}`;
const focusOwners = new WeakMap();

function withActionFocus(scope, key, action, fallbackKey) {
  const { view, ctx } = scope;
  const doc = view.ownerDocument || document;
  const active = doc.activeElement;
  const owner = focusOwners.get(view);
  const root = ctx.modelFocus?.root || view.parentElement;
  const dialog = view.closest('dialog');
  const modalDialogs = new Set([...doc.body.querySelectorAll('dialog')].filter((node) => node.matches(':modal')));
  const currentView = () => {
    if (!root?.isConnected || (ctx.modelFocus && !ctx.modelFocus.isCurrent())) return null;
    const candidates = [root, ...root.querySelectorAll('.llm')].filter((node) =>
      node.isConnected && (node.ownerDocument || document) === doc &&
      focusOwners.get(node) === owner && node.closest('dialog') === dialog);
    if (candidates.length !== 1) return null;
    const candidate = candidates[0];
    if ([...doc.body.querySelectorAll('dialog')].some((node) =>
      node.matches(':modal') && !modalDialogs.has(node) && !node.contains(candidate))) return null;
    return candidate;
  };
  if (!view.isConnected || !root?.contains(view) || currentView() !== view) return action();
  const focusRoot = {
    contains: (node) => view.contains(node),
    querySelectorAll: (selector) => currentView()?.querySelectorAll(selector) || [],
  };
  const focus = (address) => {
    if (!address || doc.activeElement !== doc.body) return;
    const next = [...focusRoot.querySelectorAll('[data-editor-focus]')].find((node) =>
      node.dataset.editorFocus === address && !node.disabled && !node.closest('[inert]') && node.getClientRects().length);
    next?.focus({ preventScroll: true });
  };
  const previous = active?.dataset.editorFocus;
  const retarget = key && view.contains(active);
  if (retarget) active.dataset.editorFocus = key;
  try {
    const result = preserveEditorFocus(focusRoot, () => {
      const accepted = action();
      if (accepted === false) focus(fallbackKey || previous);
      return accepted;
    });
    // A portal can close before onPick; resolve its destination in the same owner.
    if (active === doc.body || (view.contains(active) && !active.isConnected)) {
      if (result !== false) focus(key);
      focus(fallbackKey || previous);
    }
    const focused = doc.activeElement;
    if (focused !== active && currentView()?.contains(focused) &&
      [key, fallbackKey].filter(Boolean).includes(focused?.dataset.editorFocus)) {
      focused.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    }
    return result;
  } finally {
    if (active?.isConnected && retarget) {
      if (previous === undefined) delete active.dataset.editorFocus;
      else active.dataset.editorFocus = previous;
    }
  }
}

function contextualFields(node, target) {
  for (const control of node.querySelectorAll('input, select, textarea, button')) {
    const name = control.getAttribute('aria-label') || control.closest('label')?.textContent.trim() || control.textContent;
    if (name) control.setAttribute('aria-label', `${name}: ${target}`);
  }
  return node;
}

function advancedSettings(ctx, key, label, ...children) {
  const details = h('details', { class: 'technical-details', open: ctx.isOpen(key, false) },
    h('summary', { dataset: { editorFocus: `llm:advanced:${key}` } }, label), ...children);
  details.addEventListener('toggle', () => { if (details.isConnected) ctx.setOpen(key, details.open); });
  return details;
}

function additionalInputs(value, knownKeys) {
  const keys = Object.keys(value).filter((key) => !knownKeys.has(key));
  return keys.length ? h('div', { class: 'lb-sub' },
    h('h4', { class: 'lb-sub-title' }, 'Additional source fields'),
    h('p', { class: 'hint' }, 'These fields are preserved but have no guided editor. Inspect their exact values in Raw file; use a source editor to change them.'),
    h('div', { class: 'model-chips' }, keys.map((key) => h('code', { class: 'model-chip' }, key)))) : null;
}

/* ------------------------------------------------------------------ writing */

/**
 * Set one property of an object that may not carry it yet.
 *
 * `set` addresses an existing node's text span, so it cannot create a property
 * that is absent from the file. Optional fields therefore have to route to
 * `addProperty` the first time they are given a value.
 */
function writeField(ctx, objectPath, object, key, value) {
  const present = object && Object.prototype.hasOwnProperty.call(object, key);
  if (present) ctx.onChange([...objectPath, key], value);
  else ctx.onAddProperty(objectPath, key, value);
}

/** Commit on change/blur rather than per keystroke, so one edit is one operation. */
function textField(value, onCommit, props = {}) {
  const { multiline = false, path, ...attributes } = props;
  const el = h(multiline ? 'textarea' : 'input', {
    class: multiline ? 'ctl lm-model-id' : 'ctl',
    ...(multiline ? { rows: 2 } : { type: 'text' }),
    value: value ?? '',
    spellcheck: false,
    ...attributes,
  });
  el.addEventListener('change', () => onCommit(el.value));
  return path ? editorField(el, path) : el;
}

function numberField(value, onCommit, props = {}) {
  const { path, ...attributes } = props;
  const el = h('input', { class: 'ctl ctl-num', type: 'number', value: value ?? '', ...attributes });
  el.addEventListener('change', () => {
    if (el.value === '') return;
    onCommit(Number(el.value));
  });
  return path ? editorField(el, path) : el;
}

function selectField(value, options, onCommit, props = {}) {
  const { path, ...attributes } = props;
  const el = h(
    'select',
    { class: 'ctl', ...attributes },
    options.map((o) => {
      const opt = typeof o === 'string' ? { value: o, label: o } : o;
      return h('option', { value: opt.value, selected: opt.value === value }, opt.label);
    })
  );
  el.addEventListener('change', () => onCommit(el.value));
  return path ? editorField(el, path) : el;
}

function checkField(value, onCommit, label, help) {
  const box = h('input', { class: 'ctl-check', type: 'checkbox', checked: value === true });
  box.addEventListener('change', () => onCommit(box.checked));
  const text = h('span', {}, label);
  return h(
    'label',
    { class: 'check' },
    box,
    help
      ? explains(text, () => [
          h('div', { class: 'explain-title' }, label),
          h('p', { class: 'doc-para' }, help),
        ])
      : text
  );
}

/* ------------------------------------------------------------------ pieces */

function field(label, control, help, footer, wide) {
  const el = h('label', { class: 'lf-label' }, label);
  const controls = control.matches && control.matches('input, select, textarea')
    ? [control]
    : [...control.querySelectorAll('input, select, textarea')];
  for (const item of controls) {
    if (!item.getAttribute('aria-label') && !item.getAttribute('aria-labelledby')) {
      item.setAttribute('aria-label', label);
    }
  }
  return h(
    'div',
    { class: wide ? 'lf lf-wide' : 'lf' },
    help ? explains(el, () => [h('div', { class: 'explain-title' }, label), h('p', { class: 'doc-para' }, help)]) : el,
    h('div', { class: 'lf-ctl' }, control),
    footer || null
  );
}

export function modelCatalogMatch(name, backendTypeId) {
  const type = backendType(backendTypeId);
  if (!type || !type.usesDeploymentName) return null;
  const match = catalogEntry(name, backendTypeId);
  return match ? { kind: 'catalog', name: match.name } : { kind: 'custom' };
}

function modelField(descriptor, model, entry, type, write, readOnly = false) {
  const value = model[descriptor.key];
  const help =
    descriptor.key === 'name' && type && type.nameMeaning
      ? `${type.nameMeaning} ${descriptor.help}`
      : descriptor.help;

  if (descriptor.type === 'boolean') {
    return h(
      'div',
      { class: 'lf' },
      checkField(value, (next) => write(descriptor.key, next), descriptor.label, help)
    );
  }
  if (descriptor.type === 'number') {
    return field(
      descriptor.label,
      numberField(readOnly ? value : value ?? descriptor.default, (next) => write(descriptor.key, next), {
        min: descriptor.min,
        max: descriptor.max,
      }),
      help
    );
  }
  if (descriptor.type === 'enum') {
    const options = [...new Set([...(descriptor.options || []), value].filter(Boolean))];
    return field(
      descriptor.label,
      selectField(readOnly ? value : value || descriptor.default, options, (next) => write(descriptor.key, next)),
      help
    );
  }

  const match = descriptor.key === 'name'
    ? modelCatalogMatch(value, entry.backendType)
    : null;
  return field(
    descriptor.label,
    textField(value, (next) => write(descriptor.key, next), {
      placeholder: readOnly ? '' : descriptor.default || '',
      required: descriptor.required,
      multiline: descriptor.key === 'name',
    }),
    help,
    match && match.kind === 'catalog'
      ? h(
          'p',
          { class: 'lf-match' },
          'Matches the Foundry catalogue name ',
          h('code', {}, match.name),
          readOnly ? '.' : '. Change it if your deployment uses a different name.'
        )
      : match
        ? h(
            'p',
            { class: 'lf-match lf-match-custom' },
            'Not a Foundry catalogue name, so this is treated as a custom deployment name.'
          )
        : null
  );
}

/** One row of the model table. */
function modelRow(model, index, entry, entryIndex, ctx, expanded, toggle, focusScope) {
  const binding = ctx.llmBinding || DEFAULT_BINDING;
  const path = [binding.root, entryIndex, binding.models, index];
  const type = ctx.native ? null : backendType(entry[binding.type]);
  const needsPath = Boolean(type && type.requiresModelPath);
  const missingPath = needsPath && !model.modelPath;
  const write = (key, value) => writeField(ctx, path, model, key, value);
  const detailId = `lm-editor-${entryIndex}-${index}`;
  const modelName = model.name || 'unnamed model';
  const backendName = entry[binding.id] || `backend ${entryIndex + 1}`;
  const target = `model ${modelName} on backend ${backendName}`;
  const removeLabel = `Remove model ${modelName} from backend ${backendName}`;
  const modelCount = entry[binding.models]?.length || 0;
  const removeFocus = modelCount > 1
    ? modelFocus([...path.slice(0, -1), Math.min(index, modelCount - 2)], ctx.readOnly)
    : `llm:add-model:${JSON.stringify(path.slice(0, -1))}`;
  const remove = () => withActionFocus(focusScope, removeFocus, () => ctx.onRemove(path), modelFocus(path, ctx.readOnly));
  const inspectLabel = ctx.readOnly ? 'Inspect model details' : 'Edit model details';
  const focusAddress = { editorFocus: modelFocus(path, ctx.readOnly) };
  const nativeValue = (key, alias) => Object.hasOwn(model, alias) ? model[alias] : model[key];

  if (!expanded) {
    return h(
      'div',
      { class: `lm-row${missingPath ? ' lm-row-bad' : ''}`, role: 'row' },
      h(
        'span',
        { class: 'lm-model-cell', role: 'cell' },
        h(
          'button',
          {
            class: 'lm-name',
            onclick: toggle,
            title: inspectLabel,
            'aria-label': ctx.readOnly ? `${inspectLabel}: ${modelName}` : `${inspectLabel}: ${modelName} on backend ${backendName}`,
            dataset: focusAddress,
            'aria-expanded': 'false',
            'aria-controls': detailId,
          },
          h('span', { class: 'lm-caret' }, '\u203a'),
          model.name || h('em', {}, 'unnamed')
        )
      ),
      h('span', { class: 'lm-cell', role: 'cell', dataset: { label: 'Format' } }, ctx.native ? ctx.nativeDisplay(nativeValue('modelFormat', 'model_format')) : model.modelFormat || (ctx.readOnly ? 'Not supplied' : 'OpenAI')),
      h('span', { class: 'lm-cell', role: 'cell', dataset: { label: 'Version' } }, ctx.native ? ctx.nativeDisplay(nativeValue('modelVersion', 'model_version')) : model.modelVersion || (ctx.readOnly ? 'Not supplied' : '1')),
      h('span', { class: 'lm-cell', role: 'cell', dataset: { label: 'SKU' } }, ctx.native ? ctx.nativeDisplay(model.sku) : model.sku || (ctx.readOnly ? 'Not supplied' : 'Standard')),
      h('span', { class: 'lm-cell lm-num', role: 'cell', dataset: { label: 'Capacity' } }, ctx.native ? ctx.nativeDisplay(model.capacity) : model.capacity ?? (ctx.readOnly ? 'Not supplied' : 100)),
      h(
        'span',
        { class: 'lm-flags', role: 'cell', dataset: { label: 'State' } },
        (ctx.native ? nativeValue('sessionAwareModel', 'session_aware_model') : model.sessionAwareModel) === true ? h('span', { class: 'chip chip-note' }, 'stateful') : null,
        ctx.modelStatus?.(path),
        missingPath ? h('span', { class: 'chip chip-bad' }, 'needs path') : null
      ),
      h(
        'span',
        { class: 'lm-actions', role: 'cell' },
        ctx.readOnly ? null : h(
          'button',
          {
            class: 'lm-x',
            title: removeLabel,
            'aria-label': removeLabel,
            onclick: remove,
          },
          '\u2715'
        )
      )
    );
  }

  const shown = (ctx.nativeModelFields || MODEL_FIELDS).filter(
    (f) => !f.appliesTo || f.appliesTo.includes(entry[binding.type])
  );
  const fields = new Map(shown.map((descriptor) => [descriptor.key, descriptor]));
  const groups = MODEL_FIELD_GROUPS.map((group) => ({ ...group, keys: [...group.keys] }));
  const grouped = new Set(groups.flatMap((group) => group.keys));
  const remaining = shown.filter((field) => !grouped.has(field.key)).map((field) => field.key);
  if (remaining.length) groups.push({ id: 'native', label: 'Additional native inputs', keys: remaining });
  const section = (group) => {
    const sectionFields = group.keys
      .map((key) => fields.get(key))
      .filter(Boolean)
      .map((descriptor) => {
        const rendered = ctx.renderModelField ? ctx.renderModelField(descriptor, model[descriptor.key], [...path, descriptor.key])
          : ctx.readOnly && !Object.hasOwn(model, descriptor.key)
          ? field(descriptor.label, h('span', { class: 'hint' }, 'Not supplied in target'))
          : modelField(descriptor, model, entry, type, write, ctx.readOnly);
        editorField(rendered, [...path, descriptor.key]);
        const decorated = ctx.decorateValue ? ctx.decorateValue([...path, descriptor.key], rendered) : rendered;
        return contextualFields(decorated, target);
      });
    if (!sectionFields.length) return null;
    return h(
      'fieldset',
      { class: `lm-section${group.id === 'identity' ? ' lm-section-identity' : ''}`, dataset: { group: group.id } },
      h('legend', { class: 'lm-legend' }, group.label),
      h('div', { class: 'lm-fields' }, sectionFields)
    );
  };

  return h(
    'div',
    { class: `lm-group${missingPath ? ' lm-row-bad' : ''}`, role: 'row' },
    h(
      'div',
      { class: 'lm-editor', id: detailId, role: 'cell', 'aria-colspan': '7' },
      h('div', { class: 'lm-identity-row' },
        h('button', {
          class: 'lm-editor-toggle', onclick: toggle,
          title: `Close details for ${target}`, 'aria-label': `Close details for ${target}`,
          'aria-expanded': 'true', 'aria-controls': detailId, dataset: focusAddress,
        }, h('span', { class: 'lm-caret open' }, '\u203a'), h('span', {}, 'Close model details')),
        h('h4', { class: 'lm-legend' }, modelName)),
      section(groups[0]),
      h('div', { class: 'lb-sub' },
        section(groups[1]),
        advancedSettings(ctx, `llm-${entryIndex}-m-${index}-advanced`,
          `Advanced settings for ${modelName}: request, lifecycle and additional fields`,
          h('div', { class: 'lb-sub' }, groups.slice(2).map(section),
            additionalInputs(model, new Set(shown.map((descriptor) => descriptor.key)))))
      ),
      ctx.readOnly ? null : h(
        'div',
        { class: 'lm-editor-foot' },
        h(
          'button',
          {
            class: 'btn btn-sm btn-danger-ghost',
            title: removeLabel,
            'aria-label': removeLabel,
            onclick: remove,
          },
          'Remove model'
        )
      )
    )
  );
}

/**
 * Model picker.
 *
 * A native datalist is unusable at this size: sixty entries in an unstyled
 * dropdown, matched only on prefix, with no way to see what kind of model each
 * one is. This is a real filterable list -- typing narrows it, the results stay
 * grouped by what the model does, already-added models are shown as such, and
 * anything typed can still be added verbatim, because provider catalogues move
 * faster than this file does.
 */
function addModelRow(entry, entryIndex, ctx, focusScope) {
  const binding = ctx.llmBinding || DEFAULT_BINDING;
  const catalog = ctx.native ? [] : catalogFor(entry[binding.type]);
  const type = ctx.native ? null : backendType(entry[binding.type]);
  const existing = new Set((entry[binding.models] || []).map((m) => m && m.name));
  const modelsPath = [binding.root, entryIndex, binding.models];
  const backendName = entry[binding.id] || `backend ${entryIndex + 1}`;

  const add = (name) => {
    const id = name.trim();
    if (!id || existing.has(id)) return;
    withActionFocus(focusScope, modelFocus([...modelsPath, entry[binding.models]?.length || 0], ctx.readOnly),
      () => ctx.onAppend(modelsPath, ctx.newModel ? ctx.newModel(id) : modelTemplate(id, entry[binding.type])),
      `llm:add-model:${JSON.stringify(modelsPath)}`);
  };

  // The gateway routes chat, embeddings and image only, so the catalogue holds
  // nothing else. Any other kind still gets a group rather than being dropped
  // silently -- a model missing from the picker is indistinguishable from a
  // model the provider does not offer.
  const KIND_LABELS = { chat: 'Chat', embeddings: 'Embeddings', image: 'Image' };
  const KINDS = [
    ...Object.keys(KIND_LABELS),
    ...[...new Set(catalog.map((m) => m.kind))].filter((k) => !KIND_LABELS[k]),
  ].map((k) => [k, KIND_LABELS[k] || k]);
  const modelPicker = picker(
    catalog.map((model) => ({
      value: model.name,
      meta: model.modelFormat,
      group: model.kind,
      disabled: existing.has(model.name),
      usedLabel: existing.has(model.name) ? 'added' : null,
    })),
    add,
    {
      placeholder: catalog.length ? `Search ${catalog.length} models\u2026` : 'Deployment name\u2026',
      ariaLabel: 'Search the model catalogue, or type your own deployment name',
      freeTextLabel: 'add as typed',
      empty: 'No match. Type a full model id to add it anyway.',
      groups: KINDS,
    }
  );
  modelPicker.el.querySelector('input').dataset.editorFocus = `llm:add-model:${JSON.stringify(modelsPath)}`;
  modelPicker.el.querySelector('input').setAttribute('aria-description', `Adds a model to backend ${backendName}.`);

  return h(
    'div',
    { class: 'lm-add' },
    modelPicker.el,
    modelPicker.action('Add model', { class: 'btn btn-sm', 'aria-label': `Add model to backend ${backendName}` }),
    type && type.nameMeaning
      ? h(
          'p',
          { class: 'lm-add-note' },
          type.nameMeaning,
          catalog.length
            ? h(
                'span',
                { class: 'lm-add-hint' },
                ` The list shows ${catalog.length} catalogue names from Foundry; edit the name after adding if your deployment differs.`
              )
            : null
        )
      : null
  );
}

/* ---------------------------------------------------------------- backends */

function backendCard(entry, index, ctx, findings, backendCount, focusScope) {
  const binding = ctx.llmBinding || DEFAULT_BINDING;
  const path = [binding.root, index];
  const backendName = entry[binding.id] || `backend ${index + 1}`;
  const type = ctx.native ? null : backendType(entry[binding.type]);
  const auth = ctx.native ? entry.auth_type || entry.auth_scheme || 'Not supplied' : effectiveAuthType(entry);
  const authInfo = authTypeInfo(auth);
  const explicitAuth = Boolean(entry.authType);
  const models = Array.isArray(entry[binding.models]) ? entry[binding.models] : [];
  const mine = findings.filter((f) => f.index === index);
  const errors = mine.filter((f) => f.level === 'error');

  const open = ctx.isOpen(`llm-${index}`, index === 0);
  const write = (key, value) => writeField(ctx, path, entry, key, value);
  const mappedField = (keys, ...args) => {
    const rendered = field(...args);
    return ctx.decorateBackendValue ? ctx.decorateBackendValue([...path, ...keys], rendered) : rendered;
  };
  const inspectOptions = (options, value) => value &&
    !options.some((option) => (typeof option === 'string' ? option : option.value) === value)
    ? [...options, { value, label: value }] : options;

  const head = h(
    'summary',
    { class: 'lb-head', dataset: { editorFocus: backendFocus(path, ctx.readOnly) }, 'aria-label': `Backend ${backendName}` },
    h('span', { class: 'lb-caret' }, '\u203a'),
    h('span', { class: 'lb-id' }, entry[binding.id] || h('em', {}, 'unnamed backend')),
    h('span', { class: 'chip chip-provider' }, type ? type.label : entry[binding.type] || '\u2014'),
    h('span', { class: 'chip chip-muted' }, authInfo ? authInfo.label : auth),
    h('span', { class: 'chip chip-count' }, `${models.length} model${models.length === 1 ? '' : 's'}`),
    h('span', { class: 'lb-spacer' }),
    entry.priority != null || entry.weight != null
      ? h('span', { class: 'lb-routing' }, ctx.native ? `p${ctx.nativeDisplay(entry.priority)} / w${ctx.nativeDisplay(entry.weight)}` : `p${entry.priority ?? 1} \u00b7 w${entry.weight ?? 100}`)
      : null,
    errors.length ? h('span', { class: 'chip chip-bad' }, `${errors.length}`) : null,
    ctx.backendStatus?.(path)
  );

  const authFields =
    (authInfo && authInfo.needsAuthConfig) || entry.authConfig
      ? h(
          'div',
          { class: 'lb-sub' },
          h('h4', { class: 'lb-sub-title' }, 'Credential'),
          h(
            'div',
            { class: 'lf-grid' },
            mappedField(['authConfig', 'namedValueKey'],
              'Named value key',
              textField(
                entry.authConfig && entry.authConfig.namedValueKey,
                (v) => {
                  if (entry.authConfig) writeField(ctx, [...path, 'authConfig'], entry.authConfig, 'namedValueKey', v);
                  else ctx.onAddProperty(path, 'authConfig', { namedValueKey: v });
                },
                { placeholder: 'my-provider-key', path: [...path, 'authConfig', 'namedValueKey'] }
              ),
              'APIM named value that holds the key. It is created for you at deploy time.'
            ),
            mappedField(['authConfig', 'keyVaultSecretUri'],
              'Key Vault secret URI',
              textField(
                entry.authConfig && entry.authConfig.keyVaultSecretUri,
                (v) => {
                  if (entry.authConfig) writeField(ctx, [...path, 'authConfig'], entry.authConfig, 'keyVaultSecretUri', v);
                  else ctx.onAddProperty(path, 'authConfig', { namedValueKey: '', keyVaultSecretUri: v });
                },
                { placeholder: 'https://kv.vault.azure.net/secrets/\u2026', path: [...path, 'authConfig', 'keyVaultSecretUri'] }
              ),
              'Preferred. Rotatable and audited, and the secret never enters this file.'
            )
          ),
          entry.authConfig && entry.authConfig.secretValue
            ? h(
                'p',
                { class: 'banner banner-warn' },
                'This backend carries a plain-text secretValue. That is intended for short-lived testing only \u2014 move it to Key Vault before committing.'
              )
            : null
        )
      : null;

  const backendFields = ctx.nativeBackendFields ? ctx.nativeBackendFields(entry, path) : h(
      'div',
      { class: 'lf-grid' },
      mappedField(['backendId'],
        'Backend ID',
        textField(entry.backendId, (v) => write('backendId', v), { placeholder: 'aif-primary', path: [...path, 'backendId'] }),
        'Unique across the deployment.'
      ),
      mappedField(['backendType'],
        'Provider',
        selectField(
          entry.backendType,
          inspectOptions(BACKEND_TYPES.filter((b) => !ctx.backendTypes || ctx.backendTypes.includes(b.id) || b.id === entry.backendType)
            .map((b) => ({ value: b.id, label: b.label })), entry.backendType),
          (v) => write('backendType', v),
          { path: [...path, 'backendType'] }
        ),
        type ? `Endpoint looks like ${type.endpointFormat}` : null
      ),
      mappedField(['endpoint'],
        'Endpoint',
        textField(entry.endpoint, (v) => write('endpoint', v), {
          placeholder: type ? type.endpointExample : 'https://\u2026',
          path: [...path, 'endpoint'],
        }),
        null,
        null,
        true
      ),
      mappedField(['authType'],
        'Authentication',
        selectField(
          entry.authType || '',
          inspectOptions([
            {
              value: '',
              label: `Provider default \u2014 ${authInfo ? authInfo.label : auth}`,
            },
            ...(ctx.authTypes || (type ? type.authTypes : AUTH_TYPES.map((a) => a.id))).map((id) => {
              const info = authTypeInfo(id);
              return { value: id, label: info ? info.label : id };
            }),
          ], entry.authType),
          (v) => {
            if (v === '' && explicitAuth) ctx.onRemove([...path, 'authType']);
            else if (v !== '') write('authType', v);
          },
          { path: [...path, 'authType'] }
        ),
        authInfo ? authInfo.summary : null
      ),
      mappedField(['priority'],
        'Priority',
        numberField(entry.priority ?? 1, (v) => write('priority', v), { min: 1, max: 5, path: [...path, 'priority'] }),
        'Lower wins. Ties share traffic by weight.'
      ),
      mappedField(['weight'],
        'Weight',
        numberField(entry.weight ?? 100, (v) => write('weight', v), { min: 1, max: 1000, path: [...path, 'weight'] }),
        'Share within a priority tier.'
      )
    );
  const normalize = (name) => String(name).replace(/[^a-z0-9]/gi, '').toLowerCase();
  const ungrouped = new Set(backendFields.children);
  const sections = BACKEND_FIELD_GROUPS.map((group) => {
    const names = new Set(group.keys.map(normalize));
    const children = [...ungrouped].filter((node) => {
      const control = node.querySelector('[data-editor-focus]');
      const address = control?.dataset.editorFocus;
      const key = address ? JSON.parse(address)?.[0]?.[path.length] : null;
      return names.has(normalize(key || node.querySelector('.lf-label')?.textContent));
    });
    for (const child of children) ungrouped.delete(child);
    return children.length ? h('section', { class: 'lb-sub', 'aria-label': `${group.label}: backend ${backendName}` },
      h('h4', { class: 'lb-sub-title' }, group.label),
      contextualFields(h('div', { class: 'lf-grid' }, children), `backend ${backendName}`),
      group.id === 'connection' && !ctx.native && authFields
        ? authInfo?.needsAuthConfig || ctx.readOnly
          ? contextualFields(authFields, `backend ${backendName}`)
          : advancedSettings(ctx, `llm-${index}-retained-auth`, `Retained credential configuration for backend ${backendName}`,
            h('p', { class: 'hint' }, 'These saved credential fields are not required by the selected authentication. Opening this section does not change them.'),
            contextualFields(authFields, `backend ${backendName}`))
        : null,
      group.id === 'connection' && !ctx.native && authInfo?.note ? h('p', { class: 'lb-note' }, authInfo.note) : null) : null;
  });
  const extras = additionalInputs(entry, new Set(['backendId', 'backendType', 'endpoint', 'authType', 'authConfig', 'priority', 'weight', binding.models]));
  const body = h(
    'div',
    { class: 'lb-body' },
    type ? h('p', { class: 'lb-summary' }, type.summary) : null,
    mine.length
      ? h('ul', { class: 'lb-findings' }, mine.map((f) =>
        h('li', { class: `finding finding-${f.level}` }, h('span', { class: 'finding-dot' }), f.message)))
      : null,
    sections,
    type && type.notes ? type.notes.map((n) => h('p', { class: 'lb-note' }, n)) : null,
    ungrouped.size || (!ctx.native && extras) ? advancedSettings(ctx, `llm-${index}-backend-advanced`,
      `Additional inputs for backend ${backendName}`,
      contextualFields(h('div', { class: 'lf-grid' }, [...ungrouped]), `backend ${backendName}`),
      ctx.native ? null : extras) : null,
    h(
      'div',
      { class: 'lb-sub lb-models' },
      h(
        'div',
        { class: 'lb-sub-head' },
        h('h4', { class: 'lb-sub-title' }, `Models (${models.length})`),
        h(
          'span',
          { class: 'lb-sub-note' },
          models.length
          ? `Expand a model to ${ctx.readOnly ? 'inspect' : 'edit'} its deployment, serving, request, and lifecycle settings.`
            : ctx.native ? 'No models supplied in this operator file.' : 'Nothing routes here until a model is added.'
        )
      ),
      models.length
        ? h(
            'div',
            { class: 'lm-table', role: 'table', 'aria-label': `Supported models for backend ${backendName}` },
            h(
              'div',
              { class: 'lm-rowgroup', role: 'rowgroup' },
              h(
                'div',
                { class: 'lm-row lm-head', role: 'row' },
                h('span', { role: 'columnheader' }, 'Model'),
                h('span', { role: 'columnheader' }, 'Format'),
                h('span', { role: 'columnheader' }, 'Version'),
                h('span', { role: 'columnheader' }, 'SKU'),
                h('span', { class: 'lm-num', role: 'columnheader' }, 'Capacity'),
                h('span', { role: 'columnheader' }, 'State'),
                h('span', { role: 'columnheader', 'aria-label': 'Actions' }, '')
              )
            ),
            h(
              'div',
              { class: 'lm-rowgroup', role: 'rowgroup' },
              models.map((m, mi) => {
                const key = `llm-${index}-m-${mi}`;
                const expanded = ctx.isOpen(key, false);
                return modelRow(m, mi, entry, index, ctx, expanded, () => {
                  withActionFocus(focusScope, null, () => {
                    ctx.setOpen(key, !expanded);
                    ctx.rerender();
                  });
                }, focusScope);
              })
            )
          )
        : h(
            'p',
            { class: 'empty-state' },
            'No models yet. Nothing routes to this backend until you add one.'
          ),
      ctx.readOnly ? null : addModelRow(entry, index, ctx, focusScope)
    ),
    // Destructive action lives at the foot of the panel it destroys, never in
    // the header where it sits under the cursor on the way to everything else.
    ctx.readOnly ? null : h(
      'div',
      { class: 'lb-foot' },
      h(
        'span',
        { class: 'lb-foot-note' },
        'Removing this backend also removes its ',
        `${models.length} model${models.length === 1 ? '' : 's'}`,
        ctx.native ? ' from this native input file.' : ' from the gateway.'
      ),
      h(
        'button',
        {
          class: 'btn btn-sm btn-danger-ghost',
          onclick: () => withActionFocus(focusScope, backendCount > 1
            ? backendFocus([binding.root, Math.min(index, backendCount - 2)], ctx.readOnly)
            : `llm:add-backend:${binding.root}`, () => ctx.onRemove(path), backendFocus(path, ctx.readOnly)),
          title: `Remove backend ${backendName}`,
          'aria-label': `Remove backend ${backendName} and its ${models.length} model${models.length === 1 ? '' : 's'}`,
        },
        'Remove backend'
      )
    )
  );

  const el = h('details', { class: 'lb', open }, head, body);
  el.addEventListener('toggle', () => { if (el.isConnected) ctx.setOpen(`llm-${index}`, el.open); });
  return ctx.decorateBackend ? ctx.decorateBackend(path, el) : el;
}

/* ----------------------------------------------------------- provider picker */

function addBackendPanel(ctx, entries, close, focusScope) {
  const groups = [];
  for (const type of BACKEND_TYPES) {
    let group = groups.find((g) => g.name === type.group);
    if (!group) groups.push((group = { name: type.group, types: [] }));
    group.types.push(type);
  }

  return h(
    'div',
    { class: 'picker' },
    h('p', { class: 'picker-lead' }, 'Choose a provider. The endpoint shape, default credential and model list all follow from it.'),
    groups.map((g) =>
      h(
        'div',
        { class: 'picker-group' },
        h('h5', { class: 'picker-group-title' }, g.name),
        g.types.map((t) =>
          h(
            'button',
            {
              class: 'picker-item',
              onclick: () => {
                const template = backendTemplate(t.id);
                // Keep generated ids unique without asking the user to think about it.
                const used = new Set(entries.map((e) => e && e.backendId));
                let n = 1;
                while (used.has(template.backendId)) {
                  n += 1;
                  template.backendId = `${t.id}-${n}`;
                }
                // Close first: onAppend re-renders synchronously, so closing
                // afterwards would leave the picker on screen until some later
                // unrelated render happened to clear it.
                withActionFocus(focusScope, backendFocus([ROOT, entries.length], false), () => {
                  close();
                  ctx.setOpen(`llm-${entries.length}`, true);
                  return ctx.onAppend([ROOT], template);
                }, `llm:add-backend:${ROOT}`);
              },
            },
            h('span', { class: 'picker-name' }, t.label),
            h('span', { class: 'picker-desc' }, t.summary),
            h(
              'span',
              { class: 'picker-tags' },
              t.capabilities.map((c) => h('span', { class: 'chip chip-muted' }, c))
            )
          )
        )
      )
    )
  );
}

/* ------------------------------------------------------------ pool preview */

function poolPreview(entries) {
  const pools = predictPools(entries);
  if (!pools.length) return null;

  const pooled = pools.filter((p) => p.pooled);
  const count = entries.length;

  return h(
    'section',
    { class: 'lb-panel lb-panel-routing' },
    h(
      'header',
      { class: 'lb-panel-head' },
      h('h4', {}, 'Routing preview'),
      h(
        'span',
        { class: 'lb-panel-sub' },
        `${pools.length} model route${pools.length === 1 ? '' : 's'}, ${pooled.length} load-balanced`
      )
    ),
    h(
      'p',
      { class: 'lb-panel-lead' },
      // The table is derived from every backend at once, not from whichever
      // one happens to sit above it. Saying so removes the commonest
      // misreading of this screen.
      `Every model across all ${count} backend${count === 1 ? '' : 's'}. A backend pool is created for each model served by two or more backends of the same provider; single-backend models route directly.`
    ),
    h(
      'div',
      { class: 'lp-table' },
      h(
        'div',
        { class: 'lp-row lp-head' },
        h('span', {}, 'Model'),
        h('span', {}, 'Provider'),
        h('span', {}, 'Serving backends'),
        h('span', {}, 'Routing')
      ),
      pools.map((p) =>
        h(
          'div',
          { class: 'lp-row' },
          h('span', { class: 'lp-model' }, p.model),
          h('span', { class: 'lp-cell' }, p.backendType),
          h(
            'span',
            { class: 'lp-cell' },
            p.backends
              .map((b) => `${b.backendId} (p${b.priority}\u00b7w${b.weight})`)
              .join(', ')
          ),
          h(
            'span',
            { class: 'lp-cell' },
            p.pooled
              ? h(
                  'span',
                  {},
                  h('span', { class: 'chip chip-ok' }, 'pool'),
                  p.sessionAffinity ? h('span', { class: 'chip chip-note' }, 'sticky') : null
                )
              : h('span', { class: 'chip chip-muted' }, 'direct')
          )
        )
      )
    )
  );
}

/* ------------------------------------------------------------------ export */

/**
 * Reuse one context per mounted viewer. A caller that rebuilds its context or
 * mount may instead retain one modelFocus object per viewer/document:
 * { root: stableContainer, isCurrent: () => capturedOwnerStillCurrent }.
 * Its identity and guard must not be reused for another document or viewer.
 */
export function renderLlmBackends(entries, ctx) {
  if (ctx.modelFocus && (typeof ctx.modelFocus.root?.contains !== 'function' ||
    typeof ctx.modelFocus.isCurrent !== 'function')) {
    throw new TypeError('modelFocus requires a stable root and an isCurrent ownership guard.');
  }
  const owner = ctx.modelFocus || ctx;
  const focusScope = { view: null, ctx };
  const binding = ctx.llmBinding || DEFAULT_BINDING;
  const list = Array.isArray(entries) ? entries : [];
  const findings = ctx.native ? [] : validateBackends(list);
  const errors = findings.filter((f) => f.level === 'error').length;
  const warns = findings.filter((f) => f.level === 'warn').length;
  const models = list.reduce(
    (n, e) => n + (Array.isArray(e[binding.models]) ? e[binding.models].length : 0),
    0
  );

  const adding = ctx.isOpen('llm-add', false);

  const view = h(
    'div',
    { class: 'llm' },
    h(
      'header',
      { class: 'lb-toolbar' },
      h(
        'div',
        { class: 'lb-stats' },
        h('span', { class: 'stat' }, h('b', {}, list.length), ' backends'),
        h('span', { class: 'stat' }, h('b', {}, models), ' models'),
        errors
          ? h('span', { class: 'stat stat-bad' }, h('b', {}, errors), ' to fix')
          : h('span', { class: ctx.native ? 'stat' : 'stat stat-ok' }, ctx.native ? 'Native inputs; not runtime validation' : 'valid'),
        warns ? h('span', { class: 'stat stat-warn' }, h('b', {}, warns), ' advisories') : null
      ),
      ctx.readOnly ? null : h(
        'button',
        {
          class: `btn btn-primary${adding ? ' active' : ''}`,
          dataset: { editorFocus: `llm:add-backend:${binding.root}` },
          'aria-expanded': String(adding),
          'aria-label': adding ? 'Cancel adding a backend' : 'Add backend',
          onclick: () => {
            if (ctx.native) {
              withActionFocus(focusScope, backendFocus([binding.root, list.length], false),
                () => ctx.onAppend([binding.root], ctx.newBackend()), `llm:add-backend:${binding.root}`);
              return;
            }
            withActionFocus(focusScope, null, () => {
              ctx.setOpen('llm-add', !adding);
              ctx.rerender();
            });
          },
        },
        adding ? 'Cancel' : 'Add backend'
      )
    ),
    adding && !ctx.readOnly
      ? addBackendPanel(ctx, list, () => {
          ctx.setOpen('llm-add', false);
        }, focusScope)
      : null,
    list.length
      ? h('div', { class: 'lb-list' }, list.map((e, i) => backendCard(e || {}, i, ctx, findings, list.length, focusScope)))
      : h(
          'div',
          { class: 'empty-state empty-state-lg' },
          h('h4', {}, 'No backends configured'),
          h(
            'p',
            {},
            'This deployment onboards LLM endpoints onto the gateway. Add a provider to begin \u2014 the file already contains commented examples you can read for reference.'
          )
        ),
    ctx.readOnly || ctx.native ? null : poolPreview(list)
  );
  focusScope.view = view;
  focusOwners.set(view, owner);
  return view;
}
