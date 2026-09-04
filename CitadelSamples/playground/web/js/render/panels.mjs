/** The four workbench panels. */

import { bullets, chip, disclosure, el, facts, link, linkList, replace, section } from './dom.mjs';

const WIDTH_CLASS = { num: 'ctl-w-num', short: 'ctl-w-short', id: 'ctl-w-id', long: 'ctl-w-long' };

const CLASSIFICATION_LABEL = {
  required: 'required',
  conditional: 'conditional',
  derived: 'derived',
  'sample-default': 'sample default',
  secret: 'secret · memory only',
};

/* --------------------------------------------------------------- guide */

export function renderGuide(panel, guide) {
  replace(panel, [
    section('Purpose', [el('p', { class: 'prose', text: guide.purpose })]),

    section(
      'What it does',
      guide.explanation.map((paragraph) => el('p', { class: 'prose', text: paragraph })),
    ),

    section('Flow', [el('ol', { class: 'flow' }, guide.flow.map((entry) => el('li', { text: entry.text })))]),

    section(
      'Prerequisites',
      guide.prerequisites.length
        ? guide.prerequisites.map((prerequisite) =>
            disclosure(prerequisite.title, [
              el('p', { class: 'prose', text: prerequisite.detail }),
              prerequisite.howTo ? el('p', { class: 'hint', text: `How: ${prerequisite.howTo}` }) : null,
              linkList(prerequisite.links),
            ]),
          )
        : [el('p', { class: 'empty', text: 'None beyond the shared profiles.' })],
      { note: `${guide.prerequisites.length} to satisfy before running` },
    ),

    section(
      'Risk',
      [
        el('div', { class: 'strip-meta' }, [
          chip(guide.risk.badge.label, guide.risk.badge.tone),
          guide.risk.requiresAcknowledgement ? chip('Acknowledgement required', 'warning') : null,
        ]),
        facts([
          ['Effect', guide.risk.effect],
          ['Blast radius', guide.risk.blastRadius],
          ['Reversibility', guide.risk.reversibility],
        ]),
      ],
    ),

    section(
      'Source and deviations',
      [
        facts([
          ['Notebook cells', guide.source.cells.join(', '), { mono: true }],
          ['What the cell does', guide.source.note],
        ]),
        guide.deviations.length
          ? disclosure(`Where this differs from the notebook (${guide.deviations.length})`, [
              bullets(guide.deviations, { warn: true }),
            ])
          : null,
        guide.notes.length ? disclosure(`Notes (${guide.notes.length})`, [bullets(guide.notes)]) : null,
      ],
    ),
  ]);
}

/* ----------------------------------------------------------- configure */

function renderField(field, { onChange, onBlur }) {
  const widthClass = WIDTH_CLASS[field.width] ?? WIDTH_CLASS.id;
  const inputId = `f-${field.path.replace(/[^a-zA-Z0-9-]/g, '-')}`;
  const describedBy = [];
  const invalid = field.errors.length > 0;
  const touch = () => onBlur?.(field.path);

  // `control` is what gets laid out; `ariaTarget` is the focusable widget that
  // carries the programmatic state. For a checkbox they differ: the input is
  // wrapped in a label for hit area, and ARIA on a <label> is not exposed, so
  // aria-describedby / aria-required must land on the input itself.
  let control;
  let ariaTarget = null;
  if (field.type === 'boolean') {
    const box = el('input', {
      class: 'ctl-check',
      type: 'checkbox',
      id: inputId,
      checked: field.value === true,
      'aria-invalid': invalid ? 'true' : undefined,
      onblur: touch,
      onchange: (event) => onChange(field.path, event.target.checked),
    });
    ariaTarget = box;
    control = el('label', { class: 'check' }, [
      box,
      el('span', { text: field.mustEqual === true ? 'Yes — confirmed' : 'Enabled' }),
    ]);
  } else if (field.type === 'enum') {
    control = el(
      'select',
      {
        class: `ctl ${widthClass}`,
        id: inputId,
        'aria-invalid': invalid ? 'true' : undefined,
        onblur: touch,
        onchange: (event) => onChange(field.path, event.target.value),
      },
      field.options.map((option) =>
        el('option', { value: option.value, selected: option.value === field.value, text: option.label }),
      ),
    );
  } else if (field.type === 'multiline') {
    control = el('textarea', {
      class: `ctl ${widthClass}`,
      id: inputId,
      rows: 3,
      value: field.value ?? '',
      'aria-invalid': invalid ? 'true' : undefined,
      onblur: touch,
      oninput: (event) => onChange(field.path, event.target.value),
    });
  } else if (field.type === 'string-list') {
    control = el('textarea', {
      class: `ctl ${widthClass}`,
      id: inputId,
      rows: 2,
      value: Array.isArray(field.value) ? field.value.join('\n') : (field.value ?? ''),
      placeholder: 'One value per line',
      'aria-invalid': invalid ? 'true' : undefined,
      onblur: touch,
      oninput: (event) => onChange(field.path, event.target.value),
    });
  } else if (field.type === 'secret') {
    control = el('input', {
      class: `ctl ${widthClass}`,
      id: inputId,
      type: 'password',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: field.secretSet ? 'Set for this tab only' : 'Paste the minted key',
      'aria-invalid': invalid ? 'true' : undefined,
      onblur: touch,
      oninput: (event) => onChange(field.path, event.target.value),
    });
  } else {
    control = el('input', {
      class: `ctl ${widthClass}${field.type === 'integer' ? ' ctl-num' : ''}`,
      id: inputId,
      type: field.type === 'integer' ? 'number' : 'text',
      inputmode: field.type === 'integer' ? 'numeric' : undefined,
      min: field.min,
      max: field.max,
      spellcheck: 'false',
      autocomplete: 'off',
      placeholder: field.placeholder,
      value: field.value ?? '',
      'aria-invalid': invalid ? 'true' : undefined,
      onblur: touch,
      oninput: (event) => onChange(field.path, event.target.value),
    });
  }

  const helpNodes = [];
  if (field.help) {
    const helpId = `${inputId}-help`;
    describedBy.push(helpId);
    helpNodes.push(el('p', { class: 'prow-help', id: helpId, text: field.help }));
  }
  if (field.classification === 'derived' && field.derivedFrom) {
    helpNodes.push(el('p', { class: 'prow-help', text: field.derivedFrom }));
  }
  if (field.howToObtain) {
    helpNodes.push(el('p', { class: 'prow-help', text: `How to obtain: ${field.howToObtain}` }));
  }
  if (field.secretNote) {
    helpNodes.push(el('p', { class: 'prow-help', text: field.secretNote }));
  }
  if (field.notebookRef) {
    helpNodes.push(el('p', { class: 'prow-help' }, [el('code', { class: 'mono', text: field.notebookRef })]));
  }

  const messages = [];
  for (const [index, message] of field.errors.entries()) {
    const id = `${inputId}-err-${index}`;
    describedBy.push(id);
    messages.push(el('p', { class: 'field-error', id, text: message }));
  }
  for (const [index, message] of field.needed.entries()) {
    const id = `${inputId}-need-${index}`;
    describedBy.push(id);
    messages.push(el('p', { class: 'field-needed', id, text: message }));
  }
  for (const [index, message] of field.warnings.entries()) {
    const id = `${inputId}-warn-${index}`;
    describedBy.push(id);
    messages.push(el('p', { class: 'field-warning', id, text: message }));
  }

  // Programmatic state belongs on the widget, never on its wrapper.
  const aria = ariaTarget ?? control;
  if (describedBy.length) aria.setAttribute('aria-describedby', describedBy.join(' '));
  if (field.pending) aria.setAttribute('data-needed', 'true');
  if (field.classification === 'required' || field.conditional) {
    aria.setAttribute('aria-required', 'true');
  }

  return el('div', { class: 'prow' }, [
    el('div', { class: 'prow-ident' }, [
      el('label', { class: 'prow-label', for: inputId, text: field.label }),
      el('span', {
        class: 'prow-class',
        'data-class': field.classification,
        text: CLASSIFICATION_LABEL[field.classification] ?? field.classification,
      }),
      field.secretSet ? chip('set', 'success') : null,
    ]),
    el('div', { class: 'prow-val' }, [
      control,
      ...messages,
      ...helpNodes,
      field.links?.length
        ? el(
            'p',
            { class: 'prow-links' },
            field.links.map((entry) => link(entry.label, entry.href)),
          )
        : null,
    ]),
  ]);
}

export function renderConfigure(panel, configure, { onChange, onBlur }) {
  const sections = configure.profiles.map((profile) =>
    section(
      profile.title,
      [
        el('p', { class: 'prose', text: profile.summary }),
        el('div', { class: 'prows' }, profile.fields.map((field) => renderField(field, { onChange, onBlur }))),
      ],
      { note: `shared · notebook cell ${profile.sourceCells.join(', ')}` },
    ),
  );

  if (configure.own.fields.length) {
    sections.push(
      section(configure.own.title, [
        el('div', { class: 'prows' }, configure.own.fields.map((field) => renderField(field, { onChange, onBlur }))),
      ]),
    );
  } else {
    sections.push(
      section('Recipe parameters', [
        el('p', { class: 'empty', text: 'This recipe adds no parameters of its own; it uses the shared profiles only.' }),
      ]),
    );
  }

  replace(panel, sections);
}

/* ------------------------------------------------------------- request */

const STEP_TYPE_TONE = {
  artifact: 'cloud',
  'azure-cli': 'brand',
  http: 'brand',
  library: 'warning',
  assertion: 'neutral',
};

export function renderRequest(panel, request, { onCopy, canRun, runBlockedReason, onAcknowledge, acknowledged, onRun, running }) {
  if (!request.available) {
    replace(panel, [
      section('Not generated', [
        el('p', { class: 'prose', text: request.reason }),
        el(
          'ul',
          { class: 'bullets bullets-warn' },
          // One child per list item: `.bullets li` declares two grid tracks, so
          // two children would land the message in a second implicit row.
          request.errors.map((error) =>
            el('li', {}, [
              el('span', {}, [el('code', { class: 'mono', text: error.path }), ` — ${error.message}`]),
            ]),
          ),
        ),
      ]),
    ]);
    return;
  }

  const plan = request.plan;
  const nodes = [
    section(
      'Operation plan',
      [
        el('div', { class: 'strip-meta' }, [
          chip(`${plan.steps.length} steps`, 'neutral', { mono: true }),
          ...plan.requiredStepTypes.map((type) => chip(type, STEP_TYPE_TONE[type] ?? 'neutral', { mono: true })),
          ...plan.secretRefs.map((ref) => chip(`secret: ${ref}`, 'danger', { mono: true })),
        ]),
        el('p', { class: 'prose', text: plan.summary }),
        el('p', {
          class: 'hint',
          text:
            plan.secretRefs.length > 0
              ? 'Credentials appear as environment placeholders. No secret value is written into this preview or into anything copied from it.'
              : 'This plan needs no credential.',
        }),
        el('div', { class: 'runbar' }, [
          el('button', {
            type: 'button',
            class: 'btn btn-sm',
            text: 'Copy the whole plan',
            onclick: () => onCopy(request.fullText),
          }),
        ]),
      ],
    ),
  ];

  nodes.push(
    section(
      'Steps',
      plan.steps.map((planStep, index) =>
        el('article', { class: 'step' }, [
          el('div', { class: 'step-head' }, [
            el('span', { class: 'step-index', text: `${index + 1}/${plan.steps.length}` }),
            el('h3', { class: 'step-title', text: planStep.title }),
            chip(planStep.type, STEP_TYPE_TONE[planStep.type] ?? 'neutral', { mono: true }),
          ]),
          el('p', { class: 'step-detail', text: planStep.detail }),
          planStep.consumes.length
            ? el('p', { class: 'step-binding' }, [`consumes ${planStep.consumes.join(', ')}`])
            : null,
          planStep.produces.length
            ? el('p', { class: 'step-binding' }, [`produces ${planStep.produces.join(', ')}`])
            : null,
          el('pre', { class: 'preview', tabindex: '0', text: request.steps[index].text }),
          el('div', { class: 'runbar' }, [
            el('button', {
              type: 'button',
              class: 'btn btn-sm',
              text: 'Copy step',
              onclick: () => onCopy(request.steps[index].text),
            }),
          ]),
        ]),
      ),
    ),
  );

  if (request.acknowledgement.required) {
    nodes.push(
      el('div', { class: 'ack', 'data-risk': plan.risk.level }, [
        el('p', { class: 'ack-title' }, [chip(plan.risk.level, plan.risk.level === 'destructive' ? 'danger' : 'warning'), 'Acknowledge before running']),
        el('p', { class: 'ack-body', text: plan.risk.acknowledgementPrompt ?? plan.risk.effect }),
        el('label', { class: 'check' }, [
          el('input', {
            class: 'ctl-check',
            type: 'checkbox',
            id: 'ack-check',
            checked: acknowledged,
            onchange: (event) => onAcknowledge(event.target.checked),
          }),
          el('span', { text: 'I understand the effect and I am targeting a non-production environment.' }),
        ]),
        el('p', {
          class: 'hint',
          text: 'This acknowledgement covers one run with exactly these inputs. Changing any input clears it.',
        }),
      ]),
    );
  }

  nodes.push(
    el('div', { class: 'runbar' }, [
      el('button', {
        type: 'button',
        class: 'btn btn-primary',
        id: 'run-button',
        disabled: !canRun || running,
        'aria-busy': running ? 'true' : undefined,
        text: running ? 'Running…' : 'Run this plan',
        onclick: () => onRun(),
      }),
      runBlockedReason ? el('p', { class: 'runbar-reason', text: runBlockedReason }) : null,
    ]),
  );

  if (request.deviations.length) {
    nodes.push(
      section('Where this plan differs from the notebook', [bullets(request.deviations, { warn: true })]),
    );
  }

  replace(panel, nodes);
}

/* ------------------------------------------------------------ response */

const EXPECT_MARK = {
  'not-evaluated': '—',
  passed: 'pass',
  failed: 'fail',
  inconclusive: '?',
};

export function renderResponse(panel, response) {
  replace(panel, [
    section('Result', [
      el('div', { class: 'result', 'data-state': response.state }, [
        el('div', { class: 'result-head' }, [
          chip(response.badge.label, response.badge.tone),
          el('p', { class: 'result-summary', text: response.summary }),
        ]),
        response.detail ? el('p', { class: 'result-detail', text: response.detail }) : null,
      ]),
      el('p', {
        class: 'hint',
        text:
          response.state === 'blocked'
            ? 'Blocked is not a failure and it is not a pass. Nothing was attempted, so nothing is claimed.'
            : 'Every state here is reported from what actually happened. No result is simulated.',
      }),
    ]),

    section(
      'Expected results',
      [
        el(
          'div',
          {},
          response.expected.map((expected) =>
            el('div', { class: 'expect' }, [
              el('span', { class: 'expect-mark', text: EXPECT_MARK[expected.status] ?? '—' }),
              el('h3', { class: 'expect-title', text: expected.title }),
              el('p', { class: 'expect-body', text: expected.assertion }),
              el('p', { class: 'expect-body', text: `Evidence: ${expected.evidence}` }),
              el('p', { class: 'expect-body', text: expected.statusText }),
            ]),
          ),
        ),
      ],
      { note: `${response.expected.length} assertions defined` },
    ),
  ]);
}
