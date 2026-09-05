import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderOutput } from '../web/js/render/output.mjs';

const OUTPUT_SOURCE = fileURLToPath(new URL('../web/js/render/output.mjs', import.meta.url));
const OUTPUT_CSS = fileURLToPath(new URL('../web/css/output.css', import.meta.url));
const outputSource = await readFile(OUTPUT_SOURCE, 'utf8');
const outputCss = await readFile(OUTPUT_CSS, 'utf8');

class FakeNode {
  constructor(tagName = '', text = '') {
    this.tagName = tagName;
    this.nodeType = tagName ? 1 : 3;
    this.attributes = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.className = '';
    this.dataset = {};
    this.listeners = new Map();
    this._text = text;
  }

  set textContent(value) {
    this._text = String(value ?? '');
    this.childNodes = [];
  }

  get textContent() {
    if (this.nodeType === 3) return this._text;
    return `${this._text}${this.childNodes.map((child) => child.textContent).join('')}`;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  dispatch(type, fields = {}) {
    let prevented = false;
    this.listeners.get(type)?.({
      preventDefault: () => {
        prevented = true;
      },
      ...fields,
    });
    return prevented;
  }

  focus() {
    fakeDocument.activeElement = this;
  }
}

const fakeDocument = {
  activeElement: null,
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (text) => new FakeNode('', text),
};

globalThis.document = fakeDocument;

function findAll(node, predicate, matches = []) {
  if (predicate(node)) matches.push(node);
  for (const child of node.childNodes) findAll(child, predicate, matches);
  return matches;
}

function byRole(node, role) {
  return findAll(node, (candidate) => candidate.attributes?.get('role') === role);
}

function byClass(node, className) {
  return findAll(node, (candidate) => candidate.className?.split(/\s+/).includes(className));
}

function serialize(node) {
  if (node.nodeType === 3) return node.textContent;
  const attributes = [
    ...(node.className ? [['class', node.className]] : []),
    ...node.attributes.entries(),
    ...Object.entries(node.dataset).map(([key, value]) => [`data-${key}`, value]),
  ]
    .map(([key, value]) => `${key}="${String(value)}"`)
    .join(' ');
  return `<${node.tagName}${attributes ? ` ${attributes}` : ''}>${node._text}${node.childNodes.map(serialize).join('')}</${node.tagName}>`;
}

function baseModel(overrides = {}) {
  return {
    state: 'running',
    running: true,
    runId: 'run-0001',
    badge: { label: 'Running', tone: 'brand' },
    summary: 'Starting the approved run.',
    detail: '',
    environment: {
      mode: 'local-machine',
      label: 'Local machine',
      evidenceMode: 'live-capable',
      evidenceLabel: 'Live-capable',
      detail: 'The local operator is running the approved plan.',
    },
    azureContacted: false,
    liveEvidence: false,
    steps: [],
    expected: [],
    artifacts: [],
    configurationUpdates: [],
    secretUpdateCount: 0,
    ...overrides,
  };
}

test('the Output contract contains only Transcript, Evidence, and Artifacts with roving tabs', () => {
  const container = new FakeNode('div');
  renderOutput(container, baseModel());

  assert.equal(container.childNodes[0].attributes.get('id'), 'dossier-output');
  const tablists = byRole(container, 'tablist');
  const tabs = byRole(container, 'tab');
  const panels = byRole(container, 'tabpanel');
  assert.equal(tablists.length, 1);
  assert.deepEqual(tabs.map((tab) => tab.textContent), ['Transcript', 'Evidence', 'Artifacts']);
  assert.deepEqual(tabs.map((tab) => tab.attributes.get('tabindex')), ['0', '-1', '-1']);
  assert.deepEqual(tabs.map((tab) => tab.attributes.get('aria-selected')), ['true', 'false', 'false']);
  assert.equal(panels.length, 3);

  assert.equal(tabs[0].dispatch('keydown', { key: 'ArrowRight' }), true);
  const rerenderedTabs = byRole(container, 'tab');
  assert.deepEqual(rerenderedTabs.map((tab) => tab.attributes.get('tabindex')), ['-1', '0', '-1']);
  assert.equal(fakeDocument.activeElement.textContent, 'Evidence');
});

test('hosted entered-key gateway evidence does not pretend that ARM was contacted', () => {
  const container = new FakeNode('div');
  renderOutput(container, baseModel({ state: 'completed', credentialType: 'apim-subscription-key',
    environment: { mode: 'hosted-bff', label: 'Hosted HTTPS' }, azureContacted: false, liveEvidence: true }));
  assert.match(container.textContent, /Live gateway evidence/);
  assert.match(container.textContent, /ARM contacted/);
  assert.doesNotMatch(container.textContent, /Evidence boundary conflict/);
  const unproven = new FakeNode('div');
  renderOutput(unproven, baseModel({ state: 'completed',
    environment: { mode: 'hosted-bff', label: 'Hosted HTTPS' }, azureContacted: false, liveEvidence: true }));
  assert.match(unproven.textContent, /Evidence boundary conflict/);
});

test('the transcript is a bounded polite log with parent-owned reveal and follow hooks', () => {
  const container = new FakeNode('div');
  const revealed = [];
  const followed = [];
  renderOutput(
    container,
    baseModel({
      steps: Array.from({ length: 8 }, (_, index) => ({
        id: `step-${index}`,
        kind: 'http',
        title: `Step ${index}`,
        state: 'completed',
        detail: `Finished ${index}`,
        badge: { label: 'Completed', tone: 'success' },
        evidenceLines: [],
      })),
    }),
    {
      activeRunId: 'run-0001',
      onRevealOutput: (event) => revealed.push(event),
      onFollowTranscript: (event) => followed.push(event),
    },
  );

  const logs = byRole(container, 'log');
  const originalPanels = byRole(container, 'tabpanel');
  const announcements = byClass(container, 'output-announcements');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].attributes.get('aria-live'), 'polite');
  assert.equal(announcements[0].attributes.get('data-announcement-limit'), '3');
  assert.equal(announcements[0].childNodes.length, 3);
  assert.equal(revealed.length, 1);
  assert.equal(revealed[0].view, 'transcript');
  assert.equal(followed.length, 1);
  assert.ok(!/scrollHeight|getBoundingClientRect|offsetHeight|clientHeight/.test(outputSource));

  const pause = byClass(container, 'output-follow')[0];
  assert.equal(pause.textContent, 'Pause');
  pause.focus();
  pause.dispatch('click');
  const resume = byClass(container, 'output-follow')[0];
  assert.equal(resume.textContent, 'Resume');
  assert.equal(fakeDocument.activeElement, resume);

  renderOutput(
    container,
    baseModel({
      steps: [{ id: 'later', kind: 'assertion', title: 'Later step', state: 'running', evidenceLines: [] }],
    }),
    { activeRunId: 'run-0001' },
  );
  assert.equal(byRole(container, 'log')[0], logs[0], 'the live log must survive streaming rerenders');
  assert.deepEqual(byRole(container, 'tabpanel'), originalPanels, 'focusable panels must remain mounted');
  assert.ok(byClass(container, 'output-announcements')[0].childNodes.length <= 3);
});

test('secret-bearing fields and duplicated secret values never reach text, markup, or attributes', () => {
  const marker = 'CITADEL-SECRET-MARKER';
  const container = new FakeNode('div');
  renderOutput(
    container,
    baseModel({
      state: 'completed',
      running: false,
      summary: `Completed with ${marker}; record=xy`,
      detail: `Do not echo ${marker}`,
      secretUpdates: { apiKey: marker, accessToken: marker, shortCredential: 'ab' },
      secretUpdateCount: 3,
      credential: { password: marker },
      environment: {
        mode: 'local-machine',
        label: `Local ${marker}`,
        detail: `Environment ${marker}`,
      },
      steps: [
        {
          id: 'safe-step',
          title: 'Safe step',
          state: 'completed',
          detail: `Redact ${marker}`,
          badge: { label: 'Completed', tone: 'success' },
          evidence: { apiKey: marker },
          evidenceLines: [
            { key: 'status', value: `redacted ${marker}` },
            { key: 'keySecretName', value: 'vault-secret-name' },
          ],
        },
      ],
      artifacts: [{ path: 'artifacts/result.json', declared: true, authorized: true, preview: marker }],
      configurationUpdates: [
        { path: 'hub.endpoint', label: 'Endpoint', value: `https://${marker}.example/value=ab` },
        { path: 'keyVault.keySecretName', label: 'Actual key secret name', value: 'vault-secret-name' },
      ],
    }),
    { secretValues: { transient: 'xy' } },
  );

  const markup = serialize(container);
  assert.ok(!markup.includes(marker), markup);
  assert.ok(!markup.includes('value=ab'), markup);
  assert.ok(!markup.includes('record=xy'), markup);
  assert.ok(!markup.includes('vault-secret-name'), markup);
  assert.ok(!markup.includes('keySecretName'), markup);
  assert.ok(!markup.includes('result.json'), markup);
  assert.match(markup, /\[redacted\]/);
  assert.match(markup, /4 secret updates received/);
  assert.match(markup, /1 secret-bearing evidence field withheld/);
  assert.ok(!markup.includes('apiKey'));
  assert.ok(!markup.includes('accessToken'));

  const zeroContainer = new FakeNode('div');
  renderOutput(
    zeroContainer,
    baseModel({
      runId: 'run-0010',
      summary: 'Protocol 2 completed with 0 secret updates.',
      secretUpdateCount: 0,
    }),
    { activeRunId: 'run-0010' },
  );
  const zeroMarkup = serialize(zeroContainer);
  assert.match(zeroMarkup, /run-0010/);
  assert.match(zeroMarkup, /Protocol 2 completed with 0 secret updates/);
  assert.ok(!zeroMarkup.includes('run-[redacted]'));

  const numericSecretContainer = new FakeNode('div');
  renderOutput(
    numericSecretContainer,
    baseModel({
      summary: 'PIN 123456 was accepted.',
      credential: { password: 123456 },
    }),
  );
  assert.doesNotMatch(serialize(numericSecretContainer), /123456/);
});

test('not-evaluated assertions remain not evaluated rather than becoming inconclusive', () => {
  const container = new FakeNode('div');
  renderOutput(
    container,
    baseModel({
      state: 'not-run',
      running: false,
      expected: [
        {
          id: 'expected',
          title: 'Expected result',
          status: 'not-evaluated',
          statusText: 'Not run.',
        },
      ],
    }),
    { activeView: 'evidence' },
  );

  const markup = serialize(container);
  assert.match(markup, /Not evaluated/);
  assert.ok(!markup.includes('Inconclusive'));
});

test('timeout and live evidence claims require structured, consistent facts', () => {
  const container = new FakeNode('div');
  renderOutput(
    container,
    baseModel({
      state: 'completed',
      running: false,
      summary: 'Completed before timeout.',
      timedOut: false,
      azureContacted: false,
      liveEvidence: true,
    }),
    { activeView: 'evidence' },
  );

  const markup = serialize(container);
  assert.ok(!markup.includes('A timeout was reported'));
  assert.match(markup, /Evidence boundary conflict/);
  assert.match(markup, /affirmative provenance claims are withheld/);
  assert.match(markup, /Conflicting report/);
  assert.ok(!markup.includes('Live target evidence'));
});

test('cancellation, timeout, partial evidence, and authorized artifacts map honestly', () => {
  const container = new FakeNode('div');
  renderOutput(
    container,
    baseModel({
      state: 'cancelled',
      running: false,
      summary: 'Cancelled after the request timed out.',
      timedOut: true,
      stream: { partial: true },
      environment: {
        mode: 'hosted-relay',
        detail: 'The approved hosted relay handled this run.',
      },
      azureContacted: true,
      liveEvidence: true,
      steps: [
        {
          id: 'request',
          kind: 'http',
          title: 'Send request',
          state: 'cancelled',
          badge: { label: 'Cancelled', tone: 'neutral' },
          evidenceLines: [{ key: 'requests completed', value: '2' }],
        },
      ],
      expected: [
        {
          id: 'status',
          title: 'Successful status',
          assertion: 'The request returns a success status.',
          evidence: 'HTTP status',
          status: 'inconclusive',
          statusText: 'The run ended before this could be decided.',
        },
      ],
      artifacts: [
        'artifacts/authorized.json',
        'artifacts/not-declared.json',
        '../outside.txt',
      ],
    }),
    {
      activeView: 'evidence',
      activeRunId: 'run-0001',
      declaredArtifactPaths: ['artifacts/authorized.json'],
    },
  );

  let markup = serialize(container);
  assert.match(markup, /Hosted relay/);
  assert.match(markup, /Live target evidence/);
  assert.match(markup, /A timeout was reported/);
  assert.match(markup, /evidence set is partial/);
  assert.match(markup, /Only steps reported before cancellation/);

  byRole(container, 'tab').find((tab) => tab.textContent === 'Artifacts').dispatch('click');
  markup = serialize(container);
  assert.match(markup, /artifacts\/authorized\.json/);
  assert.ok(!markup.includes('not-declared.json'));
  assert.ok(!markup.includes('outside.txt'));
  assert.match(markup, /File contents are not previewed/);
});

test('a mismatched exact run id renders no response content', () => {
  const container = new FakeNode('div');
  renderOutput(
    container,
    baseModel({
      runId: 'stale-run',
      summary: 'STALE RESPONSE',
      artifacts: [{ path: 'artifacts/stale.txt', declared: true, authorized: true }],
    }),
    { activeRunId: 'active-run' },
  );

  const markup = serialize(container);
  assert.ok(!markup.includes('STALE RESPONSE'));
  assert.ok(!markup.includes('stale.txt'));
  assert.match(markup, /Waiting for output from the active run/);
  assert.match(markup, /data-run-isolated="true"/);
});

test('conflicting response run identifiers fail closed even when one matches', () => {
  const container = new FakeNode('div');
  renderOutput(
    container,
    baseModel({
      runId: 'active-run',
      meta: { runId: 'stale-run' },
      summary: 'CONFLICTING RESPONSE',
    }),
    { activeRunId: 'active-run' },
  );

  const markup = serialize(container);
  assert.ok(!markup.includes('CONFLICTING RESPONSE'));
  assert.match(markup, /data-run-isolated="true"/);
});

test('the output surface is a bright recessed mono dock and contains no sign-in-code language', () => {
  assert.match(outputCss, /\.output-console\s*\{[\s\S]*background: var\(--well\)/);
  assert.match(outputCss, /\.output-console\s*\{[\s\S]*box-shadow: var\(--sink\)/);
  assert.match(outputCss, /\.output-console\s*\{[\s\S]*font-family: var\(--mono\)/);
  assert.ok(!/#0{3,6}|#1[0-9a-f]{5}|background:\s*(?:black|#000)/i.test(outputCss));
  assert.ok(!/\bdevice[- ]?code\b|devicelogin|user code/i.test(outputSource));
});
