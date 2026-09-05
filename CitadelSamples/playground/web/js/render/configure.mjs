/**
 * Signed Run Dossier configure document and protected-source inspector.
 *
 * The DOM-independent contract builders are exported so integration and tests
 * can verify field ownership and selected-cell containment without a browser.
 */

import { bullets, chip, el, linkList, replace } from './dom.mjs';
import { DOSSIER_IDS } from './dossier-contract.mjs';

const GROUP_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'required',
    title: 'Required inputs',
    summary: 'Values this recipe cannot run without.',
    collapsed: false,
  }),
  Object.freeze({
    id: 'conditional',
    title: 'Required for this target',
    summary: 'Conditional values whose requirement is active for the current configuration.',
    collapsed: false,
  }),
  Object.freeze({
    id: 'secret',
    title: 'Credentials for this run',
    summary: 'Credential values stay in memory for this browser tab and are never copied into exports.',
    collapsed: false,
  }),
  Object.freeze({
    id: 'advanced',
    title: 'Defaults, inactive conditions & generated values',
    summary: 'Values with a safe fallback, an inactive condition, or a generated result.',
    collapsed: true,
  }),
]);

const INPUT_TYPE = Object.freeze({
  boolean: 'checkbox',
  enum: 'select',
  integer: 'number',
  multiline: 'textarea',
  secret: 'password',
  'string-list': 'textarea',
  url: 'url',
});

// Presentation only: the catalogue still owns defaults, requirements and values.
const FIELD_PRESENTATION = Object.freeze({
  'hub.subscriptionId': {
    help: 'The intended subscription for this recipe. Entering it does not switch the active CLI subscription.',
  },
  'samples.weather-tools-call.city': {
    primary: true,
    help: 'Mock weather. London returns Celsius; Seattle, New York City and Los Angeles return Fahrenheit.',
  },
});

function list(value) {
  return Array.isArray(value) ? value : [];
}

function text(value, fallback = '') {
  const result = String(value ?? '').trim();
  return result || fallback;
}

export function configureFieldControlId(path) {
  return `f-${String(path).replace(/[^a-zA-Z0-9-]/g, '-')}`;
}

function configureGroupId(field) {
  if (field.requirement === 'mandatory') return 'required';
  if (field.requirement === 'conditional' && field.conditionActive) return 'conditional';
  if (field.requirement === 'secret') return 'secret';
  return 'advanced';
}

function fieldStatus(field) {
  if (list(field.errors).length) return Object.freeze({ label: 'Needs correction', tone: 'danger' });
  if (field.blocking) return Object.freeze({ label: 'Needed', tone: 'warning' });
  if (field.supplied || field.secretSet) return Object.freeze({ label: 'Ready', tone: 'success' });
  if (field.requirement === 'conditional' && !field.conditionActive) {
    return Object.freeze({ label: 'Not required now', tone: 'neutral' });
  }
  return Object.freeze({ label: 'Uses default', tone: 'neutral' });
}

function fieldInputType(field) {
  return INPUT_TYPE[field.type] ?? 'text';
}

/**
 * Build the canonical field order used by renderConfigure.
 *
 * Every declared path must be unique. Failing here is safer than presenting two
 * controls that appear to edit the same value.
 */
export function buildConfigureRenderContract(configure = {}) {
  const buckets = new Map(GROUP_DEFINITIONS.map((group) => [group.id, []]));
  const paths = new Set();

  for (const group of list(configure.groups)) {
    for (const field of list(group.fields)) {
      if (!text(field?.path)) throw new TypeError('Every configure field must have a path.');
      if (paths.has(field.path)) throw new TypeError(`Configure field "${field.path}" was declared more than once.`);
      paths.add(field.path);
      buckets.get(configureGroupId(field)).push(
        Object.freeze({
          ...field,
          controlId: configureFieldControlId(field.path),
          inputType: fieldInputType(field),
          status: fieldStatus(field),
        }),
      );
    }
  }

  const sections = GROUP_DEFINITIONS.map((definition) =>
    Object.freeze({
      ...definition,
      fields: Object.freeze(buckets.get(definition.id)),
    }),
  ).filter((group) => group.fields.length > 0);
  const orderedFields = sections.flatMap((section) => section.fields);
  const firstBlocking = orderedFields.find((field) => field.blocking || list(field.errors).length > 0);

  return Object.freeze({
    sections: Object.freeze(sections),
    fields: Object.freeze(orderedFields),
    fieldCount: orderedFields.length,
    firstBlockingPath: firstBlocking?.path ?? null,
    blockingCount: Number(configure.blockingCount ?? orderedFields.filter((field) => field.blocking).length),
    errorCount: Number(configure.errorCount ?? orderedFields.flatMap((field) => list(field.errors)).length),
    ready:
      Number(configure.blockingCount ?? orderedFields.filter((field) => field.blocking).length) === 0 &&
      Number(configure.errorCount ?? orderedFields.flatMap((field) => list(field.errors)).length) === 0,
  });
}

/**
 * Select exactly one cited cell for the inspector. Navigation changes this
 * selection; it never expands the remaining source cells into the document.
 */
export function buildSourceInspectorContract(source = {}, selectedCellIndex = null) {
  const cells = source.state === 'ready' ? list(source.cells) : [];
  const selected =
    cells.find((cell) => cell.cellIndex === selectedCellIndex) ??
    cells[0] ??
    null;
  const selectedPosition = selected ? cells.findIndex((cell) => cell.cellIndex === selected.cellIndex) : -1;

  return Object.freeze({
    state: text(source.state, 'loading'),
    message: text(source.message),
    protected: source.protected !== false,
    editable: false,
    notebook: source.notebook ?? null,
    protection: source.protection ?? null,
    cellIndexes: Object.freeze(cells.map((cell) => cell.cellIndex)),
    cellCount: cells.length,
    selectedCellIndex: selected?.cellIndex ?? null,
    selectedPosition,
    cells: Object.freeze(selected ? [selected] : []),
  });
}

export function captureFocus(container) {
  const documentRef = container?.ownerDocument;
  const active = documentRef?.activeElement;
  if (!active || !container.contains(active) || !active.id) return null;
  return {
    id: active.id,
    value: active.type === 'password' ? active.value : null,
    selection:
      typeof active.selectionStart === 'number'
        ? { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection }
        : null,
  };
}

export function restoreFocus(container, snapshot) {
  if (!snapshot) return;
  const target = container.ownerDocument?.getElementById(snapshot.id);
  if (!target || !container.contains(target)) return;
  if (snapshot.value !== null && target.type === 'password') target.value = snapshot.value;
  target.focus({ preventScroll: true });
  if (snapshot.selection && typeof target.selectionStart === 'number' && typeof target.setSelectionRange === 'function') {
    target.setSelectionRange(snapshot.selection.start, snapshot.selection.end, snapshot.selection.direction);
  }
}

function heading(level, id, value, className) {
  return el(`h${level}`, { id, class: className, text: value });
}

function identifier(value) {
  return el('code', { class: 'configure-identifier', translate: 'no', text: String(value) });
}

function definitionList(rows, className = '') {
  return el(
    'dl',
    { class: `configure-facts${className ? ` ${className}` : ''}` },
    rows.flatMap(([label, value, options = {}]) => [
      el('dt', { text: label }),
      el('dd', {}, [options.mono ? identifier(value) : String(value)]),
    ]),
  );
}

function renderPrerequisite(prerequisite, index) {
  const titleId = `configure-prerequisite-${index}`;
  return el('li', { class: 'configure-prerequisite', 'aria-labelledby': titleId }, [
    heading(3, titleId, text(prerequisite.title, `Prerequisite ${index + 1}`), 'configure-subtitle'),
    prerequisite.detail ? el('p', { class: 'configure-copy', text: prerequisite.detail }) : null,
    prerequisite.howTo ? el('p', { class: 'configure-help-copy', text: prerequisite.howTo }) : null,
    linkList(prerequisite.links),
  ]);
}

function renderContext(guide = {}) {
  const purposeId = 'configure-purpose-title';
  const contextId = 'configure-context-title';
  const prerequisitesId = 'configure-prerequisites-title';
  const prerequisites = list(guide.prerequisites);
  const explanation = list(guide.explanation);
  const flow = list(guide.flow);

  return el('div', { id: DOSSIER_IDS.context, class: 'configure-context' }, [
    el('section', { class: 'configure-section configure-purpose', 'aria-labelledby': purposeId }, [
      heading(2, purposeId, 'Purpose', 'configure-section-title'),
      el('p', { class: 'configure-purpose-copy', text: text(guide.purpose, text(guide.summary, 'Purpose not reported.')) }),
    ]),
    el('section', { class: 'configure-section', 'aria-labelledby': contextId }, [
      heading(2, contextId, 'Context', 'configure-section-title'),
      ...explanation.map((paragraph) => el('p', { class: 'configure-copy', text: paragraph })),
      flow.length
        ? el(
            'ol',
            { class: 'configure-flow' },
            flow.map((entry, index) =>
              el('li', {}, [
                el('span', { class: 'configure-flow-index', 'aria-hidden': 'true', text: String(index + 1) }),
                el('span', { text: text(entry?.text, entry) }),
              ]),
            ),
          )
        : null,
    ]),
    el('section', { class: 'configure-section', 'aria-labelledby': prerequisitesId }, [
      el('div', { class: 'configure-section-head' }, [
        heading(2, prerequisitesId, 'Prerequisites', 'configure-section-title'),
        chip(`${prerequisites.length} declared`, prerequisites.length ? 'warning' : 'neutral', { mono: true }),
      ]),
      prerequisites.length
        ? el('ul', { class: 'configure-prerequisites' }, prerequisites.map(renderPrerequisite))
        : el('p', { class: 'configure-copy', text: 'No recipe-specific prerequisites are declared.' }),
    ]),
    guide.risk
      ? el('section', { class: 'configure-section configure-risk', 'aria-labelledby': 'configure-risk-title' }, [
          el('div', { class: 'configure-section-head' }, [
            heading(2, 'configure-risk-title', 'Effect & risk', 'configure-section-title'),
            guide.risk.badge ? chip(guide.risk.badge.label, guide.risk.badge.tone) : null,
          ]),
          definitionList(
            [
              ['Effect', guide.risk.effect],
              ['Blast radius', guide.risk.blastRadius],
              ['Reversibility', guide.risk.reversibility],
            ].filter(([, value]) => text(value)),
          ),
        ])
      : null,
  ]);
}

function fieldPattern(field) {
  if (field.placeholder) return `Example: ${String(field.placeholder).replace(/…$/, '')}`;
  if (field.type === 'url') return 'HTTPS URL';
  if (field.type === 'integer') {
    if (field.min != null && field.max != null) return `Whole number from ${field.min} to ${field.max}`;
    if (field.min != null) return `Whole number, ${field.min} or greater`;
    return 'Whole number';
  }
  if (field.type === 'string-list') return 'One value per line';
  if (field.type === 'multiline') return 'Plain text; line breaks are preserved';
  if (field.type === 'enum') return `Choose one of: ${list(field.options).map((option) => option.label).join(', ')}`;
  if (field.type === 'secret') return 'Masked credential value';
  return 'Text';
}

function inputPlaceholder(value) {
  const result = text(value);
  if (!result) return undefined;
  return result.endsWith('…') ? result : `${result.replace(/\.*$/, '')}…`;
}

function operatorMessage(value) {
  return String(value ?? '')
    .replace(/\b(?:[a-z][a-z0-9-]*\.)+[a-z][a-z0-9-]*\b/gi, 'a related setting')
    .replace(/\s+/g, ' ')
    .trim();
}

function cliCommand(field) {
  const match = text(field.howToObtain).match(/`([^`]*(?:az|python|curl)\s+[^`]*)`/i);
  return match?.[1] ?? '';
}

function producerLabel(field) {
  return text(field.producedBy)
    .replace(/^Produced by\s+/i, '')
    .replace(/\s*\(cell\s+\d+\)\.?$/i, '')
    .trim();
}

function producerActionLabel(producer) {
  if (/api management discovery/i.test(producer)) return 'Run APIM discovery';
  if (/discovery/i.test(producer)) return `Run ${producer}`;
  return `Open ${producer}`;
}

function renderAcquisitionHelp(field, callbacks, label = 'Get this value') {
  const producer = producerLabel(field);
  const command = cliCommand(field);
  const technical = [
    field.path ? ['Internal field', field.path] : null,
    field.ownerLabel ? ['Configuration owner', field.ownerLabel] : null,
    field.notebookRef ? ['Protected source reference', field.notebookRef] : null,
  ].filter(Boolean);
  return el('details', { class: 'configure-field-help', 'data-disclosure-key': `${field.controlId}-help` }, [
    el('summary', { id: `${field.controlId}-help-toggle`, text: label }),
    el('div', { class: 'configure-field-help-body' }, [
      producer
        ? el('button', {
            id: `${field.controlId}-producer`,
            type: 'button',
            class: 'btn configure-recovery-action',
            text: producerActionLabel(producer),
            onclick: () => callbacks.onOpenProducer?.(field),
          })
        : null,
      el('button', {
        id: `${field.controlId}-manual`,
        type: 'button',
        class: 'btn configure-manual-action',
        text: 'Enter manually',
        onclick: (event) => {
          event.currentTarget.closest('details')?.removeAttribute('open');
          if (callbacks.onFocusField) callbacks.onFocusField(field.path);
          else event.currentTarget.ownerDocument?.getElementById(field.controlId)?.focus();
        },
      }),
      command
        ? el('details', { class: 'configure-cli-disclosure', 'data-disclosure-key': `${field.controlId}-cli` }, [
            el('summary', { id: `${field.controlId}-cli-toggle`, text: 'Show CLI command' }),
            el('div', { class: 'configure-cli-command' }, [
              el('code', { text: command, translate: 'no' }),
              el('button', {
                id: `${field.controlId}-cli-copy`,
                type: 'button',
                class: 'btn btn-sm',
                text: 'Copy',
                onclick: () => callbacks.onCopy?.(command),
              }),
            ]),
          ])
        : null,
      technical.length || field.help || field.fallback || field.secretNote || list(field.links).length
        ? el('details', { class: 'configure-technical-details', 'data-disclosure-key': `${field.controlId}-technical` }, [
            el('summary', { id: `${field.controlId}-technical-toggle`, text: 'Technical details' }),
            field.requirementReason ? el('p', { class: 'configure-help-copy', text: field.requirementReason }) : null,
            el('p', { class: 'configure-field-pattern', text: fieldPattern(field) }),
            field.help ? el('p', { class: 'configure-help-copy', text: field.help }) : null,
            field.fallback ? el('p', { class: 'configure-help-copy', text: `If left blank: ${field.fallback}` }) : null,
            field.secretNote ? el('p', { class: 'configure-help-copy', text: field.secretNote }) : null,
            technical.length ? definitionList(technical.map(([label, value]) => [label, value, { mono: true }])) : null,
            linkList(field.links),
          ])
        : null,
    ]),
  ]);
}

function renderFieldControl(field, callbacks, describedBy) {
  const common = {
    id: field.controlId,
    name: field.path,
    class: 'ctl configure-field-control configure-focus-target',
    autocomplete: 'off',
    spellcheck: 'false',
    'data-focus-hook': 'configure-field',
    'aria-invalid': list(field.errors).length ? 'true' : undefined,
    'aria-describedby': describedBy.join(' '),
    'aria-required':
      field.requirement === 'mandatory' ||
      (field.requirement === 'conditional' && field.conditionActive) ||
      (field.requirement === 'secret' && field.blocking)
        ? 'true'
        : undefined,
    onblur: (event) => {
      const nextFocusId = event.relatedTarget?.id ?? '';
      setTimeout(() => callbacks.onBlur?.(field.path, nextFocusId), 0);
    },
  };

  if (field.inputType === 'checkbox') {
    return el('input', {
      ...common,
      class: `${common.class} configure-field-checkbox`,
      type: 'checkbox',
      checked: field.value === true,
      onchange: (event) => callbacks.onChange?.(field.path, event.target.checked, { commit: true }),
    });
  }
  if (field.inputType === 'select') {
    return el(
      'select',
      {
        ...common,
        onchange: (event) => callbacks.onChange?.(field.path, event.target.value, { commit: true }),
      },
      list(field.options).map((option) =>
        el('option', {
          value: option.value,
          selected: option.value === field.value,
          text: option.label,
        }),
      ),
    );
  }
  if (field.inputType === 'textarea') {
    return el('textarea', {
      ...common,
      rows: field.type === 'multiline' ? 4 : 3,
      value: field.type === 'string-list' && Array.isArray(field.value) ? field.value.join('\n') : (field.value ?? ''),
      placeholder: field.type === 'string-list' ? 'One value per line…' : inputPlaceholder(field.placeholder),
      oninput: (event) => callbacks.onChange?.(field.path, event.target.value, { commit: false }),
    });
  }

  return el('input', {
    ...common,
    type: field.inputType,
    inputmode: field.inputType === 'number' ? 'numeric' : field.inputType === 'url' ? 'url' : undefined,
    min: field.min,
    max: field.max,
    placeholder:
      field.inputType === 'password'
        ? field.secretSet
          ? 'Set for this tab only…'
          : 'Paste the credential…'
        : inputPlaceholder(field.placeholder),
    value: field.inputType === 'password' ? undefined : (field.value ?? ''),
    oninput: (event) => callbacks.onChange?.(field.path, event.target.value, { commit: false }),
  });
}

function renderField(field, callbacks, { showAcquisition = true } = {}) {
  const reasonId = `${field.controlId}-reason`;
  const errorId = `${field.controlId}-error`;
  const neededId = `${field.controlId}-needed`;
  const warningId = `${field.controlId}-warning`;
  const describedBy = [reasonId];
  const error = list(field.errors).map(operatorMessage).join(' ');
  const needed = field.touched ? list(field.needed).map(operatorMessage).join(' ') : '';
  const warning = list(field.warnings).map(operatorMessage).join(' ');
  if (error) describedBy.push(errorId);
  if (needed) describedBy.push(neededId);
  if (warning) describedBy.push(warningId);
  const control = renderFieldControl(field, callbacks, describedBy);

  return el(
    'div',
    {
      class: 'configure-field',
      'data-parameter-path': field.path,
      'data-parameter-secret': field.inputType === 'password' ? 'true' : 'false',
      'data-requirement': field.requirement,
      'data-field-width': field.type === 'url' ? 'long' : field.width ?? 'id',
    },
    [
      el('div', { class: 'configure-field-head' }, [
        el('div', { class: 'configure-field-identity' }, [
          el('label', { class: 'configure-field-label', for: field.controlId, text: field.label }),
          field.producedBy
            ? el('span', { class: 'configure-field-origin', text: producerLabel(field) })
            : null,
        ]),
      ]),
      field.inputType === 'checkbox'
        ? el('label', { class: 'configure-checkbox' }, [
            control,
            el('span', { text: field.mustEqual === true ? 'Yes — confirmed' : 'Enabled' }),
          ])
        : control,
      el('p', {
        class: 'configure-field-reason',
        id: reasonId,
        text: field.inputType === 'password'
         ? `${field.secretSet ? 'Key present in memory.' : 'Supply the key for this run.'} Kept in this tab only and excluded from exports.`
         : FIELD_PRESENTATION[field.path]?.help ?? field.requirementReason ?? field.help,
      }),
      error ? el('p', { class: 'configure-field-error', id: errorId, role: 'alert', text: error }) : null,
      !error && needed ? el('p', { class: 'configure-field-needed', id: neededId, text: needed }) : null,
      warning ? el('p', { class: 'configure-field-warning', id: warningId, text: warning }) : null,
      showAcquisition ? renderAcquisitionHelp(field, callbacks) : null,
    ],
  );
}

function renderGroup(group, callbacks, { compact = false } = {}) {
  const titleId = `configure-group-${group.id}`;
  const content = [
    !compact ? el('div', { class: 'configure-group-head' }, [
      heading(3, titleId, group.title, 'configure-group-title'),
      chip(`${group.fields.length} field${group.fields.length === 1 ? '' : 's'}`, 'neutral', { mono: true }),
    ]) : null,
    !compact || group.id === 'secret' ? el('p', { class: 'configure-help-copy', text: group.summary }) : null,
    el('div', { class: 'configure-fields' }, group.fields.map((field) => renderField(field, callbacks))),
  ];

  if (group.collapsed) {
    return el(
      'details',
      {
        class: 'configure-group configure-advanced',
        'data-configure-group': group.id,
        'data-disclosure-key': 'configure-advanced',
      },
      [
        el('summary', { id: `${titleId}-toggle` }, [
          el('span', { text: compact ? 'Advanced settings' : group.title }),
        ]),
        el('div', { class: 'configure-advanced-body' }, content.slice(1)),
      ],
    );
  }

  return el(
    'section',
    {
      class: 'configure-group',
      'data-configure-group': group.id,
      'aria-labelledby': compact ? undefined : titleId,
      'aria-label': compact ? group.title : undefined,
    },
    content,
  );
}

function renderExports(configure, callbacks) {
  const exports = configure?.exports;
  if (!exports) return null;
  return el('details', { class: 'configure-exports', 'data-disclosure-key': 'configuration-exports' }, [
    el('summary', { id: 'configure-exports-toggle', text: 'Configuration exports' }),
    el('div', { class: 'configure-export-body' }, [
      el('div', { class: 'configure-actions' }, [
        el('button', {
          id: 'configure-export-copy-json',
          type: 'button',
          class: 'btn btn-sm configure-action',
          text: 'Copy configuration (JSON)',
          onclick: () => callbacks.onCopy?.(exports.json),
        }),
        el('button', {
          id: 'configure-export-download-json',
          type: 'button',
          class: 'btn btn-sm configure-action',
          text: `Download ${exports.fileNames.json}`,
          onclick: () => callbacks.onDownload?.(exports.fileNames.json, exports.json, 'application/json'),
        }),
        el('button', {
          id: 'configure-export-copy-env',
          type: 'button',
          class: 'btn btn-sm configure-action',
          text: 'Copy .env.example',
          onclick: () => callbacks.onCopy?.(exports.env),
        }),
        el('button', {
          id: 'configure-export-download-env',
          type: 'button',
          class: 'btn btn-sm configure-action',
          text: `Download ${exports.fileNames.env}`,
          onclick: () => callbacks.onDownload?.(exports.fileNames.env, exports.env, 'text/plain'),
        }),
      ]),
      el('p', {
        class: 'configure-help-copy',
        text:
          exports.secretCount > 0
            ? `${exports.secretCount} credential placeholder(s) are exported without values.`
            : 'This recipe declares no credential placeholders.',
      }),
    ]),
  ]);
}

function renderEvidenceSummary(source, sourceValidation, callbacks) {
  const ready = source?.state === 'ready';
  const sourceLabel = ready
    ? `${list(source.cells).length} cited cell${list(source.cells).length === 1 ? '' : 's'}`
    : text(source?.state, 'loading');
  const validationLabel = sourceValidation?.badge?.label ?? 'Not run';
  return el('section', { class: 'configure-section configure-evidence', 'aria-labelledby': 'configure-evidence-title' }, [
    el('div', { class: 'configure-section-head' }, [
      heading(2, 'configure-evidence-title', 'Protected evidence', 'configure-section-title'),
      chip(sourceLabel, ready ? 'cloud' : 'neutral', { mono: true }),
    ]),
    el('p', {
      class: 'configure-copy',
      text: 'Source is repository-owned, read only, and inspected separately from the values you can configure.',
    }),
    definitionList([
      ['Source integrity', ready ? 'Verified before display' : text(source?.message, 'Waiting for source')],
      ['Offline validation', validationLabel],
    ]),
    el('button', {
      type: 'button',
      class: 'btn configure-action',
      'aria-controls': DOSSIER_IDS.sourceInspector,
      'data-open-inspector': 'source',
      disabled: !ready && source?.state !== 'error',
      text: ready ? 'Inspect protected source' : source?.state === 'error' ? 'Review source error' : 'Protected source is loading',
      onclick: () => callbacks.onOpenSource?.(source),
    }),
  ]);
}

/**
 * Render the primary configure document.
 *
 * Callbacks: onChange(path, value), onBlur(path), onCopy(text),
 * onDownload(name, text, mediaType), onOpenSource(source), onFocusField(path),
 * and
 * onFocusFirstBlocker(path, control).
 */
export function renderConfigure(
  container,
  {
    guide = {},
    configure = {},
    source = {},
    sourceValidation = {},
    mode = 'all',
    showExports = null,
    action = null,
  } = {},
  callbacks = {},
) {
  const focusSnapshot = captureFocus(container);
  const contract = buildConfigureRenderContract(configure);
  const titleId = 'configure-document-title';

  const showContext = mode === 'all';
  const showInputs =
    mode === 'all'
    || mode === 'account-target'
    || mode === 'required-inputs'
    || mode === 'credentials-options';
  const showEvidence = mode === 'all';
  const shouldShowExports = showExports ?? (mode === 'all' || mode === 'credentials-options');
  const compact = mode !== 'all';
  const advanced = contract.sections.find((group) => group.id === 'advanced');
  const primaryOptions = compact
    ? list(advanced?.fields).filter((field) => FIELD_PRESENTATION[field.path]?.primary)
    : [];
  const primaryPaths = new Set(primaryOptions.map((field) => field.path));
  const hasCoreFields = contract.sections.some((group) => group.id !== 'advanced') || primaryOptions.length > 0;
  const primaryGroups = contract.sections.filter((group) => !compact || group.id !== 'advanced');
  const advancedFields = list(advanced?.fields).filter((field) => !primaryPaths.has(field.path));
  if (compact && advanced && !hasCoreFields) {
    primaryGroups.push({ ...advanced, collapsed: false });
  }

  replace(container, [
    el('article', {
      class: `dossier-configure dossier-configure-${mode}`,
      'aria-labelledby': compact ? 'wizard-step-title' : titleId,
    }, [
      !compact ? el('header', { class: 'configure-header' }, [
        heading(1, titleId, text(guide.title, 'Configure this run'), 'configure-title'),
        guide.summary ? el('p', { class: 'configure-summary', text: guide.summary }) : null,
      ]) : null,
      showContext ? renderContext(guide) : null,
      showInputs ? el('form', {
        id: DOSSIER_IDS.inputs,
        class: 'configure-inputs',
        'aria-label': 'Recipe inputs',
        onsubmit: (event) => event.preventDefault(),
      }, [
        !compact ? el('div', { class: 'configure-inputs-head' }, [
          el('div', {}, [
            heading(2, 'configure-inputs-title', 'Inputs', 'configure-section-title'),
            configure.contractLine
              ? el('p', { class: 'configure-contract-line', text: configure.contractLine })
              : null,
          ]),
          contract.firstBlockingPath
            ? chip(`${contract.blockingCount} needed`, 'danger', { mono: true })
            : chip('Ready to review', contract.ready ? 'success' : 'danger'),
        ]) : null,
        ...primaryGroups.map((group) => renderGroup(group, callbacks, { compact })),
        primaryOptions.length ? el('div', { class: 'configure-fields' }, primaryOptions.map((field) => renderField(field, callbacks, { showAcquisition: false }))) : null,
        action,
        compact && hasCoreFields && advancedFields.length
          ? renderGroup({ ...advanced, fields: advancedFields }, callbacks, { compact })
          : null,
        ...primaryOptions.map((field) => renderAcquisitionHelp(field, callbacks, `${field.label} details`)),
        shouldShowExports
          ? renderExports(configure, callbacks)
          : null,
        !compact ? el('p', {
          class: 'configure-help-copy configure-review-note',
          text: contract.ready
            ? 'Required values are complete.'
            : 'Complete or correct the blocking fields to continue.',
        }) : null,
      ]) : null,
      showEvidence ? renderEvidenceSummary(source, sourceValidation, callbacks) : null,
    ]),
  ]);
  restoreFocus(container, focusSnapshot);
  return contract;
}

function sourceNavigation(container, source, sourceValidation, contract, callbacks) {
  const navigate = (cellIndex) => {
    if (callbacks.onSelectCell) {
      callbacks.onSelectCell(cellIndex);
      return;
    }
    renderSourceInspector(container, source, sourceValidation, { ...callbacks, selectedCellIndex: cellIndex });
  };
  const prior = contract.cellIndexes[contract.selectedPosition - 1];
  const next = contract.cellIndexes[contract.selectedPosition + 1];

  return el('nav', { class: 'source-inspector-nav', 'aria-label': 'Cited notebook cells' }, [
    el('button', {
      type: 'button',
      class: 'btn btn-sm source-cell-nav-button',
      disabled: prior == null,
      text: 'Previous cell',
      onclick: () => navigate(prior),
    }),
    el(
      'ol',
      { class: 'source-cell-indexes' },
      contract.cellIndexes.map((cellIndex) =>
        el('li', {}, [
          el('button', {
            type: 'button',
            id: `source-cell-index-${cellIndex}`,
            class: 'source-cell-index-button source-cell-nav-button',
            'aria-pressed': cellIndex === contract.selectedCellIndex ? 'true' : 'false',
            'aria-label': `Show notebook cell ${cellIndex}`,
            text: `Cell ${cellIndex}`,
            onclick: () => navigate(cellIndex),
          }),
        ]),
      ),
    ),
    el('button', {
      type: 'button',
      class: 'btn btn-sm source-cell-nav-button',
      disabled: next == null,
      text: 'Next cell',
      onclick: () => navigate(next),
    }),
  ]);
}

function renderSelectedSourceCell(cell, wrapSource) {
  if (!cell) return null;
  const effectiveWrap = cell.cellType === 'markdown' || wrapSource;
  const lineCount = Number.isSafeInteger(cell.lineCount)
    ? cell.lineCount
    : cell.text === ''
      ? 0
      : (String(cell.text).match(/\n/g)?.length ?? 0) + 1;
  return el(
    'article',
    {
      class: 'source-selected-cell',
      'data-source-cell': true,
      'data-cell-index': cell.cellIndex,
      'data-protected': 'true',
      'data-editable': 'false',
      'aria-labelledby': 'source-selected-cell-title',
    },
    [
      el('div', { class: 'source-selected-cell-head' }, [
        heading(3, 'source-selected-cell-title', `Notebook cell ${cell.cellIndex}`, 'source-selected-cell-title'),
        chip('Immutable', 'brand'),
        chip(text(cell.cellType, 'source'), 'neutral', { mono: true }),
        cell.language && cell.language !== cell.cellType ? chip(cell.language, 'cloud', { mono: true }) : null,
      ]),
      definitionList([
        ['Cell SHA-256', cell.sha256, { mono: true }],
        ['Exact bytes', cell.bytes, { mono: true }],
      ], 'source-selected-cell-facts'),
      el('div', { class: 'source-inspector-frame', 'data-wrap': effectiveWrap ? 'true' : 'false' }, [
        el(
          'ol',
          { class: 'source-inspector-lines', 'aria-hidden': 'true' },
          Array.from({ length: lineCount }, (_, index) => el('li', { text: String(index + 1) })),
        ),
        el(
          'pre',
          {
            class: 'source-inspector-code',
            tabindex: '0',
            translate: 'no',
            'aria-label': `Protected source for notebook cell ${cell.cellIndex}`,
          },
          [el('code', { translate: 'no', text: cell.text })],
        ),
      ]),
    ],
  );
}

function validationTone(state) {
  if (state === 'passed') return 'success';
  if (state === 'failed') return 'danger';
  if (state === 'blocked') return 'warning';
  return 'neutral';
}

function renderSourceValidation(sourceValidation = {}, callbacks) {
  const checks = list(sourceValidation.checks);
  const steps = list(sourceValidation.steps);
  const artifact = sourceValidation.artifact;
  return el('section', { class: 'source-validation', 'aria-labelledby': 'source-validation-title' }, [
    el('div', { class: 'source-inspector-section-head' }, [
      heading(3, 'source-validation-title', 'Offline source validation', 'source-inspector-section-title'),
      sourceValidation.badge
        ? chip(sourceValidation.badge.label, sourceValidation.badge.tone)
        : chip(text(sourceValidation.state, 'not run'), validationTone(sourceValidation.state)),
    ]),
    el('p', { class: 'configure-copy', text: text(sourceValidation.summary, 'Offline validation has not run.') }),
    el('p', {
      class: 'configure-help-copy',
      text: 'This parser-only check does not execute source, contact Azure, contact the network, or produce live evidence.',
    }),
    checks.length
      ? el(
          'ul',
          { class: 'source-validation-list' },
          checks.map((check) =>
            el('li', {}, [
              chip(check.passed ? 'Pass' : 'Fail', check.passed ? 'success' : 'danger'),
              el('span', {}, [
                el('strong', { text: check.label }),
                check.detail ? el('span', { class: 'configure-help-copy', text: check.detail }) : null,
              ]),
            ]),
          ),
        )
      : null,
    steps.length
      ? el(
          'ol',
          { class: 'source-validation-steps' },
          steps.map((step) =>
            el('li', { 'data-state': step.state }, [
              el('span', {}, [
                el('strong', { text: step.title }),
                step.detail ? el('span', { class: 'configure-help-copy', text: step.detail }) : null,
              ]),
              chip(step.state, validationTone(step.state)),
            ]),
          ),
        )
      : null,
    artifact
      ? el('div', { class: 'source-validation-artifact' }, [
          definitionList([
            ['Report', artifact.fileName, { mono: true }],
            ['SHA-256', artifact.sha256, { mono: true }],
            ['Bytes', artifact.bytes, { mono: true }],
          ]),
          el('button', {
            type: 'button',
            class: 'btn btn-sm configure-action',
            text: `Download ${artifact.fileName}`,
            onclick: () => callbacks.onDownload?.(artifact.fileName, artifact.text, artifact.mediaType),
          }),
        ])
      : null,
    el('button', {
      type: 'button',
      class: 'btn configure-action',
      disabled: sourceValidation.available === false || sourceValidation.state === 'running',
      'aria-busy': sourceValidation.state === 'running' ? 'true' : undefined,
      text:
        sourceValidation.state === 'running'
          ? 'Validating protected source…'
          : sourceValidation.available === false
            ? 'Local validation unavailable'
            : 'Validate protected source offline',
      onclick: () => callbacks.onValidate?.(),
    }),
  ]);
}

/**
 * Render the bounded protected-source inspector.
 *
 * State options live with the callbacks to keep the integration surface small:
 * selectedCellIndex, wrapSource, onSelectCell(index), onToggleWrap(next),
 * onRetry(), onValidate(), onDownload(name, text, mediaType), and onClose().
 */
export function renderSourceInspector(
  dialogOrContainer,
  source = {},
  sourceValidation = {},
  callbacks = {},
) {
  const focusSnapshot = captureFocus(dialogOrContainer);
  const contract = buildSourceInspectorContract(source, callbacks.selectedCellIndex);
  const wrapSource = callbacks.wrapSource === true;
  const isDialog = String(dialogOrContainer.tagName ?? '').toLowerCase() === 'dialog';
  if (!dialogOrContainer.id) dialogOrContainer.id = DOSSIER_IDS.sourceInspector;
  dialogOrContainer.classList?.add('source-inspector');

  const close = () => {
    if (callbacks.onClose) callbacks.onClose();
    else if (isDialog && typeof dialogOrContainer.close === 'function') dialogOrContainer.close();
  };
  const toggleWrap = () => {
    const nextWrap = !wrapSource;
    if (callbacks.onToggleWrap) {
      callbacks.onToggleWrap(nextWrap);
      return;
    }
    renderSourceInspector(dialogOrContainer, source, sourceValidation, { ...callbacks, wrapSource: nextWrap });
  };

  const nodes = [
    el('header', { class: 'source-inspector-header' }, [
      el('div', {}, [
        heading(2, 'source-inspector-title', 'Protected source', 'source-inspector-title'),
        el('p', {
          class: 'configure-help-copy',
          text: 'Inspect one cited repository-owned cell at a time. Source cannot be edited or submitted from this surface.',
        }),
      ]),
      isDialog || callbacks.onClose
        ? el('button', {
            type: 'button',
            class: 'btn btn-sm source-cell-nav-button',
            'aria-label': 'Close protected source inspector',
            text: 'Close',
            onclick: close,
          })
        : null,
    ]),
  ];

  if (contract.state !== 'ready') {
    nodes.push(
      el('section', { class: 'source-inspector-state', 'aria-live': 'polite' }, [
        chip(contract.state === 'error' ? 'Unavailable' : 'Loading', contract.state === 'error' ? 'danger' : 'neutral'),
        el('p', {
          class: contract.state === 'error' ? 'configure-field-error' : 'configure-copy',
          text: contract.message || 'Loading the protected source cited by this recipe.',
        }),
        contract.state === 'error'
          ? el('button', {
              type: 'button',
              class: 'btn configure-action',
              text: 'Retry source load',
              onclick: () => callbacks.onRetry?.(),
            })
          : null,
      ]),
    );
  } else {
    const cell = contract.cells[0];
    const codeCell = cell?.cellType !== 'markdown';
    nodes.push(
      el('div', { class: 'source-inspector-toolbar' }, [
        el('div', { class: 'source-inspector-badges' }, [
          chip('Protected', 'brand'),
          chip('Read only', 'neutral'),
          chip(`${contract.selectedPosition + 1}/${contract.cellCount}`, 'cloud', { mono: true }),
        ]),
        codeCell
          ? el('button', {
              type: 'button',
              class: 'btn btn-sm source-cell-nav-button',
              'aria-pressed': wrapSource ? 'true' : 'false',
              text: wrapSource ? 'Use horizontal scrolling' : 'Wrap long lines',
              onclick: toggleWrap,
            })
          : null,
      ]),
      sourceNavigation(dialogOrContainer, source, sourceValidation, contract, callbacks),
      el('details', { class: 'source-integrity', 'data-disclosure-key': 'source-integrity' }, [
        el('summary', { text: 'Integrity & protection' }),
        el('div', { class: 'source-integrity-body' }, [
          el('p', {
            class: 'configure-copy',
            text: text(contract.protection?.statement, 'The source is repository-owned and verified before display.'),
          }),
          contract.notebook
            ? definitionList([
                ['Notebook', contract.notebook.fileName, { mono: true }],
                ['Notebook SHA-256', contract.notebook.sha256, { mono: true }],
                ['Notebook bytes', contract.notebook.bytes, { mono: true }],
              ])
            : null,
          el('p', {
            class: 'configure-help-copy',
            text: 'The selected cell is immutable. Navigation changes only which cited cell is visible.',
          }),
        ]),
      ]),
      renderSelectedSourceCell(cell, wrapSource),
      renderSourceValidation(sourceValidation, callbacks),
    );
  }

  replace(dialogOrContainer, nodes);
  restoreFocus(dialogOrContainer, focusSnapshot);
  return contract;
}
