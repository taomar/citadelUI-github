/** The five workbench panels. */

import { bullets, chip, disclosure, el, facts, link, linkList, replace, section } from './dom.mjs';

const WIDTH_CLASS = { num: 'ctl-w-num', short: 'ctl-w-short', id: 'ctl-w-id', long: 'ctl-w-long' };

const REQUIREMENT_LABEL = {
  mandatory: 'Required',
  conditional: 'Conditional',
  optional: 'Default',
  generated: 'Generated / override',
  secret: 'Secret · memory only',
};

/** The group chip tone: only a blocking group is coloured for attention. */
const GROUP_TONE = {
  mandatory: 'warning',
  conditional: 'brand',
  optional: 'neutral',
  generated: 'cloud',
  secret: 'danger',
};

const GROUP_HEADING = {
  mandatory: 'Required inputs',
  conditional: 'Conditional inputs',
  optional: 'Defaults',
  generated: 'Generated overrides',
  secret: 'Credentials',
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

/* ---------------------------------------------------------------- code */

function fieldControlId(path) {
  return `f-${path.replace(/[^a-zA-Z0-9-]/g, '-')}`;
}

function keyedDisclosure(key, summary, children, options) {
  const node = disclosure(summary, children, options);
  node.dataset.disclosureKey = key;
  return node;
}

function inputPlaceholder(value) {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  return text.endsWith('…') ? text : `${text.replace(/\.*$/, '')}…`;
}

function fieldPattern(field) {
  if (field.placeholder) return `Example: ${String(field.placeholder).replace(/…$/, '')}`;
  if (field.type === 'url') return 'Format: HTTPS URL';
  if (field.type === 'integer') {
    if (field.min != null && field.max != null) return `Format: whole number from ${field.min} to ${field.max}`;
    if (field.min != null) return `Format: whole number, ${field.min} or greater`;
    return 'Format: whole number';
  }
  if (field.type === 'string-list') return 'Format: one value per line';
  if (field.type === 'multiline') return 'Format: plain text; line breaks are preserved';
  if (field.type === 'enum') return `Choose: ${field.options.map((option) => option.label).join(', ')}`;
  if (field.type === 'secret') return 'Format: masked credential value';
  return 'Format: text';
}

function renderValidation(validation, { onValidate, onDownload }) {
  const details = [
    el('div', { class: 'strip-meta' }, [
      chip(validation.badge.label, validation.badge.tone),
      chip(validation.evidenceLabel, 'neutral'),
      chip('Python compile only', 'cloud', { mono: true }),
    ]),
    el('p', { class: 'prose', text: validation.summary }),
    el('p', {
      class: 'hint',
      text: 'The validator never executes source, contacts Azure, contacts the network, or produces live evidence.',
    }),
    validation.workspaceRemoved
      ? el('div', { class: 'strip-meta' }, [chip('Temporary workspace removed', 'success')])
      : null,
  ];
  if (validation.checks.length) {
    details.push(
      el(
        'div',
        { class: 'validation-checks' },
        validation.checks.map((check) =>
          el('div', { class: 'validation-check' }, [
            chip(check.passed ? 'Pass' : 'Fail', check.passed ? 'success' : 'danger'),
            el('span', { class: 'validation-check-label', text: check.label }),
            check.detail ? el('span', { class: 'validation-check-detail', text: check.detail }) : null,
          ]),
        ),
      ),
    );
  }
  if (validation.steps.length) {
    details.push(
      el(
        'div',
        { class: 'validation-steps' },
        validation.steps.map((step) =>
          el('div', { class: 'step', 'data-state': step.state }, [
            el('div', { class: 'step-head' }, [
              el('h3', { class: 'step-title', text: step.title }),
              chip(step.state, stateBadgeTone(step.state)),
            ]),
            step.detail ? el('p', { class: 'step-detail', text: step.detail }) : null,
          ]),
        ),
      ),
    );
  }
  if (validation.artifact) {
    details.push(
      el('div', { class: 'validation-artifact' }, [
        el('h3', { class: 'step-title', text: 'Validation report' }),
        facts([
          ['File', validation.artifact.fileName, { mono: true }],
          ['SHA-256', validation.artifact.sha256, { mono: true }],
          ['Bytes', validation.artifact.bytes, { mono: true }],
          ['Retained in workspace', validation.artifact.retainedInWorkspace ? 'Yes' : 'No'],
        ]),
        el('button', {
          type: 'button',
          class: 'btn btn-sm',
          'data-validation-artifact-download': true,
          text: `Download ${validation.artifact.fileName}`,
          onclick: () =>
            onDownload?.(
              validation.artifact.fileName,
              validation.artifact.text,
              validation.artifact.mediaType,
            ),
        }),
      ]),
    );
  }
  details.push(
    el('div', { class: 'runbar' }, [
      el('button', {
        type: 'button',
        class: 'btn btn-primary',
        id: 'validate-source-button',
        disabled: !validation.available || validation.state === 'running',
        'aria-busy': validation.state === 'running' ? 'true' : undefined,
        text:
          validation.state === 'running'
            ? 'Validating…'
            : validation.available
              ? 'Validate protected code offline'
              : 'Local execute mode required',
        onclick: () => onValidate?.(),
      }),
    ]),
  );
  return el(
    'div',
    {
      class: 'validation-boundary',
      'data-validation-mode': validation.validationMode,
      'data-execution-mode': validation.mode,
    },
    details,
  );
}

function stateBadgeTone(state) {
  if (state === 'completed' || state === 'passed') return 'success';
  if (state === 'failed') return 'danger';
  if (state === 'blocked' || state === 'inconclusive') return 'warning';
  return 'neutral';
}

export function renderSource(
  panel,
  source,
  validation,
  configure,
  executionIdentity,
  {
    onRetry,
    onConfigure,
    onValidate,
    onChange,
    onBlur,
    onCopy,
    onDownload,
    onReview,
    onRefreshIdentity,
    onSignIn,
    onCancelLogin,
    onCopyCode,
    wrapSource,
    onToggleWrap,
  } = {},
) {
  const sourceNodes = [];
  if (source.state !== 'ready') {
    sourceNodes.push(
      section(
        '3. Protected code & operation',
        [
          el('div', { class: 'strip-meta' }, [
            chip('Protected code', 'brand'),
            chip('Read only', 'neutral'),
          ]),
          el('p', { class: source.state === 'error' ? 'field-error' : 'prose', text: source.message }),
          source.state === 'error'
            ? el('div', { class: 'runbar' }, [
                el('button', { type: 'button', class: 'btn btn-sm', text: 'Retry source load', onclick: () => onRetry?.() }),
              ])
            : null,
        ],
        { note: 'server-owned' },
      ),
    );
  } else {
    sourceNodes.push(
      section(
        '3. Protected code & operation',
        [
          el('div', { class: 'strip-meta' }, [
            chip('Protected code', 'brand'),
            chip('Read only', 'neutral'),
            chip('Imported notebook', 'cloud'),
          ]),
          el('p', {
            class: 'prose',
            text: 'Review the exact protected cells this recipe uses. The page cannot edit or submit source code.',
          }),
          el('a', {
            class: 'btn btn-primary parameter-jump compact-only',
            href: '#code-parameters',
            text: 'Set identity & parameters',
            onclick: (event) => {
              event.preventDefault();
              const details = document.getElementById('code-parameters');
              const summary = document.getElementById('parameter-pane-summary');
              if (!details || !summary) return;
              details.open = true;
              requestAnimationFrame(() => {
                summary.focus({ preventScroll: true });
                const sheet = document.querySelector('.sheet');
                const sticky = document.querySelector('.sheet-sticky');
                if (!sheet || !sticky) return;
                const offset = summary.getBoundingClientRect().top - sticky.getBoundingClientRect().bottom - 8;
                sheet.scrollTop += offset;
              });
            },
          }),
          el('nav', { class: 'source-tools', 'aria-label': 'Protected source controls' }, [
            el(
              'div',
              { class: 'source-nav' },
              source.cells.map((cell) =>
                el('a', {
                  href: `#source-cell-${cell.cellIndex}`,
                  text: `Cell ${cell.cellIndex}`,
                  onclick: (event) => {
                    event.preventDefault();
                    const target = document.getElementById(`source-cell-${cell.cellIndex}`);
                    const summary = target?.querySelector(':scope > summary');
                    if (!target || !summary) return;
                    target.open = true;
                    requestAnimationFrame(() => {
                      summary.focus({ preventScroll: true });
                      summary.scrollIntoView({ block: 'center' });
                    });
                  },
                }),
              ),
            ),
            el('button', {
              type: 'button',
              class: 'btn btn-sm',
              id: 'source-wrap-toggle',
              'aria-pressed': wrapSource ? 'true' : 'false',
              text: wrapSource ? 'Use horizontal scrolling' : 'Wrap long lines',
              onclick: () => onToggleWrap?.(),
            }),
          ]),
          keyedDisclosure('source-integrity', 'Source integrity', [
            el('p', { class: 'hint', text: source.protection.statement }),
            facts([
              ['Notebook', source.notebook.fileName, { mono: true }],
              ['Notebook SHA-256', source.notebook.sha256, { mono: true }],
              ['Notebook bytes', source.notebook.bytes, { mono: true }],
            ]),
            el('p', {
              class: 'hint',
              text: 'The server selects these cells and verifies the notebook digest before showing them.',
            }),
          ]),
        ],
        { note: `${source.cells.length} cited cell${source.cells.length === 1 ? '' : 's'}` },
      ),
    );

    for (const cell of source.cells) {
      sourceNodes.push(
      el(
        'details',
        {
          class: 'source-cell',
          id: `source-cell-${cell.cellIndex}`,
          open: true,
          'data-disclosure-key': `source-cell-${cell.cellIndex}`,
          'data-source-cell': true,
          'data-cell-index': cell.cellIndex,
          'data-protected': 'true',
          'data-editable': 'false',
        },
        [
          el('summary', { class: 'source-cell-head' }, [
            el('h3', { class: 'source-cell-title', text: `Notebook cell ${cell.cellIndex}` }),
            chip('Protected code', 'brand'),
            chip(cell.cellType, 'neutral', { mono: true }),
            cell.language && cell.language !== cell.cellType ? chip(cell.language, 'cloud', { mono: true }) : null,
          ]),
          el('div', { class: 'source-cell-body' }, [
            facts([
              ['Cell SHA-256', cell.sha256, { mono: true }],
              ['Exact bytes', cell.bytes, { mono: true }],
            ]),
            el('div', { class: 'source-code-frame' }, [
              el(
                'ol',
                { class: 'source-line-numbers', 'aria-hidden': 'true' },
                Array.from({ length: cell.lineCount }, (_, index) => el('li', { text: String(index + 1) })),
              ),
              el(
                'pre',
                {
                  class: 'source-code',
                  'data-source-code': true,
                  tabindex: '0',
                  'aria-label': `Protected source for notebook cell ${cell.cellIndex}`,
                },
                [el('code', { text: cell.text })],
              ),
            ]),
          ]),
        ],
      ),
      );
    }

    sourceNodes.push(
      section(
        'Offline source validation',
        [renderValidation(validation, { onValidate, onDownload })],
        { note: 'not live evidence' },
      ),
    );
  }

  replace(panel, [
    el('div', { class: 'code-workspace' }, [
      el('div', { class: 'code-source', 'data-wrap': wrapSource ? 'true' : 'false' }, sourceNodes),
      renderParameters(configure, executionIdentity, {
        onConfigure,
        onChange,
        onBlur,
        onCopy,
        onDownload,
        onReview,
        onRefreshIdentity,
        onSignIn,
        onCancelLogin,
        onCopyCode,
      }),
    ]),
  ]);
}

/* ----------------------------------------------------------- configure */

function renderField(field, { onChange, onBlur }) {
  const widthClass = WIDTH_CLASS[field.width] ?? WIDTH_CLASS.id;
  const inputId = fieldControlId(field.path);
  const describedBy = [];
  const invalid = field.errors.length > 0;
  // Let the browser complete focus navigation before touched-state rendering
  // replaces the pane, then main.mjs restores the newly focused control.
  const touch = () => setTimeout(() => onBlur?.(field.path), 0);

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
      name: field.path,
      autocomplete: 'off',
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
        name: field.path,
        autocomplete: 'off',
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
      name: field.path,
      rows: 3,
      value: field.value ?? '',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-invalid': invalid ? 'true' : undefined,
      onblur: touch,
      oninput: (event) => onChange(field.path, event.target.value),
    });
  } else if (field.type === 'string-list') {
    control = el('textarea', {
      class: `ctl ${widthClass}`,
      id: inputId,
      name: field.path,
      rows: 2,
      value: Array.isArray(field.value) ? field.value.join('\n') : (field.value ?? ''),
      placeholder: 'One value per line…',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-invalid': invalid ? 'true' : undefined,
      onblur: touch,
      oninput: (event) => onChange(field.path, event.target.value),
    });
  } else if (field.type === 'secret') {
    control = el('input', {
      class: `ctl ${widthClass}`,
      id: inputId,
      name: field.path,
      type: 'password',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: field.secretSet ? 'Set for this tab only…' : 'Paste the minted key…',
      'aria-invalid': invalid ? 'true' : undefined,
      onblur: touch,
      oninput: (event) => onChange(field.path, event.target.value),
    });
  } else {
    control = el('input', {
      class: `ctl ${widthClass}${field.type === 'integer' ? ' ctl-num' : ''}`,
      id: inputId,
      name: field.path,
      type: field.type === 'integer' ? 'number' : field.type === 'url' ? 'url' : 'text',
      inputmode: field.type === 'integer' ? 'numeric' : field.type === 'url' ? 'url' : undefined,
      min: field.min,
      max: field.max,
      spellcheck: 'false',
      autocomplete: 'off',
      placeholder: inputPlaceholder(field.placeholder),
      value: field.value ?? '',
      'aria-invalid': invalid ? 'true' : undefined,
      onblur: touch,
      oninput: (event) => onChange(field.path, event.target.value),
    });
  }

  const purposeId = `${inputId}-purpose`;
  describedBy.push(purposeId);
  const sourceNodes = [];
  sourceNodes.push(el('p', { class: 'prow-help', text: `Shared context: ${field.ownerLabel}.` }));
  if (field.condition) {
    sourceNodes.push(
      el('p', {
        class: 'prow-help',
        text: `Required when ${field.condition.toLowerCase()} ${
          field.conditionActive ? 'That condition holds now.' : 'That condition does not hold now.'
        }`,
      }),
    );
  }
  if (field.fallback) sourceNodes.push(el('p', { class: 'prow-help', text: `If left blank: ${field.fallback}` }));
  if (field.producedBy) sourceNodes.push(el('p', { class: 'prow-help', text: field.producedBy }));
  if (field.help) {
    const helpId = `${inputId}-help`;
    describedBy.push(helpId);
    sourceNodes.push(el('p', { class: 'prow-help', id: helpId, text: field.help }));
  }
  if (field.howToObtain) {
    sourceNodes.push(el('p', { class: 'prow-help', text: field.howToObtain }));
  }
  if (field.secretNote) {
    sourceNodes.push(el('p', { class: 'prow-help', text: field.secretNote }));
  }
  if (field.notebookRef) {
    sourceNodes.push(el('p', { class: 'prow-help' }, [el('code', { class: 'mono', text: field.notebookRef })]));
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
  if (field.requirement === 'mandatory' || (field.requirement === 'conditional' && field.conditionActive)) {
    aria.setAttribute('aria-required', 'true');
  }
  if (field.requirement === 'secret' && field.blocking) {
    aria.setAttribute('aria-required', 'true');
  }

  const status =
    field.errors.length > 0
      ? chip('Needs correction', 'danger')
      : field.blocking
        ? chip('Needed', 'warning')
        : field.supplied || field.secretSet
          ? chip('Ready', 'success')
          : chip('Uses fallback', 'neutral');

  return el('div', {
    class: 'prow',
    'data-requirement': field.requirement,
    'data-parameter-path': field.path,
    'data-parameter-secret': field.requirement === 'secret' ? 'true' : 'false',
  }, [
    el('div', { class: 'prow-head' }, [
      el('label', { class: 'prow-label', for: inputId, text: field.label }),
      el('span', { class: 'prow-badges' }, [
        chip(REQUIREMENT_LABEL[field.requirement] ?? field.requirement, GROUP_TONE[field.requirement] ?? 'neutral'),
        status,
      ]),
    ]),
    el('p', { class: 'prow-purpose', id: purposeId, text: field.requirementReason }),
    el('div', { class: 'prow-val' }, [
      control,
      ...messages,
      el('p', { class: 'prow-pattern', text: fieldPattern(field) }),
      el('details', { class: 'field-source', 'data-disclosure-key': `${inputId}-source` }, [
        el('summary', { id: `${inputId}-source`, text: 'Where do I get this?' }),
        el('div', { class: 'field-source-body' }, [
          ...sourceNodes,
          field.links?.length
            ? el(
                'p',
                { class: 'prow-links' },
                field.links.map((entry, index) =>
                  el('a', {
                    id: `${inputId}-link-${index}`,
                    href: entry.href,
                    target: '_blank',
                    rel: 'noreferrer noopener',
                    text: entry.label,
                  }),
                ),
              )
            : null,
        ]),
      ]),
    ]),
  ]);
}

function renderExecutionIdentity(identity, { onRefreshIdentity, onSignIn, onCancelLogin, onCopyCode }) {
  const details = [
    el('div', { class: 'task-section-head' }, [
      el('h3', { class: 'task-section-title', text: '1. Execution identity & target' }),
      chip(identity.badge.label, identity.badge.tone),
    ]),
    el('p', { class: 'identity-summary', text: identity.summary }),
    facts([
      ['Runs as', identity.runsAs],
      ['Credential source', identity.credentialSource],
      identity.authority?.tenantId ? ['Tenant', identity.authority.tenantId, { mono: true }] : null,
      identity.subscription?.activeName
        ? ['Active subscription', `${identity.subscription.activeName} · ${identity.subscription.activeId}`, { mono: true }]
        : identity.subscription?.activeId
          ? ['Active subscription', identity.subscription.activeId, { mono: true }]
          : null,
      identity.subscription?.configuredId
        ? [
            'Configured subscription',
            `${identity.subscription.configuredId}${
              identity.subscription.matches === true
                ? ' · matches'
                : identity.subscription.matches === false
                  ? ' · does not match'
                  : ''
            }`,
            { mono: true },
          ]
        : null,
      identity.gateway
        ? [
            'Gateway key',
            `${identity.gateway.keyPresent ? 'Present in memory' : 'Missing'} · header ${
              identity.gateway.headerName || 'not configured'
            }`,
            { mono: true },
          ]
        : null,
    ].filter(Boolean)),
  ];

  if (identity.login) {
    details.push(
      el('div', { class: 'device-login', 'data-login-state': identity.login.state }, [
        el('p', { class: 'device-login-message', text: identity.login.message || `Azure sign-in is ${identity.login.state}.` }),
        identity.login.verificationUrl
          ? el('p', { class: 'device-login-link' }, [
              el('a', {
                href: identity.login.verificationUrl,
                target: '_blank',
                rel: 'noreferrer noopener',
                text: 'Open Microsoft device sign-in',
              }),
            ])
          : null,
        identity.login.userCode
          ? el('div', { class: 'device-code' }, [
              el('code', { id: 'azure-device-code', text: identity.login.userCode }),
              el('button', {
                type: 'button',
                class: 'btn btn-sm',
                text: 'Copy device code',
                onclick: () => onCopyCode?.(identity.login.userCode),
              }),
            ])
          : null,
        identity.login.cancelAvailable
          ? el('button', {
              type: 'button',
              class: 'btn btn-sm',
              id: 'cancel-azure-login',
              text: 'Cancel Azure sign-in',
              onclick: () => onCancelLogin?.(),
            })
          : null,
      ]),
    );
  }

  details.push(
    el('div', { class: 'identity-actions' }, [
      identity.canSignIn
        ? el('button', {
            type: 'button',
            class: 'btn btn-primary',
            id: 'start-azure-login',
            text: 'Sign In to Azure',
            onclick: () => onSignIn?.(),
          })
        : null,
      identity.canRefresh
        ? el('button', {
            type: 'button',
            class: 'btn btn-sm',
            id: 'refresh-execution-context',
            'aria-busy': identity.refreshing ? 'true' : undefined,
            'aria-disabled': identity.refreshing ? 'true' : undefined,
            text: identity.refreshing ? 'Checking execution identity…' : 'Refresh execution identity',
            onclick: () => {
              if (!identity.refreshing) onRefreshIdentity?.();
            },
          })
        : null,
    ]),
  );
  if (identity.guarantees.length) {
    details.push(keyedDisclosure('identity-security', 'Security boundary', [bullets(identity.guarantees)]));
  }
  return el('section', { class: 'identity-section', 'data-execution-identity': identity.state }, details);
}

function renderParameterGroup(group, options) {
  return el('section', { class: 'parameter-group', 'data-requirement-group': group.id }, [
    el('div', { class: 'parameter-group-head' }, [
      el('h4', { class: 'parameter-group-title', text: GROUP_HEADING[group.id] ?? group.title }),
      chip(
        group.blockingCount > 0 ? `${group.blockingCount} needed` : `${group.suppliedCount}/${group.count} ready`,
        group.blockingCount > 0 ? 'warning' : GROUP_TONE[group.id] ?? 'neutral',
        { mono: true },
      ),
    ]),
    el('p', { class: 'hint', text: group.summary }),
    el('div', { class: 'prows' }, group.fields.map((field) => renderField(field, options))),
  ]);
}

export function renderParameters(
  configure,
  executionIdentity,
  { onConfigure, onChange, onBlur, onCopy, onDownload, onReview, onRefreshIdentity, onSignIn, onCancelLogin, onCopyCode },
) {
  const ready = configure.blockingCount === 0 && configure.errorCount === 0;
  const readinessLabel = ready
    ? 'Ready'
    : configure.blockingCount > 0
      ? `${configure.blockingCount} needed`
      : `${configure.errorCount} invalid`;
  const primaryGroups = configure.groups.filter((group) => !['optional', 'generated'].includes(group.id));
  const advancedGroups = configure.groups.filter((group) => ['optional', 'generated'].includes(group.id));
  const fieldOptions = { onChange, onBlur };

  const exports = keyedDisclosure('configuration-exports', 'Configuration exports', [
    el('div', { class: 'parameter-actions' }, [
      el('button', {
        type: 'button',
        class: 'btn btn-sm',
        id: 'copy-config',
        text: 'Copy configuration (JSON)',
        onclick: () => onCopy?.(configure.exports.json),
      }),
      el('button', {
        type: 'button',
        class: 'btn btn-sm',
        id: 'download-config',
        text: `Download ${configure.exports.fileNames.json}`,
        onclick: () => onDownload?.(configure.exports.fileNames.json, configure.exports.json, 'application/json'),
      }),
      el('button', {
        type: 'button',
        class: 'btn btn-sm',
        id: 'copy-env',
        text: 'Copy .env.example',
        onclick: () => onCopy?.(configure.exports.env),
      }),
      el('button', {
        type: 'button',
        class: 'btn btn-sm',
        id: 'download-env',
        text: `Download ${configure.exports.fileNames.env}`,
        onclick: () => onDownload?.(configure.exports.fileNames.env, configure.exports.env, 'text/plain'),
      }),
    ]),
    el('p', {
      class: 'hint',
      text:
        configure.exports.secretCount > 0
          ? `${configure.exports.secretCount} credential(s) are exported as environment placeholders only. No secret value is ever written into either file.`
          : 'This sample needs no credential, so the exported environment file is empty by design.',
    }),
  ]);
  exports.querySelector(':scope > summary').id = 'parameter-exports-summary';

  return el('details', {
    class: 'parameter-pane',
    id: 'code-parameters',
    'data-parameter-pane': true,
    'data-state': ready ? 'ready' : 'needs-input',
    open: true,
  }, [
    el('summary', { class: 'parameter-pane-summary', id: 'parameter-pane-summary' }, [
      el('span', { class: 'parameter-pane-heading' }, [
        el('h2', { class: 'parameter-pane-title', text: 'Prepare this run' }),
        el('span', { class: 'parameter-pane-context', text: 'Identity first, then required inputs' }),
      ]),
      chip(
        readinessLabel,
        ready ? 'success' : configure.blockingCount > 0 ? 'warning' : configure.errorCount > 0 ? 'danger' : 'neutral',
      ),
    ]),
    el('div', { class: 'parameter-pane-body' }, [
      renderExecutionIdentity(executionIdentity, {
        onRefreshIdentity,
        onSignIn,
        onCancelLogin,
        onCopyCode,
      }),
      el('section', { class: 'parameters-section', 'aria-labelledby': 'parameters-section-title' }, [
        el('div', { class: 'task-section-head' }, [
          el('h3', { class: 'task-section-title', id: 'parameters-section-title', text: '2. Parameters' }),
          chip(
            readinessLabel,
            ready ? 'success' : configure.blockingCount > 0 ? 'warning' : configure.errorCount > 0 ? 'danger' : 'neutral',
          ),
        ]),
        el('p', {
          class: 'identity-summary',
          text: 'Complete only what this recipe needs. Protected code stays read only.',
        }),
        ...primaryGroups.map((group) => renderParameterGroup(group, fieldOptions)),
        advancedGroups.length
          ? el('details', { class: 'advanced-parameters', 'data-disclosure-key': 'advanced-parameters' }, [
              el('summary', {
                text: `Advanced, defaulted & generated (${advancedGroups.reduce((sum, group) => sum + group.count, 0)})`,
              }),
              el(
                'div',
                { class: 'advanced-parameters-body' },
                advancedGroups.map((group) => renderParameterGroup(group, fieldOptions)),
              ),
            ])
          : null,
      ]),
      exports,
      el('div', { class: 'parameter-review' }, [
        el('p', {
          class: 'hint',
          text: ready
            ? 'Review the exact plan and approve any effect before running.'
            : 'Supply the needed values before reviewing the exact plan.',
        }),
        el('button', {
          type: 'button',
          class: 'btn btn-primary',
          id: 'parameter-review-button',
          text: 'Review exact plan',
          disabled: !ready,
          onclick: () => onReview?.(),
        }),
      ]),
    ]),
  ]);
}

/* ------------------------------------------------------------- request */

const STEP_TYPE_TONE = {
  artifact: 'cloud',
  'azure-cli': 'brand',
  http: 'brand',
  library: 'warning',
  assertion: 'neutral',
};

export function renderRequest(
  panel,
  request,
  { onCopy, canRun, runBlockedReason, onAcknowledge, acknowledged, onRun, onCancel, running, runtime, environment },
) {
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
      'Execution boundary',
      [
        el('div', { class: 'execution-boundary', 'data-execution-mode': environment.mode }, [
          chip(environment.label, environment.liveCapable ? 'success' : 'neutral'),
          chip(environment.evidenceLabel, environment.liveCapable ? 'brand' : 'neutral'),
          el('p', { class: 'prose', text: environment.detail }),
        ]),
      ],
      { note: 'review before approval' },
    ),
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
      el('button', {
        type: 'button',
        class: 'btn btn-sm',
        id: 'cancel-button',
        disabled: !running,
        text: 'Cancel',
        onclick: () => onCancel?.(),
      }),
      runBlockedReason ? el('p', { class: 'runbar-reason', text: runBlockedReason }) : null,
    ]),
  );

  if (runtime) {
    nodes.push(
      section(
        'Runtime for this sample',
        [
          el('div', { class: 'strip-meta' }, [
            chip(
              runtime.state === 'ready' ? 'Local execution ready' : runtime.state === 'partial' ? 'Missing runtime' : 'Preview only',
              runtime.state === 'ready' ? 'success' : runtime.state === 'partial' ? 'warning' : 'neutral',
            ),
          ]),
          el(
            'div',
            {},
            runtime.dependencies.map((dependency) =>
              el('div', { class: 'ctx-row' }, [
                el('span', { class: 'ctx-row-label', text: dependency.label }),
                chip(
                  dependency.optional && dependency.available === false
                    ? 'optional fallback missing'
                    : dependency.available === true
                      ? 'present'
                      : dependency.available === false
                        ? 'missing'
                        : 'unknown',
                  dependency.available === true
                    ? 'success'
                    : dependency.optional
                      ? 'neutral'
                      : dependency.available === false
                        ? 'warning'
                        : 'neutral',
                ),
              ]),
            ),
          ),
          runtime.reasons.length ? bullets(runtime.reasons, { warn: true }) : null,
          runtime.advisories?.length ? bullets(runtime.advisories) : null,
        ],
        { note: `${runtime.dependencies.length} declared` },
      ),
    );
  }

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
  'not-run': '—',
};

export function renderResponse(panel, response) {
  const nodes = [
    section(
      'Execution environment',
      [
        el('div', { class: 'execution-boundary', 'data-execution-mode': response.environment.mode }, [
          chip(response.environment.label, response.environment.liveCapable ? 'success' : 'neutral'),
          chip(response.environment.evidenceLabel, response.environment.liveCapable ? 'brand' : 'neutral'),
          el('p', { class: 'prose', text: response.environment.detail }),
        ]),
      ],
    ),
    section('Result', [
      el('div', {
        class: 'result',
        'data-state': response.state,
        'data-execution-mode': response.environment.mode,
        'data-evidence-mode': response.environment.evidenceMode,
        'aria-live': response.running ? 'polite' : undefined,
      }, [
        el('div', { class: 'result-head' }, [
          chip(response.badge.label, response.badge.tone),
          el('p', { class: 'result-summary', text: response.summary }),
        ]),
        response.detail ? el('p', { class: 'result-detail', text: response.detail }) : null,
        response.runId ? el('p', { class: 'result-detail' }, [el('code', { class: 'mono', text: `run ${response.runId}` })]) : null,
      ]),
      el('p', {
        class: 'hint',
        text:
          response.state === 'blocked'
            ? 'Blocked is not a failure and it is not a pass. Nothing was attempted, so nothing is claimed.'
            : response.state === 'cancelled'
              ? 'Cancelled. Steps that had already run are reported; nothing after the cancellation was attempted.'
              : 'Every state here is reported from what actually happened. No result is simulated.',
      }),
    ]),
  ];

  if (response.steps.length) {
    nodes.push(
      section(
        'Steps',
        response.steps.map((step, index) =>
          el('article', { class: 'step', 'data-state': step.state }, [
            el('div', { class: 'step-head' }, [
              el('span', { class: 'step-index', text: `${index + 1}/${response.steps.length}` }),
              el('h3', { class: 'step-title', text: step.title }),
              chip(step.kind, STEP_TYPE_TONE[step.kind] ?? 'neutral', { mono: true }),
              chip(step.state, step.badge.tone),
              step.durationMs ? chip(`${step.durationMs} ms`, 'neutral', { mono: true }) : null,
            ]),
            step.detail ? el('p', { class: 'step-detail', text: step.detail }) : null,
            step.artifactPath
              ? el('p', { class: 'step-binding' }, ['generated ', el('code', { class: 'mono', text: step.artifactPath })])
              : null,
            step.evidenceLines.length
              ? facts(step.evidenceLines.map((line) => [line.key, line.value, { mono: true }]))
              : null,
          ]),
        ),
        { note: `${response.steps.length} reported` },
      ),
    );
  }

  if (response.configurationUpdates.length || response.secretUpdateCount > 0) {
    nodes.push(
      section(
        'Values this run discovered',
        [
          response.configurationUpdates.length
            ? facts(response.configurationUpdates.map((update) => [update.label, update.value, { mono: true }]))
            : el('p', { class: 'empty', text: 'No public value was discovered.' }),
          response.secretUpdateCount > 0
            ? el('p', {
                class: 'hint',
                text: `${response.secretUpdateCount} credential was returned to this browser tab and held in memory only. Its value is never shown here, logged, or written to disk.`,
              })
            : null,
          response.configurationUpdates.length
            ? el('p', {
                class: 'hint',
                text: 'These are public values only. Apply them to fill in the derived fields the later recipes need.',
              })
            : null,
        ],
        { note: `${response.configurationUpdates.length} public` },
      ),
    );
  }

  if (response.artifacts.length) {
    nodes.push(
      section(
        'Generated files',
        [
          el(
            'ul',
            { class: 'bullets' },
            response.artifacts.map((path) => el('li', {}, [el('code', { class: 'mono', text: path })])),
          ),
          el('p', {
            class: 'hint',
            text: 'Written into this run`s workspace under `playground/.runs/`, which is git-ignored. Nothing is written outside CitadelSamples.',
          }),
        ],
        { note: `${response.artifacts.length} file${response.artifacts.length === 1 ? '' : 's'}` },
      ),
    );
  }

  nodes.push(
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
  );

  replace(panel, nodes);
}
