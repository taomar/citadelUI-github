/**
 * Value editors.
 *
 * Every control emits a path-addressed operation rather than a whole new value,
 * because the server applies edits as surgical splices. Sending back a rebuilt
 * object would work functionally but would rewrite the entire parameter's text
 * and destroy its inline documentation.
 *
 * TWO RULES GOVERN EVERY CONTROL ON THIS SHEET.
 *
 * 1. The control TYPE is a function of the declared Bicep type, never of the
 *    expression wrapping it. `int(readEnvironmentVariable('PORT','8080'))` is
 *    an integer that happens to be sourced elsewhere; it gets the numeric
 *    control. Choosing by provenance is what produced nine different control
 *    widths on one screen and put booleans behind free-text boxes where
 *    `flase` was accepted and failed at deploy time.
 *
 * 2. The control WIDTH is a function of the value's expected length, never of
 *    the space beside it. Four widths exist -- number, short, identifier, long
 *    -- and `widthClass()` is the only thing that assigns one. Nothing is 100%.
 *
 * Presentation rule: nesting is flattened, not indented. A value two or more
 * levels deep is addressed by its dotted path in a two-column table, because
 * an indentation staircase pushed four number inputs to x=1326 on a 1280px
 * screen, behind a horizontal scrollbar, where they could not be reached.
 */

import { h } from './dom.mjs';
import { picker } from './picker.mjs';
import { REGION_NAMES } from './azuremeta.mjs';

const ENV_CALL = 'readEnvironmentVariable';
const ARGS = '__args';

function isExpr(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && '__expr' in value;
}

function typeOf(value) {
  if (isExpr(value)) return 'expr';
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Sensible blank value when adding an array item, based on its siblings. */
function templateFrom(sample) {
  if (sample === undefined) return '';
  if (isExpr(sample)) return '';
  if (Array.isArray(sample)) return [];
  if (sample === null) return '';
  if (typeof sample === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(sample)) out[k] = templateFrom(v);
    return out;
  }
  if (typeof sample === 'boolean') return false;
  if (typeof sample === 'number') return 0;
  return '';
}

let comboSeq = 0;

function namedControl(node, label) {
  const controls = node.matches && node.matches('input, select, textarea')
    ? [node]
    : [...node.querySelectorAll('input, select, textarea')];
  for (const control of controls) {
    if (!control.getAttribute('aria-label') && !control.getAttribute('aria-labelledby')) {
      control.setAttribute('aria-label', label);
    }
  }
  return node;
}

function valueLabel(path, schema) {
  const parts = path
    .filter((part) => part !== ARGS)
    .map((part) => typeof part === 'number' ? `entry ${part + 1}` : String(part));
  return `Value for ${(schema && schema.name) || parts.join('.') || 'parameter'}`;
}

/**
 * Rule 2, in one function. The width names what the value is.
 *
 *   num    a port, a count, a retention period -- four to six digits
 *   short  an enum member, a SKU, a tier -- one word
 *   id     a resource name, a region, a key -- the default for a string
 *   long   a URL, an APIM expression, a connection string
 *
 * Nothing else may set a control's width. The whole reason ninety-seven rows
 * printed the same 190px box regardless of content is that width was taken
 * from the container instead of from the value.
 */
function widthClass(schema, value) {
  const type = schema && schema.type;
  if (type === 'int' || typeof value === 'number') return 'ctl-w-num';
  if (schema && Array.isArray(schema.allowedValues) && schema.allowedValues.length) {
    const longest = schema.allowedValues.reduce((n, v) => Math.max(n, String(v).length), 0);
    return longest > 18 ? 'ctl-w-id' : 'ctl-w-short';
  }
  const str = value === null || value === undefined ? '' : String(value);
  if (str.length > 44 || /^https?:|^@\(|\n/.test(str)) return 'ctl-w-long';
  return 'ctl-w-id';
}

/**
 * A value the file does not supply.
 *
 * Roughly half of these ninety-seven parameters state nothing at all -- they
 * resolve entirely from the environment at deployment time. Drawing each one
 * as a filled control made the emptiest field the heaviest object in its row
 * and turned nineteen consecutive resource names into a wall of identical
 * blank boxes. Absence is stated in words instead, and the variable that will
 * supply the value is named right there rather than in a column of its own.
 *
 * It is still editable: the line is a button, so click or Enter promotes it to
 * a real input, focused, ready to type. Nothing is hidden, only unasked for.
 */
function unsetControl(varName, onPromote) {
  const line = h(
    'button',
    {
      type: 'button',
      class: 'unset',
      title: varName
        ? `No value in this file. ${varName} supplies it at deployment time. Choose to set one here.`
        : 'No value in this file. Choose to set one here.',
    },
    h('span', { class: 'unset-mark' }, '\u2014'),
    h('span', { class: 'unset-text' }, 'not set'),
    varName ? h('span', { class: 'unset-var' }, varName) : null
  );
  line.addEventListener('click', () => onPromote(line));
  return line;
}

/**
 * A secret is masked, but a secret you cannot read back is a secret you cannot
 * verify. The reveal is a button rather than a permanent plaintext field so the
 * default state is safe over a shoulder and the value is still checkable.
 */
function withReveal(input) {
  const btn = h('button', {
    type: 'button',
    class: 'ctl-reveal',
    'aria-label': 'Show value',
    'aria-pressed': 'false',
    title: 'Show value',
  });
  btn.addEventListener('click', () => {
    const shown = input.type === 'text';
    input.type = shown ? 'password' : 'text';
    btn.setAttribute('aria-pressed', shown ? 'false' : 'true');
    const label = shown ? 'Show value' : 'Hide value';
    btn.setAttribute('aria-label', label);
    btn.title = label;
  });
  return h('div', { class: 'secret' }, input, btn);
}

/**
 * A bound the template declares is part of the control, not a footnote to it:
 * the browser enforces it and the reader can see it without hunting main.bicep.
 */
function boundsNote(schema) {
  if (!schema) return null;
  const lo = schema.minValue;
  const hi = schema.maxValue;
  if (lo === undefined && hi === undefined) return null;
  let text;
  if (lo !== undefined && hi !== undefined) text = `${lo} to ${hi}`;
  else if (lo !== undefined) text = `${lo} or more`;
  else text = `${hi} or less`;
  return h('span', { class: 'ctl-bound' }, text);
}

/** Wraps a numeric control with its declared range when the template states one. */
function withBounds(input, schema) {
  if (schema) {
    if (schema.minValue !== undefined) input.min = String(schema.minValue);
    if (schema.maxValue !== undefined) input.max = String(schema.maxValue);
  }
  const note = boundsNote(schema);
  if (!note) return input;
  return h('div', { class: 'numfield' }, input, note);
}

/**
 * An expression is read left to right and every character of it matters, so it
 * gets a monospace box that grows to the text instead of a single line that
 * scrolls the beginning of the value out of sight.
 */
function exprBox(str, commit) {
  const ta = h('textarea', {
    class: 'ctl ctl-expr',
    rows: Math.max(2, Math.min(10, str.split('\n').length + 1)),
    value: str,
    spellcheck: false,
    onchange: (e) => commit(e.target.value),
  });
  return ta;
}

/**
 * A constrained value.
 *
 * `allowedValues` comes from the Bicep `@allowed` decorator. Most of those
 * lists are closed technical vocabularies -- `Enabled`/`Disabled`, a SKU tier,
 * a log category -- and for those a text box that accepts anything is simply
 * the wrong control: it invites a typo the file cannot detect and the
 * deployment rejects an hour later. Those get a select.
 *
 * Location lists remain closed because their Bicep `@allowed` decorators are
 * authoritative. They use the searchable picker so opening a populated value
 * still presents the complete legal list instead of filtering to itself.
 */
function outsideNote() {
  return h(
    'p',
    { class: 'ctl-note' },
    'Not one of the values main.bicep allows. Deployment will reject it unless the template\u2019s @allowed list is updated.'
  );
}

function freeTextControl(current, known, commit, secure, width) {
  const listId = `opts-${++comboSeq}`;
  const note = outsideNote();
  const sync = (v) => {
    note.hidden = v === '' || known.includes(v);
  };

  const input = h('input', {
    class: `ctl ctl-combo ${width}`,
    type: secure ? 'password' : 'text',
    value: current,
    list: listId,
    autocomplete: 'off',
    spellcheck: false,
  });
  input.addEventListener('input', () => sync(input.value));
  input.addEventListener('change', () => {
    sync(input.value);
    commit(input.value);
  });
  sync(current);

  return {
    node: h(
      'div',
      { class: 'combo' },
      secure ? withReveal(input) : input,
      h('datalist', { id: listId }, known.map((o) => h('option', { value: o }))),
      note
    ),
    input,
  };
}

function isLocationSchema(schema) {
  return /location|region/i.test((schema && schema.name) || '');
}

function comboControl(value, allowed, commit, secure, schema) {
  const current = value === null || value === undefined ? '' : String(value);
  const known = allowed.map(String);
  const width = widthClass(schema, current);
  const location = isLocationSchema(schema);

  if (location) {
    const candidates = known.map((option) => ({
      value: option,
      meta: option === '' ? 'Use primary location' : REGION_NAMES[option] || option,
    }));
    const control = picker(candidates, commit, {
      value: current,
      placeholder: schema.name === 'apicLocation' ? 'Use primary location' : 'Choose a region',
      ariaLabel: `Value for ${schema.name}`,
      freeText: false,
      allowEmpty: known.includes(''),
      empty: 'No legal region matches.',
      commitOnBlur: true,
    });
    const note = outsideNote();
    note.hidden = current === '' || known.includes(current);
    return h('div', { class: 'combo' }, control.el, note);
  }

  const wrap = h('div', { class: 'combo' });
  const select = h(
    'select',
    { class: `ctl ${width}` },
    current !== '' && !known.includes(current)
      ? h('option', { value: current, selected: true }, `${current} (unsupported)`)
      : null,
    current === '' ? h('option', { value: '' }, '\u2014 choose \u2014') : null,
    known.map((o) => h('option', { value: o, selected: o === current }, o))
  );
  select.addEventListener('change', () => {
    commit(select.value);
  });
  wrap.append(select);
  return wrap;
}

/**
 * Rule 1, in one function: the declared type decides, the expression does not.
 * The branches are ordered by type -- bool, int, enum, secret, long, string --
 * and provenance appears nowhere in them.
 */
function scalarControl(value, path, ctx, schema) {
  const commit = (next) => ctx.onChange(path, next);
  const type = schema && schema.type;
  const label = valueLabel(path, schema);

  // A boolean is a switch, whatever shape it arrives in. `bool(readEnvironment
  // Variable(...))` delivers the string "true"; without this the fifteen
  // feature flags fell through to free text, where `flase` was accepted here
  // and rejected by ARM.
  const boolish =
    typeof value === 'boolean' || (type === 'bool' && (value === 'true' || value === 'false'));

  if (boolish) {
    const on = value === true || value === 'true';
    // Written back in the shape it was read, so a string-typed fallback stays a
    // string and the file's own quoting is preserved.
    const write = (next) => commit(typeof value === 'boolean' ? next : String(next));
    return namedControl(h(
      'label',
      { class: 'toggle' },
      h('input', {
        type: 'checkbox',
        checked: on,
        onchange: (e) => write(e.target.checked),
      }),
      h('span', { class: 'toggle-track' }),
      h('span', { class: 'toggle-label' }, on ? 'true' : 'false')
    ), label);
  }

  // A number, whether it arrived as one or as the string an int() cast
  // consumes. Written back in the shape it was read.
  if (typeof value === 'number' || (type === 'int' && typeof value === 'string')) {
    const numeric = typeof value === 'number';
    return namedControl(withBounds(
      h('input', {
        class: 'ctl ctl-num',
        type: 'number',
        inputmode: 'numeric',
        value: String(value),
        onchange: (e) => commit(numeric ? Number(e.target.value) : e.target.value),
      }),
      schema
    ), label);
  }

  if (schema && Array.isArray(schema.allowedValues) && schema.allowedValues.length) {
    return namedControl(comboControl(value, schema.allowedValues, commit, schema.secure, schema), label);
  }

  const str = value === null ? '' : String(value);
  // An APIM policy expression or a multi-line literal is read whole or not at
  // all. Sixty characters is where a value stops fitting the sheet's value
  // column on a laptop, so that is where the single line stops being honest.
  const multiline = str.includes('\n') || str.length > 60 || str.startsWith('@(');
  if (multiline) return namedControl(exprBox(str, commit), label);

  const input = h('input', {
    class: `ctl ${widthClass(schema, str)}`,
    type: schema && schema.secure ? 'password' : 'text',
    value: str,
    placeholder:
      schema && !schema.envVar && schema.hasDefault ? String(schema.defaultValue ?? '') : '',
    onchange: (e) => commit(e.target.value),
  });
  return namedControl(schema && schema.secure ? withReveal(input) : input, label);
}

/**
 * Expression line.
 *
 * readEnvironmentVariable() is the dominant shape in bicep/infra: the value the
 * user cares about lives in .azure/<env>/.env, not here. This states the whole
 * chain on one line -- source, variable, resolved value, where to change it --
 * because it repeats on dozens of parameters and a card for each one is what
 * made the old sheet unreadable.
 */
/**
 * Casts that wrap an environment lookup.
 *
 * `readEnvironmentVariable` always yields a string, so any parameter typed as a
 * number or a boolean has to be written `int(readEnvironmentVariable(...))`.
 * The cast is a language obligation, not a decision the user made, so the row
 * shows the same editable environment line as an unwrapped lookup and reports
 * the cast as a type note rather than hiding the value behind raw text.
 */
const CASTS = new Set(['int', 'bool', 'string', 'json']);

function unwrapCast(value) {
  if (
    value.__expr === 'call' &&
    CASTS.has(value.callee) &&
    value.args.length === 1 &&
    isExpr(value.args[0]) &&
    value.args[0].callee === ENV_CALL
  ) {
    return { call: value.args[0], cast: value.callee, prefix: [ARGS, 0] };
  }
  if (value.__expr === 'call' && value.callee === ENV_CALL) {
    return { call: value, cast: null, prefix: [] };
  }
  return null;
}

/**
 * The fallback literal is always a string in the file, even when the parameter
 * is a number or a boolean, because that is what the cast consumes. The control
 * therefore edits a string but is shaped by the declared type, so a boolean
 * offers true/false rather than a free text box that can be typed wrong.
 */
function fallbackSchema(schema, cast) {
  const type = cast || (schema && schema.type);
  // A bool() cast means the fallback is a boolean written as a string, so the
  // control is a switch. Reporting the type rather than a two-value enum is
  // what keeps it from rendering as a dropdown.
  if (type === 'bool') return { ...(schema || {}), type: 'bool', allowedValues: null };
  if (schema && Array.isArray(schema.allowedValues) && schema.allowedValues.length) {
    return { ...schema, allowedValues: schema.allowedValues.map(String) };
  }
  return schema;
}

/**
 * Environment-backed value.
 *
 * `readEnvironmentVariable('VAR', 'fallback')` is the dominant shape in
 * bicep/infra, but only the fallback lives in this file -- the variable is
 * resolved at deployment time from the azd environment. Editing this file means
 * editing the fallback, so that is the whole row: one control holding the value
 * the file actually contains.
 *
 * The variable name and the cast are still true, just not worth a column each
 * on ninety-seven rows. They move into the parameter's explanation popover,
 * where they are available on demand instead of competing with the value.
 */
function exprCard(value, path, ctx, schema) {
  const env = unwrapCast(value);

  if (env) {
    const { call, cast, prefix } = env;
    const varName = String(call.args[0]);
    const fallback = call.args.length > 1 ? call.args[1] : undefined;
    const has = fallback !== undefined && !isExpr(fallback);
    const sub = { ...fallbackSchema(schema, cast), envVar: varName };
    const target = [...path, ...prefix, ARGS, 1];

    if (
      has &&
      fallback === '' &&
      isLocationSchema(sub) &&
      Array.isArray(sub.allowedValues) &&
      sub.allowedValues.includes('')
    ) {
      return h('div', { class: 'expr expr-env' }, scalarControl(fallback, target, ctx, sub));
    }

    // Nothing in this file, and nothing a box could usefully show. State the
    // absence and name the variable that resolves it; promote to a real
    // control only when the reader asks for one.
    if (!has || fallback === '' || fallback === null) {
      const holder = h('div', { class: 'expr expr-env expr-empty' });
      holder.append(
        unsetControl(varName, () => {
          const ctl = scalarControl(has ? fallback : '', target, ctx, sub);
          holder.replaceChildren(ctl);
          const focusable = ctl.matches('input, select, textarea')
            ? ctl
            : ctl.querySelector('input, select, textarea');
          if (focusable) focusable.focus();
        })
      );
      return holder;
    }

    return h('div', { class: 'expr expr-env' }, scalarControl(fallback, target, ctx, sub));
  }

  return h(
    'div',
    { class: 'expr' },
    h(
      'span',
      { class: 'chip chip-expr' },
      value.__expr === 'call' ? `${value.callee}()` : 'reference'
    ),
    h('code', { class: 'expr-raw' }, value.raw),
    h('p', { class: 'hint' }, 'Preserved exactly as written. Edit the raw file to change it.')
  );
}

/**
 * A list of plain strings is a set, not a record: each entry is short, order is
 * rarely meaningful, and the operation the reader wants is add or drop. Giving
 * each one a numbered header and a full-width row buried five domain names in
 * eighty pixels of chrome, so a scalar list is chips instead.
 */
function isScalarList(value) {
  if (!value.length) return false;
  return value.every(
    (v) => (typeof v === 'string' || typeof v === 'number') && String(v).length <= 60
  );
}

function chipList(value, path, ctx) {
  const chips = value.map((item, index) =>
    h(
      'span',
      { class: 'listchip' },
      h('span', { class: 'listchip-text' }, String(item)),
      h('button', {
        type: 'button',
        class: 'listchip-x',
        'aria-label': `Remove ${item}`,
        title: `Remove ${item}`,
        onclick: () => ctx.onRemove([...path, index]),
      })
    )
  );

  const input = h('input', {
    class: 'ctl ctl-sm',
    type: 'text',
    placeholder: 'Add an entry\u2026',
    'aria-label': 'Add an entry',
    spellcheck: false,
  });
  const add = () => {
    const next = input.value.trim();
    if (!next) return;
    ctx.onAppend(path, typeof value[0] === 'number' ? Number(next) : next);
    input.value = '';
  };
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    add();
  });

  return h(
    'div',
    { class: 'chiplist' },
    h('div', { class: 'chiplist-set' }, chips),
    h(
      'div',
      { class: 'chiplist-add' },
      input,
      h('button', { type: 'button', class: 'btn btn-sm', onclick: add }, 'Add')
    )
  );
}

/**
 * An array of records is a table.
 *
 * `aiFoundryModelsConfig` holds ten-key model objects. Rendered as one stacked
 * key/value pair per key per entry, four models cost forty labelled rows and
 * the answer to the only real question -- how do these differ -- has to be
 * reconstructed by eye down a column that does not exist. One row per entry,
 * one column per key, puts the comparison back on the horizontal axis where the
 * space already is.
 */
function isRecordList(value) {
  if (!Array.isArray(value) || value.length === 0) return false;
  const rows = value.filter(
    (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !isExpr(v)
  );
  if (rows.length !== value.length) return false;

  // Uniform enough to share a header: every row's keys must be a subset of the
  // union, and the union must not be so wide that the table stops being one.
  const union = new Set();
  for (const row of rows) for (const k of Object.keys(row)) union.add(k);
  if (union.size === 0 || union.size > 12) return false;

  // A record's values are scalars. One nested object turns a cell into a form
  // and the table into a lie about the shape of the data.
  for (const row of rows) {
    for (const v of Object.values(row)) {
      if (v !== null && typeof v === 'object' && !isExpr(v)) return false;
    }
  }
  return true;
}

function recordPickerControl(value, row, index, path, ctx, config) {
  const current = value == null ? '' : String(value);
  const pickerConfig = config.picker;
  const commit = (next) => {
    const candidate = pickerConfig.candidates.find(
      (item) => item.value.toLowerCase() === String(next).toLowerCase()
    );
    if (candidate && candidate.record) {
      for (const [key, candidateValue] of Object.entries(candidate.record)) {
      if (candidateValue === undefined || Object.is(row[key], candidateValue)) continue;
      if (Object.prototype.hasOwnProperty.call(row, key)) {
        ctx.onChange([...path, index, key], candidateValue);
      } else {
        ctx.onAddProperty([...path, index], key, candidateValue);
      }
      }
    }
    if (next !== current) ctx.onChange([...path, index, pickerConfig.key], next);
  };
  const control = picker(pickerConfig.candidates, commit, {
    value: current,
    placeholder: pickerConfig.placeholder,
    ariaLabel: pickerConfig.ariaLabel,
    freeTextLabel: pickerConfig.freeTextLabel,
    groups: pickerConfig.groups,
    commitOnBlur: true,
  });
  return control.el;
}

function recordColumns(columns, config) {
  const maximum = Math.max(1, (config && config.maxVisible) || 5);
  if (columns.length <= maximum) return { visible: columns, hidden: [] };

  const preferred = (config && config.visibleColumns) || [];
  const visible = preferred.filter((key) => columns.includes(key)).slice(0, maximum);
  for (const key of columns) {
    if (visible.length >= maximum) break;
    if (!visible.includes(key)) visible.push(key);
  }
  return { visible, hidden: columns.filter((key) => !visible.includes(key)) };
}

function recordCell(row, key, index, path, ctx, schema, config) {
  const hasValue = Object.prototype.hasOwnProperty.call(row, key);
  const pickerConfig = config && config.picker;
  const custom = config && config.controls && config.controls[key];
  const control = custom
    ? custom({ value: row[key], hasValue, row, index, path, ctx, schema: columnSchema(schema, key) })
    : null;
  return h(
    'div',
    {
      class: 'rec-cell',
      dataset: { kind: typeOf(row[key]), label: recordHeader(key) },
    },
    control || (hasValue
      ? pickerConfig && key === pickerConfig.key
      ? recordPickerControl(row[key], row, index, path, ctx, config)
      : renderValue(row[key], [...path, index, key], ctx, columnSchema(schema, key))
      : h(
        'button',
        {
          class: 'btn-link rec-missing',
          title: `Add ${key} to entry ${index + 1}`,
          onclick: () => ctx.onAddProperty([...path, index], key, ''),
        },
        'add'
      ))
  );
}

function setHiddenCount(row, hidden) {
  return hidden.filter((key) => {
    if (!Object.prototype.hasOwnProperty.call(row, key)) return false;
    const value = row[key];
    return value !== null && value !== undefined && value !== '';
  }).length;
}

const RECORD_HEADER_LABELS = new Map([
  ['aiserviceIndex', 'AI service'],
  ['apiVersion', 'API version'],
  ['modelFormat', 'Format'],
  ['modelVersion', 'Version'],
  ['retirementDate', 'Retires'],
  ['resourceGroupName', 'Resource group'],
  ['subscriptionId', 'Subscription ID'],
  ['endpointSecretName', 'Endpoint secret'],
  ['apiKeySecretName', 'API key secret'],
]);

function recordHeader(key) {
  if (RECORD_HEADER_LABELS.has(key)) return RECORD_HEADER_LABELS.get(key);
  return key
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (letter) => letter.toUpperCase());
}

function recordTable(value, path, ctx, schema, config = null) {
  const columns = [...((config && config.columns) || [])];
  for (const row of value) {
    for (const k of Object.keys(row)) if (!columns.includes(k)) columns.push(k);
  }
  const split = recordColumns(columns, config);
  const hasDetails = split.hidden.length > 0;
  const columnTracks = (config && config.columnTracks) || {};
  const grid = [
    '2rem',
    ...split.visible.map(
      (key, index) => columnTracks[key] || (index === 0 ? 'minmax(8rem, 1.6fr)' : 'minmax(4.5rem, 1fr)')
    ),
    hasDetails ? '5.25rem' : '2.5rem',
  ].join(' ');
  const tableStyle = `--rec-grid:${grid}`;

  const head = h(
    'div',
    { class: 'rec-row rec-head', style: tableStyle },
    h('div', { class: 'rec-cell rec-idx' }, '#'),
    split.visible.map((c) =>
      h('div', { class: 'rec-cell', title: recordHeader(c) }, recordHeader(c))
    ),
    h('div', { class: 'rec-cell rec-act' }, hasDetails ? 'More' : '')
  );

  const rows = value.map((row, index) => {
    const stateKey = `record:${JSON.stringify(path)}:${index}`;
    let expanded = Boolean(ctx.isOpen && ctx.isOpen(stateKey, false));
    const detailId = `record-detail-${++comboSeq}`;
    const detail = hasDetails
      ? h(
        'div',
        { class: 'rec-detail', id: detailId, hidden: !expanded },
        h('div', { class: 'rec-detail-title' }, 'Additional fields'),
        h(
          'div',
          { class: 'rec-detail-grid' },
          split.hidden.map((key) =>
            h(
              'div',
              { class: 'rec-field' },
              h('code', { class: 'rec-field-name' }, key),
              recordCell(row, key, index, path, ctx, schema, config)
            )
          )
        )
      )
      : null;
    const toggle = hasDetails
      ? h(
        'button',
        {
          class: 'btn-link rec-toggle',
          type: 'button',
          'aria-expanded': String(expanded),
          'aria-controls': detailId,
          title: `Show ${split.hidden.length} additional fields`,
          onclick: (event) => {
            expanded = !expanded;
            event.currentTarget.setAttribute('aria-expanded', String(expanded));
            detail.hidden = !expanded;
            if (ctx.setOpen) ctx.setOpen(stateKey, expanded);
          },
        },
        h('span', { class: 'rec-toggle-mark', 'aria-hidden': 'true' }, '›'),
        `${setHiddenCount(row, split.hidden)} set`
      )
      : null;
    return h(
      'div',
      { class: 'rec-entry' },
      h(
      'div',
      { class: 'rec-row', style: tableStyle },
      h('div', { class: 'rec-cell rec-idx' }, String(index + 1).padStart(2, '0')),
      split.visible.map((key) => recordCell(row, key, index, path, ctx, schema, config)),
      h(
        'div',
        { class: 'rec-cell rec-act rec-actions' },
        toggle,
        config && config.hideAdd
          ? null
          : h(
          'button',
          {
            class: 'btn btn-ghost btn-sm rec-remove',
            title: `Remove entry ${index + 1}`,
            'aria-label': `Remove entry ${index + 1}`,
            onclick: () => ctx.onRemove([...path, index]),
          },
          '×'
        )
      )
      ),
      detail
    );
  });

  return h(
    'div',
    { class: 'array' },
    config && config.before
      ? config.before({ value, path, ctx, schema })
      : null,
    h('div', { class: 'rec' }, head, rows),
    h(
      'button',
      {
        class: 'btn btn-sm',
        onclick: () => ctx.onAppend(
          path,
          config && config.newRecord
            ? structuredClone(config.newRecord)
            : templateFrom(value[value.length - 1])
        ),
      },
      (config && config.addLabel) || 'Add entry'
    )
  );
}

/** Per-key schema for a record column, when the template declares one. */
function columnSchema(schema, key) {
  const props = schema && (schema.properties || (schema.items && schema.items.properties));
  return (props && props[key]) || null;
}

function arrayEditor(value, path, ctx, schema, options) {
  if (isScalarList(value)) return chipList(value, path, ctx);
  if (options && options.record) return recordTable(value, path, ctx, schema, options.record);
  if (isRecordList(value)) return recordTable(value, path, ctx, schema, options && options.record);

  const items = value.map((item, index) =>
    h(
      'div',
      { class: 'item' },
      h(
        'div',
        { class: 'item-head' },
        h('span', { class: 'item-index' }, String(index + 1).padStart(2, '0')),
        h(
          'button',
          {
            class: 'btn btn-ghost btn-sm',
            title: 'Remove this entry',
            onclick: () => ctx.onRemove([...path, index]),
          },
          'Remove'
        )
      ),
      h('div', { class: 'item-body' }, renderValue(item, [...path, index], ctx, null))
    )
  );

  return h(
    'div',
    { class: 'array' },
    items.length ? items : h('p', { class: 'empty' }, 'No entries yet.'),
    h(
      'button',
      {
        class: 'btn btn-sm',
        onclick: () => ctx.onAppend(path, templateFrom(value[value.length - 1])),
      },
      'Add entry'
    )
  );
}

/**
 * Depth of an object graph, counting only the branches that would have earned
 * their own indent level.
 */
function depthOf(value) {
  if (value === null || typeof value !== 'object' || isExpr(value)) return 0;
  const kids = Array.isArray(value) ? value : Object.values(value);
  let max = 0;
  for (const v of kids) max = Math.max(max, depthOf(v));
  return 1 + max;
}

/**
 * Walks a nested object into a flat list of leaf rows addressed by dotted path.
 * Arrays index numerically, so `retention[0].days` reads the way the file does.
 */
function flattenLeaves(value, trail, path, out) {
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v, `${trail}[${i}]`])
    : Object.entries(value).map(([k, v]) => [k, v, trail ? `${trail}.${k}` : k]);

  for (const [key, val, label] of entries) {
    const scalarArray =
      Array.isArray(val) &&
      val.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item));
    if (
      val !== null &&
      typeof val === 'object' &&
      !isExpr(val) &&
      Object.keys(val).length &&
      !scalarArray
    ) {
      flattenLeaves(val, label, [...path, Array.isArray(value) ? Number(key) : key], out);
    } else {
      out.push({ label, value: val, path: [...path, Array.isArray(value) ? Number(key) : key] });
    }
  }
  return out;
}

/**
 * A nested object, two or more levels deep.
 *
 * Indenting each level cost 90px of left margin and stacked the four-level
 * `azureMonitorLogSettings` into 915px of mostly empty rows -- with its
 * deepest four number inputs pushed to x=1326 on a 1280px screen, behind a
 * horizontal scrollbar, unreachable. Depth is information, but it is not
 * worth a column of whitespace per level: the dotted path carries it in the
 * text, where it costs nothing and can be read, copied and searched.
 *
 * So the staircase is flattened into a two-column table. Path on the left at
 * one fixed measure, control on the right at its own content width, zero
 * indentation, one row per leaf.
 */
function pathTable(value, path, ctx) {
  const leaves = flattenLeaves(value, '', path, []);
  return h(
    'div',
    { class: 'paths' },
    h(
      'div',
      { class: 'paths-head' },
      h('span', { class: 'paths-hkey' }, 'Path'),
      h('span', { class: 'paths-hval' }, 'Value')
    ),
    leaves.map((leaf) =>
      h(
        'div',
        { class: 'paths-row' },
        h('code', { class: 'paths-key', title: leaf.label }, leaf.label),
        h('div', { class: 'paths-val' }, renderValue(leaf.value, leaf.path, ctx, null))
      )
    )
  );
}

/**
 * A flat object -- `{ enabled: true, retentionDays: 30 }` -- is a short list of
 * definitions, not a document. Key at one fixed measure, control beside it, no
 * indent and no container.
 */
function objectEditor(value, path, ctx) {
  const keys = Object.entries(value);
  if (!keys.length) return h('p', { class: 'empty' }, 'No properties.');
  if (depthOf(value) > 1) return pathTable(value, path, ctx);

  return h(
    'div',
    { class: 'defs' },
    keys.map(([key, val]) =>
      h(
        'div',
        { class: 'defs-row' },
        h('code', { class: 'defs-key', title: key }, key),
        h('div', { class: 'defs-val' }, renderValue(val, [...path, key], ctx, null))
      )
    )
  );
}

export function renderValue(value, path, ctx, schema, options = null) {
  const kind = typeOf(value);
  if (kind === 'expr') return exprCard(value, path, ctx, schema);
  if (kind === 'array') return arrayEditor(value, path, ctx, schema, options);
  if (kind === 'object') return objectEditor(value, path, ctx);
  // `null` and "no value" are the same fact to the reader, so they get the
  // same row state rather than a second vocabulary for absence.
  if (kind === 'null') {
    const holder = h('div', { class: 'expr expr-empty' });
    holder.append(
      unsetControl(null, () => {
        const ctl = scalarControl('', path, ctx, schema);
        holder.replaceChildren(ctl);
        const focusable = ctl.matches('input, select, textarea')
          ? ctl
          : ctl.querySelector('input, select, textarea');
        if (focusable) focusable.focus();
      })
    );
    return holder;
  }
  if (value === '' && schema && schema.envVar) {
    const holder = h('div', { class: 'expr expr-empty' });
    holder.append(
      unsetControl(schema.envVar, () => {
        const ctl = scalarControl('', path, ctx, schema);
        holder.replaceChildren(ctl);
        const focusable = ctl.querySelector
          ? ctl.querySelector('input, select, textarea') || ctl
          : ctl;
        if (focusable.focus) focusable.focus();
      })
    );
    return holder;
  }
  return scalarControl(value, path, ctx, schema);
}
