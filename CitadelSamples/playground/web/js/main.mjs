/**
 * Application bootstrap.
 *
 * Owns: state, capability discovery, tab keyboard behaviour, re-render, and
 * the guarded run action. Everything it renders comes from a pure view model,
 * so the decisions this file makes are about the DOM only.
 */

import { CATALOGUE, acknowledgementFor, buildSamplePlan, fieldByPath, getSample } from '../../src/catalogue/index.mjs';
import { createPlaygroundState } from '../../src/core/state.mjs';
import { createRelayExecutor, createUnavailableExecutor, runPlan } from '../../src/core/executor.mjs';
import { assertNoSecretValues } from '../../src/core/secrets.mjs';
import { buildDirectoryModel, buildWorkbenchModel } from '../../src/view/models.mjs';
import { chip, el, replace } from './render/dom.mjs';
import { renderDirectory, renderSampleSelect } from './render/directory.mjs';
import { renderConfigure, renderGuide, renderRequest, renderResponse } from './render/panels.mjs';
import { renderContext } from './render/context.mjs';

const TABS = ['guide', 'configure', 'request', 'response'];

const nodes = {
  sourceFile: document.getElementById('source-file'),
  sourceHash: document.getElementById('source-hash'),
  capability: document.getElementById('capability'),
  capabilityLabel: document.getElementById('capability-label'),
  directoryGroups: document.getElementById('directory-groups'),
  directoryCount: document.getElementById('directory-count'),
  directorySearch: document.getElementById('directory-search'),
  sampleSelect: document.getElementById('sample-select'),
  title: document.getElementById('sample-title'),
  meta: document.getElementById('sample-meta'),
  summary: document.getElementById('sample-summary'),
  tablist: document.getElementById('tablist'),
  panels: {
    guide: document.getElementById('panel-guide'),
    configure: document.getElementById('panel-configure'),
    request: document.getElementById('panel-request'),
    response: document.getElementById('panel-response'),
  },
  context: document.getElementById('context'),
  contextCompact: document.getElementById('context-compact-body'),
  live: document.getElementById('live'),
};

const state = createPlaygroundState({ catalogue: CATALOGUE });

let executor = createUnavailableExecutor();
let capability = executor.describeCapability();
let results = new Map();
let running = false;

function announce(message) {
  nodes.live.textContent = message;
}

/* ------------------------------------------------------ capability probe */

async function probeCapability() {
  try {
    const response = await fetch('/api/capabilities', { headers: { Accept: 'application/json' } });
    if (!response.ok) return;
    const payload = await response.json();
    if (payload?.executor?.kind === 'relay' && payload.executor.canExecute) {
      executor = createRelayExecutor({
        allowedSampleIds: CATALOGUE.samples.map((sample) => sample.id),
        endpoint: '/api/execute',
        supportedStepTypes: payload.executor.supportedStepTypes ?? ['http'],
      });
    } else {
      executor = createUnavailableExecutor({ reason: payload?.executor?.reason });
    }
    capability = executor.describeCapability();
  } catch {
    // Keep the unavailable executor. A failed probe must never be read as
    // "execution is available".
    capability = executor.describeCapability();
  }
  renderCapability();
  render();
}

function renderCapability() {
  nodes.capability.dataset.canExecute = capability.canExecute ? 'true' : 'false';
  nodes.capabilityLabel.textContent = capability.canExecute
    ? 'Live execution: relay attached'
    : 'Live execution: not configured';
  nodes.capability.title = capability.reason ?? '';
}

/* ---------------------------------------------------------------- tabs */

function renderTabs(model) {
  replace(
    nodes.tablist,
    model.tabs.map((tab) =>
      el(
        'button',
        {
          type: 'button',
          class: 'tab',
          role: 'tab',
          id: `tab-${tab.id}`,
          'aria-selected': tab.id === model.activeTab ? 'true' : 'false',
          'aria-controls': `panel-${tab.id}`,
          tabindex: tab.id === model.activeTab ? '0' : '-1',
          onclick: () => state.setActiveTab(tab.id),
          onkeydown: onTabKeydown,
        },
        [
          tab.label,
          tab.id === 'configure' && tab.count > 0 ? chip(String(tab.count), 'warning', { mono: true }) : null,
          tab.id === 'response' && tab.state !== 'not-run' ? chip(tab.state, 'neutral', { mono: true }) : null,
        ],
      ),
    ),
  );
  for (const id of TABS) {
    nodes.panels[id].hidden = id !== model.activeTab;
  }
}

function onTabKeydown(event) {
  // Roving tabindex with automatic activation: move relative to the tab the
  // key was pressed on, not to whatever happens to be active in the model.
  const fromId = event.currentTarget?.id?.replace(/^tab-/, '');
  const index = TABS.indexOf(fromId);
  if (index < 0) return;
  let next = null;
  if (event.key === 'ArrowRight') next = TABS[(index + 1) % TABS.length];
  else if (event.key === 'ArrowLeft') next = TABS[(index - 1 + TABS.length) % TABS.length];
  else if (event.key === 'Home') next = TABS[0];
  else if (event.key === 'End') next = TABS[TABS.length - 1];
  if (!next) return;
  event.preventDefault();
  state.setActiveTab(next);
  document.getElementById(`tab-${next}`)?.focus();
}

/* ------------------------------------------------------------ actions */

async function copyText(text) {
  // The plan never holds a secret value, and this re-checks before the
  // clipboard ever sees the string.
  try {
    assertNoSecretValues(text, state.secretValues(), 'Copied text');
  } catch {
    announce('Copy refused: the text contained a credential.');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    announce('Copied. Credentials are placeholders, not values.');
  } catch {
    announce('Copy failed. Select the text and copy it manually.');
  }
}

async function runSelected() {
  const sample = getSample(state.selectedSampleId);
  const acknowledged = state.isAcknowledged(sample.id);
  const { plan, validation } = buildSamplePlan(sample, (path) => state.read(path));
  if (!plan) {
    announce('Not run: required inputs are missing.');
    render();
    return;
  }
  running = true;
  render();
  announce(`Running ${sample.title}…`);
  const result = await runPlan(executor, plan, {
    inputs: state.toPersistable(),
    validation,
    acknowledgement: acknowledgementFor(sample, acknowledged),
  });
  // Consent is per run, so it is spent whether or not the run got anywhere.
  state.consumeAcknowledgement(sample.id);
  results.set(sample.id, result);
  running = false;
  render();
  announce(`${sample.title}: ${result.summary}`);
}

/* ------------------------------------------------------------- render */

function render() {
  const directory = buildDirectoryModel({
    query: state.directoryQuery,
    selectedSampleId: state.selectedSampleId,
  });
  renderDirectory({
    container: nodes.directoryGroups,
    countNode: nodes.directoryCount,
    model: directory,
    onSelect: (id) => state.selectSample(id),
  });
  renderSampleSelect({
    select: nodes.sampleSelect,
    model: buildDirectoryModel({ selectedSampleId: state.selectedSampleId }),
    selectedId: state.selectedSampleId,
    onSelect: (id) => state.selectSample(id),
  });

  const sample = getSample(state.selectedSampleId);
  const model = buildWorkbenchModel({
    sample,
    read: (path) => state.read(path),
    hasSecret: (path) => state.hasSecret(path),
    isTouched: (path) => state.isTouched(path),
    secrets: state.secretValues(),
    activeTab: state.activeTab,
    acknowledged: state.isAcknowledged(sample.id),
    result: results.get(sample.id) ?? null,
    capability,
  });

  nodes.title.textContent = model.sample.title;
  nodes.summary.textContent = model.sample.summary;
  replace(nodes.meta, [
    chip(model.sample.groupTitle, 'neutral'),
    chip(model.sample.risk.badge.label, model.sample.risk.badge.tone),
    chip(`cell ${model.sample.sourceCells.join(', ')}`, 'cloud', { mono: true }),
  ]);

  renderTabs(model);
  renderGuide(nodes.panels.guide, model.guide);
  renderConfigure(nodes.panels.configure, model.configure, {
    onChange: (path, value) => state.set(path, value, fieldByPath(path)),
    onBlur: (path) => state.markTouched(path),
  });
  renderRequest(nodes.panels.request, model.request, {
    onCopy: copyText,
    canRun: model.canRun && capability.canExecute && !running,
    runBlockedReason: model.runBlockedReason,
    acknowledged: state.isAcknowledged(sample.id),
    onAcknowledge: (checked) => state.setAcknowledged(sample.id, checked),
    onRun: runSelected,
    running,
  });
  renderResponse(nodes.panels.response, model.response);
  renderContext({ rail: nodes.context, compact: nodes.contextCompact, model: model.context });
}

/* ---------------------------------------------------------------- boot */
nodes.sourceFile.textContent = CATALOGUE.sourceNotebook.fileName;
nodes.sourceHash.textContent = `sha256 ${CATALOGUE.sourceNotebook.sha256}`;
nodes.directorySearch.addEventListener('input', (event) => state.setDirectoryQuery(event.target.value));

state.subscribe((reason) => {
  render();
  if (reason === 'selection') {
    announce(`${getSample(state.selectedSampleId).title} selected.`);
  }
});

renderCapability();
render();
probeCapability();
