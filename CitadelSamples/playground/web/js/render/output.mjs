import { chip, el, replace } from './dom.mjs';
import { DOSSIER_IDS, DOSSIER_OUTPUT_VIEWS } from './dossier-contract.mjs';

const OUTPUT_VIEW_LABELS = Object.freeze({
  transcript: 'Transcript',
  evidence: 'Evidence',
  artifacts: 'Artifacts',
});

const ANNOUNCEMENT_LIMIT = 3;
const TRANSCRIPT_LIMIT = 100;
const TEXT_LIMIT = 2_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_STATES = new Set([
  'not-run',
  'running',
  'blocked',
  'completed',
  'failed',
  'cancelled',
  'inconclusive',
  'passed',
  'skipped',
]);
const SECRET_KEY = /(?:secret|token|password|credential|authorization|cookie|api[-_]?key|client[-_]?secret)/i;
const stateByContainer = new WeakMap();

/**
 * Render the output portion of the signed run dossier.
 *
 * The parent owns page-level navigation and scrolling. `onRevealOutput` is
 * called once when a new exact run starts, and `onFollowTranscript` is called
 * when new transcript content arrives while auto-follow is enabled. Neither
 * hook is implemented with layout reads here.
 */
export function renderOutput(container, responseModel = {}, options = {}) {
  return render(container, responseModel, options, false);
}

function render(container, responseModel, options, internal) {
  if (!container || typeof container.appendChild !== 'function') {
    throw new TypeError('renderOutput requires a DOM container');
  }

  const previous = stateByContainer.get(container) ?? {
    activeView: 'transcript',
    autoFollow: true,
    lastRevealedRunId: null,
    lastTranscriptSignature: '',
    forceFollow: false,
  };
  if (!internal && DOSSIER_OUTPUT_VIEWS.includes(options.activeView)) {
    previous.activeView = options.activeView;
  }
  if (!internal && typeof options.autoFollow === 'boolean') {
    previous.autoFollow = options.autoFollow;
  }

  const hasExpectedRunId =
    options.activeRunId !== undefined &&
    options.activeRunId !== null &&
    options.activeRunId !== '';
  const expectedRunId = identifier(options.activeRunId);
  const suppliedModelRunIds = [responseModel.runId, responseModel.meta?.runId].filter(
    (value) => value !== undefined && value !== null && value !== '',
  );
  const modelRunIds = suppliedModelRunIds.map(identifier);
  const conflictingModelRunIds =
    modelRunIds.some((value) => value === null) ||
    new Set(modelRunIds).size > 1;
  const modelRunId = conflictingModelRunIds ? null : (modelRunIds[0] ?? null);
  const isolated = Boolean(
    conflictingModelRunIds ||
    (hasExpectedRunId && (!expectedRunId || modelRunId !== expectedRunId)),
  );
  const runId = expectedRunId ?? modelRunId;
  const newRunStarted =
    !isolated &&
    responseModel.running === true &&
    Boolean(runId) &&
    previous.lastRevealedRunId !== runId;

  if (newRunStarted) previous.activeView = 'transcript';

  const redactor = createRedactor(responseModel, options.secretValues);
  const context = buildContext(responseModel, options, redactor, isolated, runId);
  previous.responseModel = responseModel;
  previous.options = options;
  if (!previous.mount) {
    previous.mount = createOutputMount(container, previous);
  }
  const { root, summary, tabButtons, panels } = previous.mount;
  root.setAttribute('data-state', context.state);
  root.setAttribute('data-run-isolated', isolated ? 'true' : 'false');
  replace(summary, [
    chip(context.badge.label, context.badge.tone),
    el('p', { class: 'output-summary-text', text: context.summary }),
    context.runId
      ? el('code', {
          class: 'output-run-id',
          translate: 'no',
          text: `run ${context.runId}`,
        })
      : null,
  ]);

  for (const view of DOSSIER_OUTPUT_VIEWS) {
    const active = previous.activeView === view;
    tabButtons.get(view).setAttribute('aria-selected', active ? 'true' : 'false');
    tabButtons.get(view).setAttribute('tabindex', active ? '0' : '-1');
    setHidden(panels.get(view), !active);
  }

  const transcriptLog = renderTranscript(panels.get('transcript'), context, previous, runId);
  renderEvidence(panels.get('evidence'), context);
  renderArtifacts(panels.get('artifacts'), context);

  const transcriptSignature = context.transcriptEntries.map((entry) => entry.key).join('|');
  previous.transcriptLog = transcriptLog;
  previous.lastTranscriptSignature = previous.lastTranscriptSignature ?? '';
  stateByContainer.set(container, previous);

  if (newRunStarted) {
    previous.lastRevealedRunId = runId;
    if (typeof options.onRevealOutput === 'function') {
      options.onRevealOutput({ container, runId, view: 'transcript' });
    }
  }

  const shouldFollow =
    !isolated &&
    previous.activeView === 'transcript' &&
    previous.autoFollow &&
    transcriptLog &&
    Boolean(runId) &&
    (previous.forceFollow || transcriptSignature !== previous.lastTranscriptSignature);
  previous.forceFollow = false;
  previous.lastTranscriptSignature = transcriptSignature;
  if (shouldFollow && typeof options.onFollowTranscript === 'function') {
    options.onFollowTranscript({ container, log: transcriptLog, runId });
  }

  return root;
}

function createOutputMount(container, state) {
  const prefix = 'dossier-output';
  const tabButtons = new Map();
  const panels = new Map();
  const selectView = (view, focusTab = false) => {
    state.activeView = view;
    if (typeof state.options.onViewChange === 'function') state.options.onViewChange(view);
    render(container, state.responseModel, state.options, true);
    if (focusTab) tabButtons.get(view).focus?.();
  };

  const tabs = el(
    'div',
    { class: 'output-tabs', role: 'tablist', 'aria-label': 'Output views' },
    DOSSIER_OUTPUT_VIEWS.map((view) => {
      const button = el('button', {
        class: 'output-tab',
        type: 'button',
        id: `${prefix}-tab-${view}`,
        role: 'tab',
        'aria-controls': `${prefix}-panel-${view}`,
        'aria-selected': 'false',
        tabindex: '-1',
        text: OUTPUT_VIEW_LABELS[view],
        onclick: () => selectView(view, true),
        onkeydown: (event) => {
          const current = DOSSIER_OUTPUT_VIEWS.indexOf(view);
          let target = current;
          if (event.key === 'ArrowRight') target = (current + 1) % DOSSIER_OUTPUT_VIEWS.length;
          else if (event.key === 'ArrowLeft') {
            target = (current - 1 + DOSSIER_OUTPUT_VIEWS.length) % DOSSIER_OUTPUT_VIEWS.length;
          } else if (event.key === 'Home') target = 0;
          else if (event.key === 'End') target = DOSSIER_OUTPUT_VIEWS.length - 1;
          else return;
          event.preventDefault();
          selectView(DOSSIER_OUTPUT_VIEWS[target], true);
        },
      });
      tabButtons.set(view, button);
      return button;
    }),
  );

  const panelNodes = DOSSIER_OUTPUT_VIEWS.map((view) => {
    const panel = el('section', {
      class: `output-panel output-panel-${view}`,
      id: `${prefix}-panel-${view}`,
      role: 'tabpanel',
      'aria-labelledby': `${prefix}-tab-${view}`,
      tabindex: '0',
    });
    panels.set(view, panel);
    return panel;
  });
  const summary = el('div', { class: 'output-summary' });
  const root = el(
    'section',
    {
      id: DOSSIER_IDS.output,
      class: 'output-shell',
      'aria-labelledby': `${prefix}-heading`,
    },
    [
      el('header', { class: 'output-heading' }, [
        el('div', { class: 'output-titleblock' }, [
          el('p', { class: 'output-kicker', text: 'Signed run dossier' }),
          el('h2', { class: 'output-title', id: `${prefix}-heading`, text: 'Output' }),
        ]),
        summary,
      ]),
      tabs,
      ...panelNodes,
    ],
  );
  replace(container, root);
  state.container = container;
  return { root, summary, tabButtons, panels };
}

function buildContext(response, options, redact, isolated, runId) {
  if (isolated) {
    return {
      isolated: true,
      runId,
      state: 'not-run',
      badge: { label: 'Waiting', tone: 'neutral' },
      summary: 'Waiting for output from the active run.',
      detail: '',
      environment: {},
      azureContacted: null,
      liveEvidence: null,
      partial: false,
      timedOut: false,
      steps: [],
      expected: [],
      configurationUpdates: [],
      secretUpdateCount: 0,
      artifacts: [],
      transcriptEntries: [
        {
          key: 'isolated',
          label: 'run',
          state: 'not-run',
          text: 'Waiting for output from the active run.',
        },
      ],
    };
  }

  const state = safeState(response.state);
  const summary = redact(text(response.summary) || defaultSummary(state));
  const detail = redact(text(response.detail));
  const steps = array(response.steps).slice(0, TRANSCRIPT_LIMIT).map((step, index) => projectStep(step, index, redact));
  const partial =
    response.partial === true ||
    response.stream?.partial === true ||
    options.stream?.partial === true ||
    (state === 'cancelled' && steps.length > 0);
  const timedOut =
    response.timedOut === true ||
    response.timeout === true ||
    response.meta?.timedOut === true ||
    steps.some((step) => step.timedOut);
  const sourceEnvironment =
    response.environment && typeof response.environment === 'object' ? response.environment : {};
  const environment = {
    mode: ['hosted-bff', 'hosted-relay', 'local-machine', 'offline-local', 'preview'].includes(sourceEnvironment.mode)
      ? sourceEnvironment.mode
      : '',
    evidenceMode: sourceEnvironment.evidenceMode === 'offline-validation' ? 'offline-validation' : '',
    label: redact(text(sourceEnvironment.label)),
    detail: redact(text(sourceEnvironment.detail)),
  };
  const azureContacted = evidenceFlag(
    options.azureContacted,
    response.azureContacted,
    response.evidence?.azureContacted,
    response.meta?.azureContacted,
    inferOfflineFlag(response, environment),
  );
  const liveEvidence = evidenceFlag(
    options.liveEvidence,
    response.liveEvidence,
    response.evidence?.liveEvidence,
    response.meta?.liveEvidence,
    inferOfflineFlag(response, environment),
  );
  let withheldConfigurationUpdates = 0;
  const configurationUpdates = array(response.configurationUpdates).flatMap((update) => {
    if (secretSemantic(update?.path) || secretSemantic(update?.label)) {
      withheldConfigurationUpdates += 1;
      return [];
    }
    return [{
      label: redact(text(update?.label) || text(update?.path) || 'Public configuration value'),
      path: safeDisplayPath(update?.path, redact),
      value: redact(text(update?.value)),
    }];
  });
  const secretUpdateCount = Math.min(countSecretUpdates(response) + withheldConfigurationUpdates, 1_000);
  const artifacts = authorizedArtifacts(response, options, redact);
  const transcriptEntries = transcript(response, {
    state,
    summary,
    detail,
    partial,
    timedOut,
    steps,
  });

  return {
    isolated: false,
    runId: runId ? redact(runId) : null,
    state,
    badge: badge(response.badge, state, redact),
    summary,
    detail,
    environment,
    gatewayEvidence: environment.mode === 'hosted-bff' && response.credentialType === 'apim-subscription-key',
    azureContacted,
    liveEvidence,
    partial,
    timedOut,
    steps,
    expected: array(response.expected).map((item, index) => projectExpectation(item, index, redact)),
    configurationUpdates,
    secretUpdateCount,
    artifacts,
    transcriptEntries,
  };
}

function renderTranscript(panel, context, state, runId) {
  const pauseLabel = state.autoFollow ? 'Pause' : 'Resume';
  if (!state.transcriptMount) {
    const note = el('p', { class: 'output-toolbar-note' });
    const followButton = el('button', {
      class: 'btn btn-sm output-follow',
      type: 'button',
      onclick: () => {
        state.autoFollow = !state.autoFollow;
        state.forceFollow = state.autoFollow;
        if (typeof state.options.onAutoFollowChange === 'function') {
          state.options.onAutoFollowChange(state.autoFollow);
        }
        render(state.container, state.responseModel, state.options, true);
      },
    });
    const history = el('ol', { class: 'output-transcript-lines', 'aria-live': 'off' });
    const announcements = el('div', {
      class: 'visually-hidden output-announcements',
      'aria-live': 'polite',
      'aria-atomic': 'false',
      'data-announcement-limit': String(ANNOUNCEMENT_LIMIT),
    });
    const log = el('div', {
      class: 'output-console',
      role: 'log',
      'aria-label': 'Run transcript',
      'aria-live': 'polite',
      'aria-relevant': 'additions text',
      'aria-atomic': 'false',
    }, [history, announcements]);
    replace(panel, [
      el('div', { class: 'output-toolbar' }, [note, followButton]),
      log,
    ]);
    state.transcriptMount = { note, followButton, history, announcements, log };
  }
  const { note, followButton, history, announcements, log } = state.transcriptMount;
  note.textContent = state.autoFollow
    ? 'Following new run updates.'
    : 'Auto-follow is paused. New entries remain in the transcript.';
  followButton.setAttribute('aria-pressed', state.autoFollow ? 'true' : 'false');
  followButton.setAttribute('aria-label', `${pauseLabel} transcript auto-follow`);
  followButton.textContent = pauseLabel;

  const visibleEntries = context.transcriptEntries.length
    ? context.transcriptEntries
    : [{ key: 'empty', label: 'run', state: 'not-run', text: 'No transcript entries are available.' }];
  const lines = visibleEntries.slice(-TRANSCRIPT_LIMIT);
  const omitted = visibleEntries.length - lines.length;
  replace(
    history,
    [
      omitted > 0
        ? el('li', {
            class: 'output-transcript-line',
            text: `${omitted} earlier entries are omitted from this bounded transcript.`,
          })
        : null,
      ...lines.map((entry) =>
        el('li', { class: 'output-transcript-line', 'data-state': entry.state }, [
          el('span', {
            class: 'output-transcript-label',
            translate: 'no',
            text: `[${entry.label}]`,
          }),
          el('span', { class: 'output-transcript-text', text: entry.text }),
        ]),
      ),
    ],
  );
  if (state.announcementRunId !== runId) {
    replace(announcements, []);
    state.announcedEntryKeys = new Set();
    state.announcementRunId = runId;
  }
  const announced = state.announcedEntryKeys ?? new Set();
  const newEntries = lines.filter((entry) => !announced.has(entry.key));
  for (const entry of lines) announced.add(entry.key);
  for (const entry of newEntries.slice(-ANNOUNCEMENT_LIMIT)) {
    while (announcements.childNodes.length >= ANNOUNCEMENT_LIMIT) {
      announcements.removeChild(announcements.firstChild);
    }
    announcements.appendChild(el('p', { text: entry.text }));
  }
  state.announcedEntryKeys = announced;
  state.transcriptLog = log;
  return log;
}

function renderEvidence(panel, context) {
  if (context.isolated) {
    replace(panel, empty('No evidence is shown until the active run identity matches.'));
    return;
  }

  const runner = runnerLabel(context.environment);
  const source = evidenceLabel(context);
  const boundaryConflict = hasEvidenceConflict(context);
  const statusNotes = [];
  if (context.state === 'not-run') statusNotes.push('No execution evidence exists because this sample has not run.');
  if (context.state === 'blocked') statusNotes.push('Nothing was attempted; blocked is neither a pass nor a failure.');
  if (context.state === 'cancelled') {
    statusNotes.push('Only steps reported before cancellation are included. Later steps were not attempted.');
  }
  if (context.timedOut) statusNotes.push('A timeout was reported. Any retained evidence may be incomplete.');
  if (context.partial) statusNotes.push('The evidence set is partial and must not be read as a complete run.');
  if (context.azureContacted === null || context.liveEvidence === null) {
    statusNotes.push('The result did not report every required evidence boundary fact.');
  }
  if (boundaryConflict) {
    statusNotes.push('The evidence boundary is inconsistent, so affirmative provenance claims are withheld.');
  }

  const environment = outputSection('Execution environment', [
    el('div', { class: 'output-badges' }, [
      chip(runner, runner === 'Hosted relay' ? 'cloud' : 'neutral'),
      chip(source.label, source.tone),
    ]),
    context.environment.detail
      ? el('p', { class: 'output-prose', text: text(context.environment.detail) })
      : null,
    factList([
      ['Runner', runner],
      ['Evidence source', source.label],
      [context.environment.mode === 'hosted-bff' ? 'ARM contacted' : 'Azure contacted', flagLabel(context.azureContacted, boundaryConflict)],
      ['Live evidence', flagLabel(context.liveEvidence, boundaryConflict)],
    ]),
  ]);

  const result = outputSection('Result state', [
    el('div', { class: 'output-result', 'data-state': context.state }, [
      chip(context.badge.label, context.badge.tone),
      el('p', { class: 'output-result-summary', text: context.summary }),
      context.detail ? el('p', { class: 'output-prose', text: context.detail }) : null,
    ]),
    statusNotes.length
      ? el(
          'ul',
          { class: 'output-notes' },
          statusNotes.map((note) => el('li', { text: note })),
        )
      : null,
  ]);

  const expected = outputSection(
    'Expected assertions',
    context.expected.length
      ? context.expected.map((item) =>
          el('article', { class: 'output-assertion', 'data-state': item.status }, [
            el('div', { class: 'output-assertion-head' }, [
              el('h4', { class: 'output-row-title', text: item.title }),
              chip(item.statusLabel, item.tone),
            ]),
            item.assertion ? el('p', { class: 'output-prose', text: item.assertion }) : null,
            item.evidence ? el('p', { class: 'output-prose', text: `Expected evidence: ${item.evidence}` }) : null,
            el('p', { class: 'output-status-text', text: item.statusText }),
          ]),
        )
      : empty('No expected assertions are declared for this sample.'),
  );

  const stepEvidence = outputSection(
    'Step evidence',
    context.steps.length
      ? context.steps.map((step, index) =>
          el('article', { class: 'output-step', 'data-state': step.state }, [
            el('div', { class: 'output-step-head' }, [
              el('span', { class: 'output-step-index', translate: 'no', text: `${index + 1}/${context.steps.length}` }),
              el('h4', { class: 'output-row-title', text: step.title }),
              chip(step.stateLabel, toneForState(step.state)),
              step.durationMs
                ? el('code', {
                    class: 'output-duration',
                    translate: 'no',
                    text: `${step.durationMs} ms`,
                  })
                : null,
            ]),
            step.detail ? el('p', { class: 'output-prose', text: step.detail }) : null,
            step.evidenceLines.length
              ? factList(step.evidenceLines.map((line) => [line.key, line.value]))
              : null,
            step.withheldEvidenceCount > 0
              ? el('p', {
                  class: 'output-secret-presence',
                  text: `${step.withheldEvidenceCount} secret-bearing evidence field${step.withheldEvidenceCount === 1 ? '' : 's'} withheld.`,
                })
              : null,
            !step.evidenceLines.length && step.withheldEvidenceCount === 0
              ? empty(
                  step.evidenceAvailable
                    ? 'Evidence was reported during streaming; details are available only in the final result.'
                    : 'No public evidence was reported for this step.',
                )
              : null,
          ]),
        )
      : empty('No steps have reported progress or evidence.'),
  );

  replace(panel, [environment, result, expected, stepEvidence]);
}

function renderArtifacts(panel, context) {
  if (context.isolated) {
    replace(panel, empty('No artifacts are shown until the active run identity matches.'));
    return;
  }

  const files = outputSection(
    'Declared run artifacts',
    context.artifacts.length
      ? [
          el(
            'ul',
            { class: 'output-artifact-list' },
            context.artifacts.map((artifact) =>
              el('li', { class: 'output-artifact' }, [
                el('code', {
                  class: 'output-artifact-path',
                  translate: 'no',
                  text: artifact.path,
                }),
                chip(artifact.present === false ? 'Presence not reported' : 'Present', artifact.present === false ? 'neutral' : 'success'),
              ]),
            ),
          ),
          el('p', {
            class: 'output-hint',
            text: 'Only authorized declared paths are listed. File contents are not previewed here.',
          }),
        ]
      : empty('No authorized declared artifacts were reported for this run.'),
  );

  const publicUpdates = outputSection(
    'Public configuration updates',
    context.configurationUpdates.length
      ? [
          factList(
            context.configurationUpdates.map((update) => [
              update.label,
              update.value || 'Present',
              update.path,
            ]),
          ),
          el('p', {
            class: 'output-hint',
            text: 'These values are public configuration only.',
          }),
        ]
      : empty('No public configuration updates were reported.'),
  );

  const secretUpdates = outputSection('Secret updates', [
    context.secretUpdateCount > 0
      ? el('p', {
          class: 'output-secret-presence',
          text: `${context.secretUpdateCount} secret update${context.secretUpdateCount === 1 ? '' : 's'} received. Values and names are not displayed, copied, or previewed.`,
        })
      : empty('No secret updates were reported.'),
  ]);

  replace(panel, [files, publicUpdates, secretUpdates]);
}

function outputSection(title, children) {
  return el('section', { class: 'output-section' }, [
    el('div', { class: 'output-section-head' }, [
      el('h3', { class: 'output-section-title', text: title }),
    ]),
    ...(Array.isArray(children) ? children : [children]),
  ]);
}

function factList(rows) {
  const list = el('dl', { class: 'output-facts' });
  for (const [label, value, path] of rows) {
    list.appendChild(el('dt', { text: label }));
    list.appendChild(
      el('dd', {}, [
        el('code', {
          class: 'output-fact-value',
          translate: 'no',
          text: value,
        }),
        path
          ? el('code', {
              class: 'output-fact-path',
              translate: 'no',
              text: path,
            })
          : null,
      ]),
    );
  }
  return list;
}

function empty(message) {
  return el('p', { class: 'output-empty', text: message });
}

function projectStep(step, index, redact) {
  const state = safeState(step?.state);
  let withheldEvidenceCount = 0;
  const evidenceLines = array(step?.evidenceLines).slice(0, 50).flatMap((line) => {
    if (secretSemantic(line?.key)) {
      withheldEvidenceCount += 1;
      return [];
    }
    const key = redact(text(line?.key));
    const value = redact(text(line?.value));
    return key || value ? [{ key: key || 'Evidence', value: value || 'Present' }] : [];
  });
  const detail = redact(text(step?.detail));
  return {
    id: identifier(step?.id) ?? `step-${index + 1}`,
    title: redact(text(step?.title) || `Step ${index + 1}`),
    kind: redact(identifier(step?.kind) ?? 'step'),
    state,
    stateLabel: redact(text(step?.badge?.label)) || labelForState(state),
    durationMs: duration(step?.durationMs),
    detail,
    evidenceAvailable: step?.evidenceAvailable === true,
    evidenceLines,
    withheldEvidenceCount,
    timedOut: step?.timedOut === true,
  };
}

function projectExpectation(item, index, redact) {
  const status = item?.status === 'not-evaluated' ? 'not-run' : safeState(item?.status);
  return {
    id: identifier(item?.id) ?? `assertion-${index + 1}`,
    title: redact(text(item?.title) || `Assertion ${index + 1}`),
    assertion: redact(text(item?.assertion)),
    evidence: redact(text(item?.evidence)),
    status,
    statusLabel: status === 'not-run' ? 'Not evaluated' : labelForState(status),
    statusText: redact(text(item?.statusText) || 'Not run.'),
    tone: toneForState(status),
  };
}

function transcript(response, context) {
  const entries = [
    {
      key: `summary:${context.state}:${context.summary}`,
      label: context.state === 'running' ? 'run' : 'result',
      state: context.state,
      text: context.summary,
    },
  ];
  if (context.detail) {
    entries.push({
      key: `detail:${context.detail}`,
      label: 'detail',
      state: context.state,
      text: context.detail,
    });
  }
  for (const step of context.steps) {
    const durationText = step.durationMs ? ` in ${step.durationMs} ms` : '';
    entries.push({
      key: `step:${step.id}:${step.state}:${step.durationMs}:${step.detail}`,
      label: step.kind,
      state: step.state,
      text: `${step.title}: ${step.stateLabel}${durationText}.${step.detail ? ` ${step.detail}` : ''}`,
    });
  }
  if (response.running === true && context.steps.length === 0) {
    entries.push({
      key: 'waiting:first-step',
      label: 'run',
      state: 'running',
      text: 'Waiting for the first step to report.',
    });
  }
  if (context.timedOut) {
    entries.push({
      key: 'boundary:timeout',
      label: 'boundary',
      state: 'failed',
      text: 'A timeout was reported. Retained entries may be incomplete.',
    });
  }
  if (context.partial) {
    entries.push({
      key: 'boundary:partial',
      label: 'boundary',
      state: 'inconclusive',
      text: 'Partial evidence only. Do not read this transcript as a complete run.',
    });
  }
  if (context.state === 'cancelled') {
    entries.push({
      key: 'boundary:cancelled',
      label: 'boundary',
      state: 'cancelled',
      text: 'Cancellation was reported. Steps after the last reported entry were not attempted.',
    });
  }
  return entries;
}

function authorizedArtifacts(response, options, redact) {
  const declared = new Set(
    array(options.declaredArtifactPaths)
      .map((entry) => safePath(typeof entry === 'string' ? entry : entry?.path))
      .filter(Boolean),
  );
  const hasAuthorizedList = Array.isArray(options.authorizedArtifactPaths);
  const authorized = new Set(
    array(options.authorizedArtifactPaths)
      .map((entry) => safePath(typeof entry === 'string' ? entry : entry?.path))
      .filter(Boolean),
  );
  const seen = new Set();
  return array(response.artifacts).flatMap((entry) => {
    const objectEntry = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
    const path = safePath(typeof entry === 'string' ? entry : objectEntry?.path);
    if (
      !path ||
      seen.has(path) ||
      !declared.has(path) ||
      (hasAuthorizedList && !authorized.has(path)) ||
      redact(path) !== path
    ) {
      return [];
    }
    seen.add(path);
    return [{ path, present: objectEntry?.present !== false }];
  });
}

function countSecretUpdates(response) {
  if (Number.isInteger(response.secretUpdateCount) && response.secretUpdateCount >= 0) {
    return Math.min(response.secretUpdateCount, 1_000);
  }
  if (response.secretUpdates && typeof response.secretUpdates === 'object' && !Array.isArray(response.secretUpdates)) {
    return Math.min(Object.keys(response.secretUpdates).length, 1_000);
  }
  return 0;
}

function createRedactor(model, supplied = []) {
  const values = new Set();
  collectStrings(supplied, values, 0);
  collectSecretValues(model, '', values, 0);
  const ordered = [...values].sort((left, right) => right.length - left.length);
  return (value) => {
    let output = text(value);
    for (const secret of ordered) {
      output = output.split(secret).join('[redacted]');
    }
    return output;
  };
}

function collectSecretValues(value, key, values, depth) {
  if (depth > 8 || value === null || value === undefined) return;
  if (SECRET_KEY.test(key) && key !== 'secretUpdateCount') {
    collectStrings(value, values, depth);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectSecretValues(entry, key, values, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  const semanticKey = text(value.path) || text(value.key);
  if (secretSemantic(semanticKey) && Object.hasOwn(value, 'value')) {
    collectStrings(value.value, values, depth + 1);
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    collectSecretValues(childValue, childKey, values, depth + 1);
  }
}

function collectStrings(value, values, depth) {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number') {
    const candidate = text(value);
    if (candidate) values.add(candidate);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, values, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const entry of Object.values(value)) collectStrings(entry, values, depth + 1);
  }
}

function inferOfflineFlag(response, environment) {
  const evidenceClass = response.meta?.evidenceClass;
  if (
    response.state === 'not-run' ||
    response.state === 'blocked' ||
    evidenceClass === 'offline' ||
    evidenceClass === 'preview' ||
    environment.mode === 'offline-local' ||
    environment.mode === 'preview'
  ) {
    return false;
  }
  return undefined;
}

function evidenceFlag(...candidates) {
  for (const candidate of candidates) {
    if (candidate === true || candidate === false) return candidate;
  }
  return null;
}

function evidenceLabel(context) {
  if (hasEvidenceConflict(context)) {
    return { label: 'Evidence boundary conflict', tone: 'danger' };
  }
  if (context.state === 'not-run' || context.state === 'blocked') {
    return { label: 'Not run', tone: 'neutral' };
  }
  if (context.liveEvidence === true && context.azureContacted === true) {
    return { label: 'Live target evidence', tone: 'cloud' };
  }
  if (context.liveEvidence === true && context.azureContacted === false) {
    if (context.gatewayEvidence) return { label: 'Live gateway evidence', tone: 'cloud' };
    return { label: 'Evidence boundary conflict', tone: 'danger' };
  }
  if (
    context.liveEvidence === false &&
    context.azureContacted === false &&
    (context.environment.mode === 'offline-local' || context.environment.evidenceMode === 'offline-validation')
  ) {
    return { label: 'Local checkout evidence', tone: 'neutral' };
  }
  if (context.state === 'running') return { label: 'Evidence pending', tone: 'brand' };
  return { label: 'Evidence not reported', tone: 'warning' };
}

function runnerLabel(environment) {
  if (environment.mode === 'hosted-relay') return 'Hosted relay';
  if (environment.mode === 'hosted-bff') return 'Hosted HTTPS';
  if (environment.mode === 'local-machine') return 'Local operator';
  if (environment.mode === 'offline-local') return 'Offline self-test';
  if (environment.mode === 'preview') return 'Preview only';
  return text(environment.label) || 'Runner not reported';
}

function flagLabel(value, conflict = false) {
  if (conflict && value === true) return 'Conflicting report';
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  return 'Not reported';
}

function badge(input, state, redact) {
  return {
    label: redact(text(input?.label) || labelForState(state)),
    tone: ['neutral', 'brand', 'cloud', 'success', 'warning', 'danger'].includes(input?.tone)
      ? input.tone
      : toneForState(state),
  };
}

function toneForState(state) {
  if (state === 'completed' || state === 'passed') return 'success';
  if (state === 'failed') return 'danger';
  if (state === 'running') return 'brand';
  if (state === 'blocked' || state === 'inconclusive') return 'warning';
  return 'neutral';
}

function labelForState(state) {
  if (state === 'not-run') return 'Not run';
  return `${state.slice(0, 1).toUpperCase()}${state.slice(1)}`;
}

function safeState(value) {
  return SAFE_STATES.has(value) ? value : 'inconclusive';
}

function defaultSummary(state) {
  if (state === 'running') return 'Starting the approved run.';
  if (state === 'completed') return 'Run complete.';
  if (state === 'failed') return 'Run failed.';
  if (state === 'cancelled') return 'Run cancelled.';
  if (state === 'blocked') return 'Run blocked.';
  if (state === 'passed') return 'Validation passed.';
  if (state === 'inconclusive') return 'Run inconclusive.';
  return 'No run has started.';
}

function identifier(value) {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : null;
}

function safePath(value) {
  const candidate = text(value).replaceAll('\\', '/').trim();
  if (!candidate || candidate.startsWith('/') || /^[A-Za-z]:\//.test(candidate)) return '';
  const segments = candidate.split('/');
  if (segments.includes('..') || segments.includes('') || segments.includes('.')) return '';
  return candidate;
}

function safeDisplayPath(value, redact) {
  const path = safePath(value);
  return path && redact(path) === path ? path : '';
}

function secretSemantic(value) {
  return SECRET_KEY.test(text(value));
}

function hasEvidenceConflict(context) {
  const affirmative = context.azureContacted === true || context.liveEvidence === true;
  const noExecutionState = context.state === 'not-run' || context.state === 'blocked';
  const offlineEnvironment =
    context.environment.mode === 'offline-local' ||
    context.environment.mode === 'preview' ||
    context.environment.evidenceMode === 'offline-validation';
  return (
    (context.liveEvidence === true && context.azureContacted !== true && !context.gatewayEvidence) ||
    (affirmative && (noExecutionState || offlineEnvironment))
  );
}

function setHidden(node, hidden) {
  if (hidden) node.setAttribute('hidden', '');
  else node.removeAttribute('hidden');
}

function duration(value) {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), 86_400_000) : 0;
}

function text(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .slice(0, TEXT_LIMIT);
}

function array(value) {
  return Array.isArray(value) ? value : [];
}
