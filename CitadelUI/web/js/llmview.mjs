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
import { editorField } from './editor-focus.mjs';
import {
  BACKEND_TYPES,
  AUTH_TYPES,
  MODEL_FIELDS,
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

const MODEL_GROUPS = [
  { id: 'identity', label: 'Identity', keys: ['name', 'modelPath'] },
  { id: 'serving', label: 'Serving profile', keys: ['modelFormat', 'modelVersion', 'sku', 'capacity'] },
  { id: 'request', label: 'Request contract', keys: ['apiVersion', 'inferenceApiVersion', 'timeout'] },
  { id: 'lifecycle', label: 'Lifecycle & routing', keys: ['retirementDate', 'sessionAwareModel'] },
];

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
          '. Change it if your deployment uses a different name.'
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
function modelRow(model, index, entry, entryIndex, ctx, expanded, toggle) {
  const path = [ROOT, entryIndex, 'supportedModels', index];
  const type = backendType(entry.backendType);
  const needsPath = Boolean(type && type.requiresModelPath);
  const missingPath = needsPath && !model.modelPath;
  const write = (key, value) => writeField(ctx, path, model, key, value);
  const detailId = `lm-editor-${entryIndex}-${index}`;
  const modelName = model.name || 'unnamed model';

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
            title: 'Edit model details',
            'aria-label': `Edit model details: ${modelName}`,
            'aria-expanded': 'false',
            'aria-controls': detailId,
          },
          h('span', { class: 'lm-caret' }, '\u203a'),
          model.name || h('em', {}, 'unnamed')
        )
      ),
      h('span', { class: 'lm-cell', role: 'cell', dataset: { label: 'Format' } }, model.modelFormat || (ctx.readOnly ? 'Not supplied' : 'OpenAI')),
      h('span', { class: 'lm-cell', role: 'cell', dataset: { label: 'Version' } }, model.modelVersion || (ctx.readOnly ? 'Not supplied' : '1')),
      h('span', { class: 'lm-cell', role: 'cell', dataset: { label: 'SKU' } }, model.sku || (ctx.readOnly ? 'Not supplied' : 'Standard')),
      h('span', { class: 'lm-cell lm-num', role: 'cell', dataset: { label: 'Capacity' } }, model.capacity ?? (ctx.readOnly ? 'Not supplied' : 100)),
      h(
        'span',
        { class: 'lm-flags', role: 'cell', dataset: { label: 'State' } },
        model.sessionAwareModel === true ? h('span', { class: 'chip chip-note' }, 'stateful') : null,
        missingPath ? h('span', { class: 'chip chip-bad' }, 'needs path') : null
      ),
      h(
        'span',
        { class: 'lm-actions', role: 'cell' },
        h(
          'button',
          {
            class: 'lm-x',
            title: `Remove ${modelName}`,
            'aria-label': `Remove ${modelName}`,
            onclick: () => ctx.onRemove(path),
          },
          '\u2715'
        )
      )
    );
  }

  const shown = MODEL_FIELDS.filter(
    (f) => !f.appliesTo || f.appliesTo.includes(entry.backendType)
  );
  const fields = new Map(shown.map((descriptor) => [descriptor.key, descriptor]));
  const section = (group) => {
    const sectionFields = group.keys
      .map((key) => fields.get(key))
      .filter(Boolean)
      .map((descriptor) => {
        const rendered = ctx.readOnly && !Object.hasOwn(model, descriptor.key)
          ? field(descriptor.label, h('span', { class: 'hint' }, 'Not supplied in target'))
          : modelField(descriptor, model, entry, type, write, ctx.readOnly);
        editorField(rendered, [...path, descriptor.key]);
        return ctx.decorateValue ? ctx.decorateValue([...path, descriptor.key], rendered) : rendered;
      });
    if (!sectionFields.length) return null;
    return h(
      'fieldset',
      { class: `lm-section lm-section-${group.id}` },
      h('legend', { class: 'lm-legend' }, group.label),
      group.id === 'identity'
        ? h(
            'div',
            { class: 'lm-identity-row' },
            h(
              'button',
              {
                class: 'lm-editor-toggle',
                onclick: toggle,
                title: 'Close model details',
                'aria-label': 'Close model details',
                'aria-expanded': 'true',
                'aria-controls': detailId,
              },
              h('span', { class: 'lm-caret open' }, '\u203a'),
              h('span', {}, 'Close model details')
            ),
            h('div', { class: 'lm-fields' }, sectionFields)
          )
        : h('div', { class: 'lm-fields' }, sectionFields)
    );
  };

  return h(
    'div',
    { class: `lm-group${missingPath ? ' lm-row-bad' : ''}`, role: 'row' },
    h(
      'div',
      { class: 'lm-editor', id: detailId, role: 'cell', 'aria-colspan': '7' },
      section(MODEL_GROUPS[0]),
      h('div', { class: 'lm-sections' }, MODEL_GROUPS.slice(1).map(section)),
      h(
        'div',
        { class: 'lm-editor-foot' },
        h(
          'button',
          {
            class: 'btn btn-sm btn-danger-ghost',
            title: `Remove ${modelName}`,
            onclick: () => ctx.onRemove(path),
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
function addModelRow(entry, entryIndex, ctx) {
  const catalog = catalogFor(entry.backendType);
  const type = backendType(entry.backendType);
  const existing = new Set((entry.supportedModels || []).map((m) => m && m.name));

  const add = (name) => {
    const id = name.trim();
    if (!id || existing.has(id)) return;
    ctx.onAppend([ROOT, entryIndex, 'supportedModels'], modelTemplate(id, entry.backendType));
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

  return h(
    'div',
    { class: 'lm-add' },
    modelPicker.el,
    modelPicker.action('Add model', { class: 'btn btn-sm' }),
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

function backendCard(entry, index, ctx, findings) {
  const path = [ROOT, index];
  const type = backendType(entry.backendType);
  const auth = effectiveAuthType(entry);
  const authInfo = authTypeInfo(auth);
  const explicitAuth = Boolean(entry.authType);
  const models = Array.isArray(entry.supportedModels) ? entry.supportedModels : [];
  const mine = findings.filter((f) => f.index === index);
  const errors = mine.filter((f) => f.level === 'error');

  const open = ctx.isOpen(`llm-${index}`, index === 0);
  const write = (key, value) => writeField(ctx, path, entry, key, value);

  const head = h(
    'summary',
    { class: 'lb-head' },
    h('span', { class: 'lb-caret' }, '\u203a'),
    h('span', { class: 'lb-id' }, entry.backendId || h('em', {}, 'unnamed backend')),
    h('span', { class: 'chip chip-provider' }, type ? type.label : entry.backendType || '\u2014'),
    h('span', { class: 'chip chip-muted' }, authInfo ? authInfo.label : auth),
    h('span', { class: 'chip chip-count' }, `${models.length} model${models.length === 1 ? '' : 's'}`),
    h('span', { class: 'lb-spacer' }),
    entry.priority != null || entry.weight != null
      ? h('span', { class: 'lb-routing' }, `p${entry.priority ?? 1} \u00b7 w${entry.weight ?? 100}`)
      : null,
    errors.length ? h('span', { class: 'chip chip-bad' }, `${errors.length}`) : null
  );

  const authFields =
    authInfo && authInfo.needsAuthConfig
      ? h(
          'div',
          { class: 'lb-sub' },
          h('h4', { class: 'lb-sub-title' }, 'Credential'),
          h(
            'div',
            { class: 'lf-grid' },
            field(
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
            field(
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

  const body = h(
    'div',
    { class: 'lb-body' },
    type ? h('p', { class: 'lb-summary' }, type.summary) : null,
    mine.length
      ? h(
          'ul',
          { class: 'lb-findings' },
          mine.map((f) =>
            h('li', { class: `finding finding-${f.level}` }, h('span', { class: 'finding-dot' }), f.message)
          )
        )
      : null,
    h(
      'div',
      { class: 'lf-grid' },
      field(
        'Backend ID',
        textField(entry.backendId, (v) => write('backendId', v), { placeholder: 'aif-primary', path: [...path, 'backendId'] }),
        'Unique across the deployment.'
      ),
      field(
        'Provider',
        selectField(
          entry.backendType,
          BACKEND_TYPES.map((b) => ({ value: b.id, label: b.label })),
          (v) => write('backendType', v),
          { path: [...path, 'backendType'] }
        ),
        type ? `Endpoint looks like ${type.endpointFormat}` : null
      ),
      field(
        'Endpoint',
        textField(entry.endpoint, (v) => write('endpoint', v), {
          placeholder: type ? type.endpointExample : 'https://\u2026',
          path: [...path, 'endpoint'],
        }),
        null,
        null,
        true
      ),
      field(
        'Authentication',
        selectField(
          entry.authType || '',
          [
            {
              value: '',
              label: `Provider default \u2014 ${authInfo ? authInfo.label : auth}`,
            },
            ...(type ? type.authTypes : AUTH_TYPES.map((a) => a.id)).map((id) => {
              const info = authTypeInfo(id);
              return { value: id, label: info ? info.label : id };
            }),
          ],
          (v) => {
            if (v === '' && explicitAuth) ctx.onRemove([...path, 'authType']);
            else if (v !== '') write('authType', v);
          },
          { path: [...path, 'authType'] }
        ),
        authInfo ? authInfo.summary : null
      ),
      field(
        'Priority',
        numberField(entry.priority ?? 1, (v) => write('priority', v), { min: 1, max: 5, path: [...path, 'priority'] }),
        'Lower wins. Ties share traffic by weight.'
      ),
      field(
        'Weight',
        numberField(entry.weight ?? 100, (v) => write('weight', v), { min: 1, max: 1000, path: [...path, 'weight'] }),
        'Share within a priority tier.'
      )
    ),
    authInfo && authInfo.note ? h('p', { class: 'lb-note' }, authInfo.note) : null,
    type && type.notes ? type.notes.map((n) => h('p', { class: 'lb-note' }, n)) : null,
    authFields,
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
          ? 'Expand a model to edit its deployment, serving, request, and lifecycle settings.'
            : 'Nothing routes here until a model is added.'
        )
      ),
      models.length
        ? h(
            'div',
            { class: 'lm-table', role: 'table', 'aria-label': 'Supported models' },
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
                  ctx.setOpen(key, !expanded);
                  ctx.rerender();
                });
              })
            )
          )
        : h(
            'p',
            { class: 'empty-state' },
            'No models yet. Nothing routes to this backend until you add one.'
          ),
      ctx.readOnly ? null : addModelRow(entry, index, ctx)
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
        ' from the gateway.'
      ),
      h(
        'button',
        {
          class: 'btn btn-sm btn-danger-ghost',
          onclick: () => ctx.onRemove(path),
          title: `Remove ${entry.backendId || 'this backend'}`,
        },
        'Remove backend'
      )
    )
  );

  const el = h('details', { class: 'lb', open }, head, body);
  el.addEventListener('toggle', () => ctx.setOpen(`llm-${index}`, el.open));
  return el;
}

/* ----------------------------------------------------------- provider picker */

function addBackendPanel(ctx, entries, close) {
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
                close();
                ctx.onAppend([ROOT], template);
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

export function renderLlmBackends(entries, ctx) {
  const list = Array.isArray(entries) ? entries : [];
  const findings = validateBackends(list);
  const errors = findings.filter((f) => f.level === 'error').length;
  const warns = findings.filter((f) => f.level === 'warn').length;
  const models = list.reduce(
    (n, e) => n + (Array.isArray(e.supportedModels) ? e.supportedModels.length : 0),
    0
  );

  const adding = ctx.isOpen('llm-add', false);

  return h(
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
          : h('span', { class: 'stat stat-ok' }, 'valid'),
        warns ? h('span', { class: 'stat stat-warn' }, h('b', {}, warns), ' advisories') : null
      ),
      h(
        'button',
        {
          class: `btn btn-primary${adding ? ' active' : ''}`,
          onclick: () => {
            ctx.setOpen('llm-add', !adding);
            ctx.rerender();
          },
        },
        adding ? 'Cancel' : 'Add backend'
      )
    ),
    adding && !ctx.readOnly
      ? addBackendPanel(ctx, list, () => {
          ctx.setOpen('llm-add', false);
        })
      : null,
    list.length
      ? h('div', { class: 'lb-list' }, list.map((e, i) => backendCard(e || {}, i, ctx, findings)))
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
    ctx.readOnly ? null : poolPreview(list)
  );
}
