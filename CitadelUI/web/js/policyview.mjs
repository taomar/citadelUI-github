/**
 * APIM product policy editor.
 *
 * Two ways to edit, both writing to the same file:
 *
 *   Guided  - the handful of attributes the contract template calls out as
 *             "dynamic" become real form fields. Each one owns an exact
 *             character span, so a change splices only that span and leaves the
 *             rest of the policy -- including its comments and any hand-written
 *             rules -- byte-identical.
 *   Raw     - the full XML, for anything the guided controls do not cover.
 *
 * Guided changes are sent as structured operations rather than as replacement
 * text, so the server re-applies them against the file on disk. A stale tab can
 * therefore never overwrite an edit made elsewhere.
 */

import { h } from './dom.mjs';
import { picker } from './picker.mjs';

const QUOTA_PERIODS = ['Hourly', 'Daily', 'Weekly', 'Monthly', 'Yearly'];

/**
 * Attribute values are read straight out of the XML, so a counter key that
 * embeds a quoted string arrives as `&quot;`. Showing that to the user is both
 * unreadable and a trap: editing the field would send the entity back as
 * literal text and the escaper would turn its ampersand into `&amp;quot;`.
 */
function decodeAttr(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeMarkup(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function highlightXml(value) {
  return escapeMarkup(value)
    .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="xml-comment">$1</span>')
    .replace(/(&lt;\/?)([\w:-]+)([\s\S]*?)(&gt;)/g, (_all, open, tag, attrs, close) => {
      const marked = attrs.replace(
        /([\w:-]+)(\s*=\s*)(&quot;[\s\S]*?&quot;|'[\s\S]*?')/g,
        '<span class="xml-attr">$1</span>$2<span class="xml-value">$3</span>'
      );
      return `${open}<span class="xml-tag">${tag}</span>${marked}${close}`;
    });
}

function rawXmlEditor(policy, ctx) {
  const lines = h('pre', { class: 'raw-lines', 'aria-hidden': 'true' });
  const code = h('pre', { class: 'raw-code', 'aria-hidden': 'true' });
  const input = h('textarea', {
    class: 'ctl policy-raw',
    'aria-label': 'Raw policy XML',
    spellcheck: false,
    value: policy.text,
    oninput: (e) => {
      sync(e.target.value);
      ctx.onPolicyRaw(e.target.value);
    },
  });
  const sync = (value) => {
    lines.textContent = Array.from(
      { length: String(value).split('\n').length },
      (_, i) => i + 1
    ).join('\n');
    code.innerHTML = highlightXml(value);
  };
  input.addEventListener('scroll', () => {
    code.scrollTop = input.scrollTop;
    code.scrollLeft = input.scrollLeft;
    lines.scrollTop = input.scrollTop;
  });
  sync(policy.text);
  return h('div', { class: 'raw-editor' }, lines, h('div', { class: 'raw-stage' }, code, input));
}

function field(label, hint, control) {
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
    { class: 'pol-field' },
    h('label', { class: 'pol-label' }, label),
    h('div', { class: 'pol-control' }, control),
    hint ? h('p', { class: 'hint' }, hint) : null
  );
}

/**
 * Allowed models.
 *
 * The list is a filter over what the gateway actually serves, so it is offered
 * as a pick from the onboarded models rather than as free text: naming a model
 * no backend hosts yields a product that rejects every request for it. Free
 * text is still accepted, because a contract is often written before the
 * backend that will serve it is onboarded -- but a name the gateway does not
 * currently serve is called out rather than silently accepted.
 */
function modelsEditor(control, onChange, onboarded) {
  const models = control.models.slice();
  const known = new Map((onboarded || []).map((m) => [m.name, m]));

  const chips = models.map((model, index) => {
    const served = known.get(model);
    return h(
      'span',
      { class: `model-chip${served ? '' : ' model-chip-unknown'}` },
      h('code', {}, model),
      served
        ? h('span', { class: 'model-chip-src' }, served.backends.length > 1 ? 'pooled' : 'direct')
        : h('span', { class: 'model-chip-src model-chip-warn' }, 'not onboarded'),
      h(
        'button',
        {
          class: 'chip-x',
          title: `Remove ${model}`,
          onclick: () => {
            const next = models.filter((_, i) => i !== index);
            onChange({ control: 'allowedModels', value: next.join(',') });
          },
        },
        '\u2715'
      )
    );
  });

  const add = (value) => {
    const name = value.trim();
    if (!name || models.includes(name)) return;
    onChange({ control: 'allowedModels', value: [...models, name].join(',') });
  };

  const remaining = [...known.entries()]
    .filter(([n]) => !models.includes(n))
    .map(([n, m]) => ({ value: n, meta: m.backends && m.backends.length > 1 ? 'pooled' : 'direct' }));

  const p = picker(remaining, add, {
    placeholder: known.size ? 'Search models\u2026' : 'gpt-4o-mini',
    freeTextLabel: 'not onboarded',
    empty: 'Every onboarded model is already allowed. Type an id to add one anyway.',
  });

  return field(
    'Allowed models',
    'Requests naming a model outside this list are rejected by the gateway. An empty list allows every model.',
    h(
      'div',
      { class: 'models' },
      h(
        'div',
        { class: 'model-chips' },
        chips.length
          ? chips
          : h('span', { class: 'empty' }, 'No models listed \u2014 every model the gateway serves is allowed.')
      ),
      p.el,
      h(
        'p',
        { class: 'models-src' },
        known.size
          ? `${known.size} model${known.size === 1 ? '' : 's'} onboarded in bicep/infra/llm-backend-onboarding/main.bicepparam. `
          : 'No onboarded models found \u2014 register a backend under LLM Onboarding first.',
        remaining.length
          ? h(
              'button',
              { class: 'btn-link', onclick: () => onChange({ control: 'allowedModels', value: [...models, ...remaining.map((r) => r.value)].join(',') }) },
              `Add all ${remaining.length} remaining`
            )
          : null
      )
    )
  );
}

/**
 * Per-model token limits.
 *
 * The three shapes the gateway supports are structural, not a setting: a bare
 * limit applies to everything; a <choose> with a <when> per model limits only
 * those models; a <choose> that also has an <otherwise> does both. The editor
 * therefore shows the universal limit and the per-model overrides as separate
 * things, and states which shape the file is currently in, because "gpt-4o has
 * its own budget" and "every other model is unlimited" are easy to confuse.
 */
function limitAttrRow(attrs, onAttr, disabled) {
  const val = (k, f = '') => (attrs[k] ? decodeAttr(attrs[k].value) : f);
  const num = (k, label, hint) =>
    field(
      label,
      hint,
      h('input', {
        class: 'ctl',
        type: 'number',
        min: '0',
        value: val(k, '0'),
        disabled,
        onchange: (e) => onAttr(k, e.target.value),
      })
    );

  return h(
    'div',
    { class: 'pol-grid' },
    num('tokens-per-minute', 'Tokens per minute', 'Sustained rate limit.'),
    num('token-quota', 'Token quota', 'Total tokens allowed per period.'),
    field(
      'Quota period',
      'Window over which the quota resets.',
      h(
        'select',
        { class: 'ctl', disabled, onchange: (e) => onAttr('token-quota-period', e.target.value) },
        QUOTA_PERIODS.map((p) =>
          h('option', { value: p, selected: p === val('token-quota-period') }, p)
        )
      )
    ),
    field(
      'Counter key',
      'Everything sharing this key shares the budget.',
      h('input', {
        class: 'ctl',
        value: val('counter-key'),
        disabled,
        onchange: (e) => onAttr('counter-key', e.target.value),
      })
    )
  );
}

const SHAPES = {
  universal: {
    label: 'Universal',
    note: 'One budget applies to every model this contract allows.',
  },
  'per-model': {
    label: 'Per model only',
    note: 'Only the models listed below are limited. Any other allowed model is not metered at all \u2014 add a universal fallback if that is not what you want.',
  },
  mixed: {
    label: 'Mixed',
    note: 'The models listed below have their own budgets; every other allowed model falls back to the universal limit.',
  },
};

/**
 * The control that grants a model its own budget.
 *
 * Shared by every throttle family so the interaction cannot drift between
 * tokens and calls, and so the list of candidates is always the models the
 * gateway actually serves.
 */
function perModelAdder(limits, onboarded, key, onAdd, label) {
  const used = new Set(limits.perModel.map((p) => p.model));
  const available = (onboarded || [])
    .filter((m) => !used.has(m.name))
    .map((m) => ({
      value: m.name,
      meta: m.backends && m.backends.length > 1 ? 'pooled' : 'direct',
    }));

  const p = picker(available, onAdd, {
    placeholder: 'Search models\u2026',
    freeTextLabel: 'not onboarded',
    empty: 'No onboarded model left. Type a model id to add it anyway.',
  });

  return h(
    'div',
    { class: 'pol-add' },
    p.el,
    p.action(label, { class: 'btn' }),
    h(
      'p',
      { class: 'hint' },
      'Adding the first override wraps the rule in a ',
      h('code', {}, '<choose>'),
      ' and keeps the current numbers as the fallback, so nothing becomes unmetered by accident.'
    )
  );
}

function tokenLimitsEditor(limits, onboarded, onChange) {
  const shape = SHAPES[limits.mode] || SHAPES.universal;

  return h(
    'div',
    { class: 'pol-card' },
    h(
      'header',
      { class: 'pol-card-head' },
      h('h4', {}, 'Token limits'),
      h('span', { class: 'chip chip-type' }, shape.label),
      // The on/off switch comments out the whole element, which only has a
      // single unambiguous meaning while the policy is a bare limit. In a
      // <choose> the same click would silently disable one branch.
      limits.mode === 'universal' && limits.universal
        ? h(
            'label',
            { class: 'toggle' },
            h('input', {
              type: 'checkbox',
              checked: !limits.universal.commented,
              onchange: (e) => onChange({ control: 'tokenLimit', enabled: e.target.checked }),
            }),
            h('span', { class: 'toggle-track' }),
            h(
              'span',
              { class: 'toggle-label' },
              limits.universal.commented ? 'disabled' : 'enforced'
            )
          )
        : null
    ),
    h('p', { class: 'hint' }, shape.note),

    limits.universal
      ? h(
          'div',
          { class: 'pol-sub' },
          h('h4', {}, limits.mode === 'universal' ? 'Applies to every model' : 'Fallback for models without their own limit'),
          limitAttrRow(
            limits.universal.attributes,
            (k, v) => onChange({ control: 'tokenLimits', universal: { [k]: v } }),
            limits.universal.commented
          )
        )
      : h(
          'p',
          { class: 'hint' },
          'There is no universal limit. Models without a rule below are not metered.'
        ),

    limits.perModel.map((entry) =>
      h(
        'div',
        { class: 'pol-sub' },
        h(
          'header',
          { class: 'pol-sub-head' },
          h('h4', {}, entry.model || 'Custom condition'),
          // Removal is keyed off the model name, so a branch that tests
          // something else cannot be offered a Remove button that would
          // quietly do nothing.
          entry.model
            ? h(
                'button',
                {
                  class: 'btn-quiet btn-destructive',
                  onclick: () => onChange({ control: 'tokenLimits', removeModel: entry.model }),
                },
                'Remove override'
              )
            : null
        ),
        entry.model
          ? null
          : h('p', { class: 'hint' }, `Condition: ${entry.condition}. Edit this branch in Raw XML.`),
        limitAttrRow(
          entry.attributes,
          (k, v) =>
            onChange({ control: 'tokenLimits', perModel: { [entry.model]: { [k]: v } } }),
          !entry.model
        )
      )
    ),

    perModelAdder(
      limits,
      onboarded,
      'per-model-limit-options',
      (model) => onChange({ control: 'tokenLimits', addModel: model }),
      'Give this model its own budget'
    )
  );
}

function tokenLimitEditor(control, onChange) {
  const attrs = control.attributes || {};
  const attr = (name, fallback = '') => (attrs[name] ? attrs[name].value : fallback);

  const toggle = h(
    'label',
    { class: 'toggle' },
    h('input', {
      type: 'checkbox',
      checked: control.enabled,
      onchange: (e) =>
        onChange({
          control: 'tokenLimit',
          enabled: e.target.checked,
        }),
    }),
    h('span', { class: 'toggle-track' }),
    h('span', { class: 'toggle-label' }, control.enabled ? 'enforced' : 'disabled')
  );

  const numeric = (name, label, hint) =>
    field(
      label,
      hint,
      h('input', {
        class: 'ctl',
        type: 'number',
        min: '0',
        value: attr(name, '0'),
        disabled: !control.enabled,
        onchange: (e) => onChange({ control: 'tokenLimit', attribute: name, value: e.target.value }),
      })
    );

  return h(
    'div',
    { class: 'pol-card' },
    h(
      'header',
      { class: 'pol-card-head' },
      h('h4', {}, 'Token limit'),
      toggle,
      control.enabled ? null : h('span', { class: 'chip chip-muted' }, 'commented out')
    ),
    h(
      'p',
      { class: 'hint' },
      'Caps consumption per subscription. Disabling comments the block out rather than deleting it, so the configured numbers survive.'
    ),
    h(
      'div',
      { class: 'pol-grid', hidden: !control.enabled },
      numeric('tokens-per-minute', 'Tokens per minute', 'Sustained rate limit.'),

      numeric('token-quota', 'Token quota', 'Total tokens allowed per period.'),
      field(
        'Quota period',
        'Window over which the quota resets.',
        h(
          'select',
          {
            class: 'ctl',
            disabled: !control.enabled,
            onchange: (e) =>
              onChange({ control: 'tokenLimit', attribute: 'token-quota-period', value: e.target.value }),
          },
          QUOTA_PERIODS.map((p) =>
            h('option', { value: p, selected: p === attr('token-quota-period') }, p)
          )
        )
      ),
      field(
        'Estimate prompt tokens',
        'Count prompt tokens before the model replies. Slower, but enforces the limit up front.',
        h(
          'label',
          { class: 'toggle' },
          h('input', {
            type: 'checkbox',
            checked: attr('estimate-prompt-tokens') === 'true',
            disabled: !control.enabled,
            onchange: (e) =>
              onChange({
                control: 'tokenLimit',
                attribute: 'estimate-prompt-tokens',
                value: e.target.checked ? 'true' : 'false',
              }),
          }),
          h('span', { class: 'toggle-track' }),
          h('span', { class: 'toggle-label' }, attr('estimate-prompt-tokens'))
        )
      ),
      field(
        'Counter key',
        'Expression identifying who the limit applies to.',
        h('code', { class: 'pol-readonly' }, attr('counter-key'))
      )
    )
  );
}

function headersEditor(control, onChange) {
  return field(
    'Response headers',
    'Return remaining-token headers to the caller so clients can back off before being throttled.',
    h(
      'label',
      { class: 'toggle' },
      h('input', {
        type: 'checkbox',
        checked: control.value,
        onchange: (e) =>
          onChange({ control: 'responseHeaders', value: e.target.checked }),
      }),
      h('span', { class: 'toggle-track' }),
      h('span', { class: 'toggle-label' }, control.value ? 'enabled' : 'disabled')
    )
  );
}

/**
 * The documented `set-variable` switches, grouped as the policy guide groups
 * them. A knob absent from the file is shown in its default state and writing
 * to it adds the declaration, so the screen reflects what the gateway will do
 * rather than only what the file currently says.
 */
const VARIABLE_GROUPS = [
  {
    id: 'security',
    title: 'Authentication & authorization',
    lead: 'A second layer on top of the subscription key, validated by the shared security-handler fragment. Leave off to authenticate with the API key alone.',
  },
  {
    id: 'pii',
    title: 'PII handling',
    lead: 'Detect personal data in the prompt before it reaches the model. Anonymize rewrites it, block rejects the request; failures fail closed with a 502.',
  },
  {
    id: 'alerts',
    title: 'Alerting',
    lead: 'Raise Application Insights events for the conditions worth paging on. These only emit events \u2014 the alert rules themselves live in the monitoring deployment.',
  },
];

function variableField(def, state, onChange) {
  const value = state && state.present && !state.commented ? state.value : null;
  const write = (v) => onChange({ control: 'variable', key: def.key, value: v });

  if (def.type === 'boolean') {
    const on = value === 'true';
    return h(
      'div',
      { class: 'pol-field' },
      h(
        'label',
        { class: 'toggle' },
        h('input', { type: 'checkbox', checked: on, onchange: (e) => write(e.target.checked) }),
        h('span', { class: 'toggle-track' }),
        h('span', { class: 'toggle-label' }, def.label)
      ),
      h('p', { class: 'hint' }, def.help),
      state && !state.present ? h('span', { class: 'chip chip-muted' }, 'not set') : null
    );
  }

  return field(
    def.label,
    def.help,
    h('input', {
      class: 'ctl',
      type: def.type === 'number' ? 'number' : 'text',
      step: def.type === 'number' ? '0.05' : undefined,
      value: value === null ? '' : value,
      placeholder: 'not set',
      onchange: (e) => write(e.target.value === '' ? null : e.target.value),
    })
  );
}

function variableGroup(group, definitions, controls, onChange) {
  const defs = definitions.filter((d) => d.group === group.id);
  if (!defs.length) return null;
  return h(
    'div',
    { class: 'pol-card' },
    h('header', { class: 'pol-card-head' }, h('h4', {}, group.title)),
    h('p', { class: 'hint' }, group.lead),
    h(
      'div',
      { class: 'pol-grid' },
      defs.map((d) => variableField(d, (controls.variables || {})[d.key], onChange))
    )
  );
}

/**
 * Severity categories Azure AI Content Safety classifies. Kept in step with
 * CONTENT_SAFETY_CATEGORIES in server/contracts.mjs; offering a name outside
 * this set would write a category the service silently ignores.
 */
const CONTENT_SAFETY_CATEGORIES = ['Hate', 'SelfHarm', 'Sexual', 'Violence'];

/** Severity scales the service can report, per `categories/@output-type`. */
const CONTENT_SAFETY_OUTPUT_TYPES = ['FourSeverityLevels', 'EightSeverityLevels'];

/**
 * A block the policy does not carry yet.
 *
 * Rendering nothing for these was the biggest gap on this screen: content
 * safety and the two call throttles are absent from the shipped template, so
 * there was no way to discover they exist, let alone turn one on.
 */
function absentCard(name, title, lead, onChange) {
  return h(
    'div',
    { class: 'pol-card pol-card-off' },
    h(
      'header',
      { class: 'pol-card-head' },
      h('h4', {}, title),
      h('span', { class: 'chip chip-muted' }, 'not configured')
    ),
    h('p', { class: 'hint' }, lead),
    h(
      'div',
      { class: 'pol-enable' },
      h(
        'button',
        { class: 'btn btn-primary', onclick: () => onChange({ control: name, enable: true }) },
        'Add to this policy'
      ),
      h(
        'p',
        { class: 'hint' },
        'Writes the documented default block into ',
        h('code', {}, '<inbound>'),
        '. Every value stays editable here afterwards.'
      )
    )
  );
}

/**
 * Turning a block off comments it out instead of deleting it, so the numbers
 * an operator tuned survive being switched off and come back unchanged.
 */
function blockToggle(control, name, onChange) {
  const stuck = control.enabled && control.hasInnerComment;
  return h(
    'label',
    {
      class: 'toggle',
      title: stuck
        ? 'This block contains its own comment. XML comments cannot nest, so it can only be disabled in Raw XML.'
        : '',
    },
    h('input', {
      type: 'checkbox',
      checked: control.enabled,
      disabled: stuck,
      onchange: (e) => onChange({ control: name, enabled: e.target.checked }),
    }),
    h('span', { class: 'toggle-track' }),
    h('span', { class: 'toggle-label' }, control.enabled ? 'active' : 'commented out')
  );
}

/** Content safety, including the per-category severity thresholds. */
function contentSafetyEditor(control, onChange) {
  const lead =
    'Checks prompts and completions against Azure AI Content Safety. Failing a check returns 403. Content Safety accepts 10K characters per call, so turn prompt shield off if requests are larger than that.';
  if (!control) return absentCard('contentSafety', 'Content safety', lead, onChange);

  const attr = (n, f = '') => (control.attributes[n] ? decodeAttr(control.attributes[n].value) : f);
  const set = (name, value) =>
    onChange({ control: 'contentSafety', attributes: { [name]: value } });
  const present = new Set(control.categories.map((c) => c.name));
  const missing = CONTENT_SAFETY_CATEGORIES.filter((c) => !present.has(c));
  const picker = h(
    'select',
    { class: 'ctl' },
    missing.map((c) => h('option', { value: c }, c))
  );

  return h(
    'div',
    { class: 'pol-card' },
    h(
      'header',
      { class: 'pol-card-head' },
      h('h4', {}, 'Content safety'),
      blockToggle(control, 'contentSafety', onChange)
    ),
    h('p', { class: 'hint' }, lead),
    h(
      'div',
      { class: 'pol-grid' },
      field(
        'Backend id',
        'APIM backend pointing at the Content Safety resource.',
        h('input', {
          class: 'ctl',
          value: attr('backend-id'),
          onchange: (e) => set('backend-id', e.target.value),
        })
      ),
      field(
        'Shield prompt',
        'Detect jailbreak and injection attempts. Limited to 10K characters, with no chunking.',
        h(
          'label',
          { class: 'toggle' },
          h('input', {
            type: 'checkbox',
            checked: attr('shield-prompt') === 'true',
            onchange: (e) => set('shield-prompt', e.target.checked ? 'true' : 'false'),
          }),
          h('span', { class: 'toggle-track' }),
          h('span', { class: 'toggle-label' }, attr('shield-prompt', 'false'))
        )
      ),
      field(
        'Check completions',
        'Also screen the model\u2019s reply, not just the prompt.',
        h(
          'label',
          { class: 'toggle' },
          h('input', {
            type: 'checkbox',
            checked: attr('enforce-on-completions') === 'true',
            onchange: (e) => set('enforce-on-completions', e.target.checked ? 'true' : 'false'),
          }),
          h('span', { class: 'toggle-track' }),
          h('span', { class: 'toggle-label' }, attr('enforce-on-completions', 'false'))
        )
      ),
      field(
        'Window size',
        'Characters per chunk. Configurable for responses only: request prompts are always sent as a single 10,000 character window.',
        h('input', {
          class: 'ctl',
          type: 'number',
          value: attr('window-size'),
          placeholder: '1000',
          onchange: (e) => set('window-size', e.target.value),
        })
      ),
      field(
        'Window overlap',
        'Characters repeated between chunks so a phrase split across a boundary is still seen. Omitted means no overlap.',
        h('input', {
          class: 'ctl',
          type: 'number',
          value: attr('window-overlap-size'),
          placeholder: 'no overlap',
          onchange: (e) => set('window-overlap-size', e.target.value),
        })
      ),
      // Severity output type lives on <categories>, but it belongs with the
      // other switches: it decides what the thresholds below actually mean.
      control.outputType
        ? field(
            'Severity levels',
            'FourSeverityLevels reports 0, 2, 4 and 6. EightSeverityLevels reports 0 to 7 and is the finer control. Thresholds below are read on this scale.',
            h(
              'select',
              {
                class: 'ctl',
                onchange: (e) => onChange({ control: 'contentSafety', outputType: e.target.value }),
              },
              CONTENT_SAFETY_OUTPUT_TYPES.map((t) =>
                h('option', { value: t, selected: t === control.outputType.value }, t)
              )
            )
          )
        : null
    ),
    h(
      'div',
      { class: 'pol-sub' },
      h('header', { class: 'pol-sub-head' }, h('h4', {}, 'Severity thresholds')),
      h(
        'p',
        { class: 'hint' },
        '0 is the most restrictive and 7 the most permissive. A category that is not listed here is not checked at all.'
      ),
      control.categories.length
        ? h(
            'div',
            { class: 'pol-grid' },
            control.categories.map((cat) =>
              field(
                cat.name,
                null,
                h(
                  'div',
                  { class: 'pol-inline' },
                  h('input', {
                    class: 'ctl',
                    type: 'number',
                    min: '0',
                    max: '7',
                    value: cat.threshold,
                    onchange: (e) =>
                      onChange({
                        control: 'contentSafety',
                        categories: { [cat.name]: e.target.value },
                      }),
                  }),
                  h(
                    'button',
                    {
                      class: 'btn-quiet btn-destructive',
                      onclick: () =>
                        onChange({ control: 'contentSafety', removeCategory: cat.name }),
                    },
                    'Stop checking'
                  )
                )
              )
            )
          )
        : h('p', { class: 'hint' }, 'No categories are checked, so nothing is blocked.'),
      missing.length
        ? h(
            'div',
            { class: 'pol-add' },
            picker,
            h(
              'button',
              {
                class: 'btn',
                onclick: () =>
                  onChange({ control: 'contentSafety', addCategory: picker.value }),
              },
              'Check this category too'
            )
          )
        : null
    ),
    blocklistSection(control, onChange)
  );
}

/**
 * Blocklists.
 *
 * A blocklist is defined in the Content Safety resource, not here; the policy
 * only names the ones it wants enforced. So this edits identifiers rather than
 * terms, and says where the terms themselves live -- otherwise the obvious
 * reading is that typing a word here blocks that word.
 */
function blocklistSection(control, onChange) {
  const lists = control.blocklists || [];
  const input = h('input', {
    class: 'ctl ctl-w-short',
    placeholder: 'blocklist id',
    'aria-label': 'Blocklist id from the Content Safety resource',
  });
  const add = () => {
    const id = input.value.trim();
    if (!id) return;
    onChange({ control: 'contentSafety', addBlocklist: id });
  };
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    add();
  });

  return h(
    'div',
    { class: 'pol-sub' },
    h('header', { class: 'pol-sub-head' }, h('h4', {}, 'Blocklists')),
    h(
      'p',
      { class: 'hint' },
      'Custom term lists managed in the Azure AI Content Safety resource. Matching content is blocked regardless of the severity thresholds above. Terms are edited in the resource; only the list id belongs here.'
    ),
    lists.length
      ? h(
          'div',
          { class: 'model-chips' },
          lists.map((b) =>
            h(
              'span',
              { class: 'model-chip' },
              h('code', {}, b.id),
              h(
                'button',
                {
                  class: 'chip-x',
                  title: `Stop enforcing ${b.id}`,
                  onclick: () =>
                    onChange({ control: 'contentSafety', removeBlocklist: b.id }),
                },
                '\u2715'
              )
            )
          )
        )
      : h('p', { class: 'hint' }, 'No blocklists enforced.'),
    h('div', { class: 'pol-add' }, input, h('button', { class: 'btn', onclick: add }, 'Enforce this blocklist'))
  );
}

/** Request-count throttles, for tool and agent assets where tokens do not exist. */
/**
 * A throttle field rendered from its documented spec.
 *
 * Driving these from THROTTLE_SPECS rather than hand-writing them keeps the
 * form honest: an attribute the policy supports cannot silently go missing, and
 * the limits (a 300 second ceiling on rate, a 300 second floor on quota) travel
 * with the field instead of living in prose that can drift.
 */
function throttleField(spec, value, onSet) {
  const control =
    spec.type === 'number'
      ? h('input', {
          class: 'ctl',
          type: 'number',
          min: spec.min === undefined ? '0' : String(spec.min),
          max: spec.max === undefined ? undefined : String(spec.max),
          step: spec.step,
          value: value === undefined ? '' : value,
          placeholder: spec.required ? '' : 'not set',
          onchange: (e) => onSet(spec.key, e.target.value),
        })
      : spec.type === 'boolean'
        ? h(
            'label',
            { class: 'toggle' },
            h('input', {
              type: 'checkbox',
              checked: value === 'true',
              onchange: (e) => onSet(spec.key, e.target.checked ? 'true' : 'false'),
            }),
            h('span', { class: 'toggle-track' }),
            h('span', { class: 'toggle-label' }, value === 'true' ? 'true' : 'false')
          )
        : spec.type === 'enum'
          ? h(
              'select',
              { class: 'ctl', onchange: (e) => onSet(spec.key, e.target.value) },
              (spec.options || []).map((o) =>
                h('option', { value: o, selected: o === value }, o)
              )
            )
          : h('input', {
              class: 'ctl',
              value: value === undefined ? '' : value,
              placeholder: spec.required ? '' : 'not set',
              onchange: (e) => onSet(spec.key, e.target.value),
            });

  return field(spec.label, spec.help, control);
}

function callLimitEditor(control, name, title, lead, onChange, limits, onboarded, spec) {
  if (!control) return absentCard(name, title, lead, onChange);

  const fields = (spec && spec.fields) || [];
  const structureKey = name === 'rateLimit' ? 'rateLimits' : 'quotaLimits';
  const shape = limits ? SHAPES[limits.mode] || SHAPES.universal : null;
  const valueOf = (attrs, key) => (attrs[key] ? decodeAttr(attrs[key].value) : undefined);

  // Once the policy is mixed the flat control points at the first branch, so
  // fallback edits have to be addressed through the structure instead.
  const setUniversal = (k, v) =>
    limits && limits.mode !== 'universal'
      ? onChange({ control: structureKey, universal: { [k]: v } })
      : onChange({ control: name, attributes: { [k]: v } });

  const grid = (attrs, onSet) =>
    h(
      'div',
      { class: 'pol-grid' },
      fields.map((f) => throttleField(f, valueOf(attrs, f.key), onSet))
    );

  return h(
    'div',
    { class: 'pol-card' },
    h(
      'header',
      { class: 'pol-card-head' },
      h('h4', {}, title),
      shape ? h('span', { class: 'chip chip-type' }, shape.label) : null,
      blockToggle(control, name, onChange)
    ),
    h('p', { class: 'hint' }, lead),
    spec ? h('p', { class: 'hint' }, spec.window) : null,
    shape && limits.mode !== 'universal' ? h('p', { class: 'hint' }, shape.note) : null,

    h(
      'div',
      { class: 'pol-sub' },
      limits && limits.mode !== 'universal'
        ? h('h4', {}, 'Fallback for models without their own limit')
        : null,
      grid(control.attributes, setUniversal)
    ),

    limits
      ? limits.perModel.map((entry) =>
          entry.model
            ? h(
                'div',
                { class: 'pol-sub' },
                h(
                  'header',
                  { class: 'pol-sub-head' },
                  h('h4', {}, entry.model),
                  h(
                    'button',
                    {
                      class: 'btn-quiet btn-destructive',
                      onclick: () =>
                        onChange({ control: structureKey, removeModel: entry.model }),
                    },
                    'Remove override'
                  )
                ),
                grid(entry.attributes, (k, v) =>
                  onChange({ control: structureKey, perModel: { [entry.model]: { [k]: v } } })
                )
              )
            : h(
                'div',
                { class: 'pol-sub' },
                h('h4', {}, 'Custom condition'),
                h('p', { class: 'hint' }, 'This branch does not test requestedModel, so it is edited in Raw XML.')
              )
        )
      : null,

    limits
      ? perModelAdder(
          limits,
          onboarded,
          `${structureKey}-add`,
          (model) => onChange({ control: structureKey, addModel: model }),
          'Give this model its own call budget'
        )
      : null
  );
}

/**
 * Semantic caching.
 *
 * Lookup and store are one feature in two pipeline sections, so they are shown
 * as one block. The threshold is presented as a correctness control rather than
 * a speed dial, because a loose threshold returns a cached answer to a prompt
 * that only resembles the original.
 */
function semanticCacheEditor(control, onChange, spec) {
  const lead =
    'Returns a stored answer when a new prompt is semantically close to an earlier one, cutting latency and backend load. Matches are approximate, so a loose threshold can return an answer to a question that was not asked.';
  if (!control || !control.lookup) return absentCard('semanticCache', 'Semantic caching', lead, onChange);
  if (!spec) return null;

  const valueOf = (attrs, key) => (attrs[key] ? decodeAttr(attrs[key].value) : undefined);
  const setLookup = (k, v) => onChange({ control: 'semanticCache', lookup: { [k]: v } });

  return h(
    'div',
    { class: 'pol-card' },
    h(
      'header',
      { class: 'pol-card-head' },
      h('h4', {}, 'Semantic caching'),
      blockToggle(control.lookup, 'semanticCache', onChange)
    ),
    h('p', { class: 'hint' }, lead),
    !control.store
      ? h(
          'p',
          { class: 'hint hint-warn' },
          'No matching store policy was found in the outbound section. A lookup without a store never hits the cache.'
        )
      : null,
    h(
      'div',
      { class: 'pol-grid' },
      spec.lookupFields.map((f) => throttleField(f, valueOf(control.lookup.attributes, f.key), setLookup))
    ),
    control.store
      ? h(
          'div',
          { class: 'pol-sub' },
          h('h4', {}, 'Stored responses'),
          h(
            'div',
            { class: 'pol-grid' },
            spec.storeFields.map((f) =>
              throttleField(f, valueOf(control.store.attributes, f.key), (k, v) =>
                onChange({ control: 'semanticCache', store: { [k]: v } })
              )
            )
          )
        )
      : null,
    control.lookup.varyBy && control.lookup.varyBy.length
      ? h(
          'div',
          { class: 'pol-sub' },
          h('h4', {}, 'Cache partitions'),
          h(
            'p',
            { class: 'hint' },
            'Each expression partitions the cache. Without one, callers can be served each other\u2019s answers.'
          ),
          control.lookup.varyBy.map((v, index) =>
            field(
              `vary-by ${index + 1}`,
              'Evaluated per request; values are concatenated to form the partition key.',
              h('input', {
                class: 'ctl',
                value: decodeAttr(v.value),
                onchange: (e) =>
                  onChange({ control: 'semanticCache', varyBy: { [index]: e.target.value } }),
              })
            )
          )
        )
      : null
  );
}

export function renderPolicy(policy, ctx) {
  if (!policy) {
    return h(
      'div',
      { class: 'empty-state' },
      h('p', {}, 'This contract has no policy file of its own.'),
      h('p', { class: 'hint' }, 'It falls back to the module default at deployment time.')
    );
  }

  const controls = policy.controls || {};
  const onChange = ctx.onPolicyChange;

  /**
   * Scope is the thing this screen most easily misleads about: every control
   * below is written into one product's policy and applies to every
   * subscription of that product, not to a single caller and not to the
   * gateway as a whole. Saying so once, up front, is cheaper than having each
   * field hedge about it.
   */
  const scope = h(
    'div',
    { class: 'pol-scope' },
    h('h4', {}, 'Scope'),
    h(
      'p',
      {},
      'These rules are the product policy for this contract. They apply to every request made with any subscription key issued under it, across all APIs the product exposes \u2014 not to an individual caller, and not to other contracts.'
    ),
    h(
      'p',
      {},
      'Token limits count per ',
      h('code', {}, 'counter-key'),
      ', so a key of ',
      h('code', {}, '@(context.Subscription.Id)'),
      ' meters each subscription separately while a fixed string meters the whole product together. Append the requested model to the key to meter each model on its own.'
    )
  );

  const guided = h(
    'div',
    { class: 'policy-guided' },
    scope,
    controls.allowedModels
      ? modelsEditor(controls.allowedModels, onChange, ctx.onboardedModels)
      : null,
    controls.tokenLimits
      ? tokenLimitsEditor(controls.tokenLimits, ctx.onboardedModels, onChange)
      : null,
    callLimitEditor(
      controls.rateLimit,
      'rateLimit',
      'Request rate limit',
      'Throttles by request count rather than tokens. This is how tool and agent assets are limited, because an MCP tool call or an agent turn has no token count to meter.',
      onChange,
      controls.rateLimits,
      ctx.onboardedModels,
      ctx.throttleSpecs && ctx.throttleSpecs.rateLimit
    ),
    callLimitEditor(
      controls.callQuota,
      'callQuota',
      'Request quota',
      'The long-term allowance, and the call-based counterpart to the token quota. Set alongside the rate limit: the rate limit stops bursts, the quota caps total consumption.',
      onChange,
      controls.quotaLimits,
      ctx.onboardedModels,
      ctx.throttleSpecs && ctx.throttleSpecs.callQuota
    ),
    contentSafetyEditor(controls.contentSafety, onChange),
    semanticCacheEditor(controls.semanticCache, onChange, ctx.semanticCacheSpec),
    VARIABLE_GROUPS.map((g) =>
      variableGroup(g, ctx.policyVariables || [], controls, onChange)
    ),
    controls.responseHeaders ? headersEditor(controls.responseHeaders, onChange) : null,
    controls.fragments && controls.fragments.length
      ? h(
          'div',
          { class: 'pol-field' },
          h('label', { class: 'pol-label' }, 'Policy fragments'),
          h(
            'div',
            { class: 'model-chips' },
            controls.fragments.map((f) => h('code', { class: 'model-chip' }, f))
          ),
          h('p', { class: 'hint' }, 'Shared rules included from APIM. Edit them in the gateway deployment, not here.')
        )
      : null
  );

  const raw = rawXmlEditor(policy, ctx);

  return h(
    'div',
    { class: 'policy' },
    h(
      'header',
      { class: 'policy-head' },
      h('code', { class: 'policy-path' }, policy.path),
      h(
        'div',
        { class: 'policy-modes' },
        ['guided', 'raw'].map((mode) =>
          h(
            'button',
            {
              class: `tab tab-sm${ctx.policyMode === mode ? ' active' : ''}`,
              onclick: () => ctx.setPolicyMode(mode),
            },
            mode === 'guided' ? 'Guided' : 'Raw XML'
          )
        )
      )
    ),
    h(
      'div',
      { class: 'policy-rawwrap', hidden: ctx.policyMode !== 'raw' },
      h(
        'p',
        { class: 'hint' },
        'Saved as-is after a tag-balance check. Malformed XML is rejected before it reaches the file.'
      ),
      raw
    ),
    Object.assign(guided, { hidden: ctx.policyMode !== 'guided' })
  );
}
