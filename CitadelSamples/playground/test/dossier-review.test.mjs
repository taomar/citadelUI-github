import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createDestructiveConfirmationController,
  renderLedger,
  renderReview,
} from '../web/js/render/review.mjs';

const REVIEW_SOURCE = new URL('../web/js/render/review.mjs', import.meta.url);
const REVIEW_CSS = new URL('../web/css/review.css', import.meta.url);

class FakeNode {
  constructor(ownerDocument) {
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
    this._text = '';
  }

  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    this._text = '';
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

  get children() {
    return this.childNodes.filter((child) => child instanceof FakeElement);
  }

  get textContent() {
    if (this.childNodes.length) return this.childNodes.map((child) => child.textContent).join('');
    return this._text;
  }

  set textContent(value) {
    this.childNodes = [];
    this._text = String(value ?? '');
  }
}

class FakeText extends FakeNode {
  constructor(ownerDocument, text) {
    super(ownerDocument);
    this._text = String(text);
  }
}

function selectorMatches(element, selector) {
  if (selector.startsWith('#')) return element.id === selector.slice(1);
  if (selector.startsWith('.')) {
    return element.className.split(/\s+/).includes(selector.slice(1));
  }
  const dataMatch = selector.match(/^\[data-([a-z0-9-]+)(?:="([^"]*)")?\]$/);
  if (dataMatch) {
    const value = element.getAttribute(`data-${dataMatch[1]}`);
    return dataMatch[2] === undefined ? value !== null : value === dataMatch[2];
  }
  const attributeMatch = selector.match(/^\[([a-z0-9-]+)(?:="([^"]*)")?\]$/);
  if (attributeMatch) {
    const value = element.getAttribute(attributeMatch[1]);
    return attributeMatch[2] === undefined ? value !== null : value === attributeMatch[2];
  }
  return element.tagName === selector.toUpperCase();
}

class FakeElement extends FakeNode {
  constructor(ownerDocument, tagName) {
    super(ownerDocument);
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.dataset = {};
    this.className = '';
    this.id = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.open = false;
    this.returnValue = '';
    this.listeners = new Map();
    this.showModalCalls = 0;
  }

  setAttribute(name, value) {
    const text = String(value);
    this.attributes.set(name, text);
    if (name === 'id') this.id = text;
    if (name === 'class') this.className = text;
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    const nextEvent = {
      defaultPrevented: false,
      ...event,
      target: event.target ?? this,
      currentTarget: this,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    for (const listener of this.listeners.get(nextEvent.type) ?? []) listener(nextEvent);
    if (nextEvent.type === 'cancel' && this.tagName === 'DIALOG' && this.open && !nextEvent.defaultPrevented) {
      this.close('cancel');
    }
    return !nextEvent.defaultPrevented;
  }

  click() {
    if (!this.disabled) this.dispatchEvent({ type: 'click' });
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  showModal() {
    this.open = true;
    this.showModalCalls += 1;
  }

  close(returnValue = '') {
    if (!this.open) return;
    this.open = false;
    this.returnValue = returnValue;
    this.dispatchEvent({ type: 'close' });
  }

  querySelectorAll(selector) {
    const matches = [];
    for (const child of this.children) {
      if (selectorMatches(child, selector)) matches.push(child);
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class FakeDocument {
  constructor() {
    this.activeElement = null;
  }

  createElement(tagName) {
    return new FakeElement(this, tagName);
  }

  createTextNode(text) {
    return new FakeText(this, text);
  }
}

function withDocument(run) {
  const saved = globalThis.document;
  const document = new FakeDocument();
  globalThis.document = document;
  try {
    return run(document);
  } finally {
    globalThis.document = saved;
  }
}

function reviewModel(overrides = {}) {
  return {
    title: 'Cleanup',
    shortTitle: 'Cleanup',
    reviewed: true,
    canRun: true,
    identity: {
      human: 'Ada Lovelace',
      execution: 'Azure CLI user Ada Lovelace',
      tenant: 'tenant-01',
      subscription: 'Sandbox (sub-01)',
      fingerprint: 'identity-01',
    },
    target: {
      exact: 'API Management service hub-apim in rg-citadel',
      apimName: 'hub-apim',
      resourceGroup: 'rg-citadel',
      tenant: 'tenant-01',
      subscription: 'Sandbox (sub-01)',
      actionLabel: 'hub-apim',
      fingerprint: 'target-01',
    },
    authorization: {
      ready: true,
      proven: true,
      label: 'Authorized',
      summary: 'A client-side guess must not become authority.',
    },
    risk: {
      level: 'destructive',
      effect: 'Deletes the APIM product and selected assets.',
      blastRadius: 'Every consumer holding the shared key.',
      reversibility: 'Not reversible from this run.',
    },
    operation: {
      summary: 'Delete the selected APIM resources.',
      text: 'az apim product delete --name hub-apim --yes',
      steps: [{ title: 'Delete the APIM product' }, { title: 'Report residue' }],
    },
    deviations: ['Reports every deletion independently.'],
    placeholders: ['AZURE_TOKEN'],
    inputFingerprint: 'inputs-01',
    ...overrides,
  };
}

test('the ledger selects one contextual action and includes an explicitly safe target', () =>
  withDocument((document) => {
    const container = document.createElement('div');
    let confirmationRequests = 0;
    let directRuns = 0;

    renderLedger(
      container,
      reviewModel({
        reviewed: false,
        requiredInputs: [
          { label: 'Subscription ID', href: '#input-subscription' },
          { label: 'API Management name', href: '#input-apim' },
        ],
      }),
    );
    let primary = container.querySelector('[data-primary-action]');
    assert.equal(primary.getAttribute('data-primary-action'), 'resolve');
    assert.equal(primary.textContent, 'Resolve 2 Required Inputs');
    assert.equal(container.querySelectorAll('[data-primary-action]').length, 1);

    renderLedger(container, reviewModel({ reviewed: false, requiredInputs: [] }));
    primary = container.querySelector('[data-primary-action]');
    assert.equal(primary.getAttribute('data-primary-action'), 'review');
    assert.equal(primary.textContent, 'Review Sample');

    renderLedger(
      container,
      reviewModel({ requiredInputs: [] }),
      {
        onRequestDestructiveConfirmation() {
          confirmationRequests += 1;
        },
        onRun() {
          directRuns += 1;
        },
      },
    );
    primary = container.querySelector('[data-primary-action]');
    assert.equal(primary.getAttribute('data-primary-action'), 'run');
    assert.equal(primary.textContent, 'Run Sample on hub-apim');
    assert.equal(container.querySelectorAll('[data-primary-action]').length, 1);
    primary.click();
    assert.equal(confirmationRequests, 1);
    assert.equal(directRuns, 0, 'a destructive action must hand off to confirmation rather than run');

    renderLedger(
      container,
      reviewModel({ requiredInputs: [], running: true }),
      { onRequestDestructiveConfirmation() {} },
    );
    primary = container.querySelector('[data-primary-action]');
    assert.equal(primary.textContent, 'Run Sample on hub-apim');
    assert.equal(primary.disabled, true);
    assert.equal(container.querySelector('.ledger-cancel').textContent, 'Cancel Run');
  }));

test('non-destructive acknowledgement is model-owned, one-run consent', () =>
  withDocument((document) => {
    const container = document.createElement('div');
    const changes = [];
    const model = reviewModel({
      risk: {
        level: 'state-changing',
        effect: 'Updates one policy.',
        blastRadius: 'One API.',
        reversibility: 'Replace the previous policy.',
      },
      acknowledgement: {
        required: true,
        satisfied: false,
        prompt: 'Acknowledge the policy update.',
      },
    });
    renderReview(container, model, {
      onAcknowledge(value) {
        changes.push(value);
      },
    });
    const checkbox = container.querySelector('input');
    assert.equal(checkbox.checked, false);
    assert.match(container.textContent, /one run/);
    assert.match(container.textContent, /Changing the identity, target, or any input invalidates/);

    checkbox.checked = true;
    checkbox.dispatchEvent({ type: 'change' });
    assert.deepEqual(changes, [true]);

    renderReview(container, { ...model, inputFingerprint: 'inputs-02' });
    assert.equal(container.querySelector('input').checked, false, 'the renderer retains no consent outside the model');
  }));

test('review is decision-first, says Ready to Attempt, and collapses technical detail', () =>
  withDocument((document) => {
    const container = document.createElement('div');
    renderReview(container, reviewModel());
    assert.deepEqual(
      container.querySelectorAll('.review-context-title').slice(0, 3).map((heading) => heading.textContent),
      ['Identity', 'Target', 'Authorization'],
    );
    assert.deepEqual(
      container.querySelectorAll('.review-risk-fact').map((fact) => fact.querySelector('h4').textContent),
      ['Effect', 'Blast radius', 'Reversibility'],
    );
    assert.match(container.textContent, /Exact generated operation/);
    assert.match(container.textContent, /Ready to Attempt/);
    assert.doesNotMatch(container.textContent, /\bAuthorized\b/);
    const details = container.querySelector('details');
    assert.ok(details);
    assert.equal(details.open, false);

    renderReview(container, reviewModel({ canRun: false }));
    assert.match(container.textContent, /Not Ready/);
    assert.doesNotMatch(container.querySelector('.review-state').textContent, /Ready to Attempt/);

    renderReview(
      container,
      reviewModel({
        authorization: {
          backendProven: true,
          label: 'Authorized',
          summary: 'The backend verified this exact attempt.',
        },
      }),
    );
    assert.ok(container.textContent.includes('StateReady to AttemptMeaning'));
    assert.doesNotMatch(container.textContent, /\bAuthorized\b/);
  }));

test('destructive confirmation requires the exact typed APIM phrase before callback', () =>
  withDocument((document) => {
    const host = document.createElement('div');
    const trigger = document.createElement('button');
    let confirmed = 0;
    let controller;
    controller = createDestructiveConfirmationController(host, {
      onConfirm(model) {
        confirmed += 1;
        assert.equal(model.inputFingerprint, 'inputs-01');
        assert.equal(controller.dialog.open, false, 'the dialog closes before execution is handed off');
      },
    });
    const dialog = controller.render(reviewModel());
    const input = dialog.querySelector('.destructive-confirmation-input');
    const confirm = dialog.querySelector('.destructive-confirmation-submit');

    assert.equal(dialog.tagName, 'DIALOG');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.ok(dialog.getAttribute('aria-labelledby'));
    assert.ok(dialog.getAttribute('aria-describedby'));
    assert.match(dialog.textContent, /Human identityAda Lovelace/);
    assert.match(dialog.textContent, /Execution identityAzure CLI user Ada Lovelace/);
    assert.match(dialog.textContent, /DELETE hub-apim/);
    assert.equal(confirm.disabled, true);

    assert.equal(controller.open(trigger), true);
    assert.equal(dialog.open, true);
    assert.equal(dialog.showModalCalls, 1);
    assert.equal(document.activeElement, input);
    assert.equal(confirmed, 0);

    input.value = 'DELETE another-apim';
    input.dispatchEvent({ type: 'input' });
    confirm.click();
    assert.equal(confirmed, 0);
    assert.equal(dialog.open, true);

    input.value = 'DELETE hub-apim';
    input.dispatchEvent({ type: 'input' });
    assert.equal(confirm.disabled, false);
    confirm.click();
    assert.equal(confirmed, 1);
    assert.equal(dialog.open, false);
    assert.equal(document.activeElement, trigger);
  }));

test('identity, target, or input fingerprint changes invalidate an open confirmation', () =>
  withDocument((document) => {
    const host = document.createElement('div');
    const controller = createDestructiveConfirmationController(host);
    const original = controller.render(reviewModel());
    controller.open(document.createElement('button'));
    const originalInput = original.querySelector('.destructive-confirmation-input');
    const originalConfirm = original.querySelector('.destructive-confirmation-submit');
    originalInput.value = 'DELETE hub-apim';
    originalInput.dispatchEvent({ type: 'input' });
    assert.equal(originalConfirm.disabled, false);

    const inputChanged = controller.render(reviewModel({ inputFingerprint: 'inputs-02' }));
    assert.notEqual(inputChanged, original);
    assert.equal(original.open, false);
    assert.equal(inputChanged.querySelector('.destructive-confirmation-input').value, '');
    assert.equal(inputChanged.querySelector('.destructive-confirmation-submit').disabled, true);

    const identityChanged = controller.render(
      reviewModel({
        inputFingerprint: 'inputs-02',
        identity: { ...reviewModel().identity, fingerprint: 'identity-02' },
      }),
    );
    assert.notEqual(identityChanged, inputChanged);

    const targetChanged = controller.render(
      reviewModel({
        inputFingerprint: 'inputs-02',
        identity: { ...reviewModel().identity, fingerprint: 'identity-02' },
        target: { ...reviewModel().target, fingerprint: 'target-02', apimName: 'other-apim' },
      }),
    );
    assert.notEqual(targetChanged, identityChanged);
    assert.match(targetChanged.textContent, /DELETE other-apim/);
  }));

test('destructive confirmation never invents a typed target', () =>
  withDocument((document) => {
    const host = document.createElement('div');
    const controller = createDestructiveConfirmationController(host);
    const dialog = controller.render(
      reviewModel({
        target: {
          exact: 'A supplied multi-resource cleanup set',
          tenant: 'tenant-01',
          subscription: 'Sandbox (sub-01)',
          fingerprint: 'target-without-apim',
        },
      }),
    );
    assert.equal(dialog.querySelector('.destructive-confirmation-input'), null);
    assert.doesNotMatch(dialog.textContent, /DELETE Not supplied/);
    assert.match(dialog.textContent, /does not invent a typed target/);
  }));

test('an explicit non-APIM confirmation phrase participates in invalidation', () =>
  withDocument((document) => {
    const host = document.createElement('div');
    const controller = createDestructiveConfirmationController(host);
    const withoutApim = {
      ...reviewModel(),
      target: {
        exact: 'A supplied multi-resource cleanup set',
        tenant: 'tenant-01',
        subscription: 'Sandbox (sub-01)',
        fingerprint: 'same-target',
      },
    };
    const first = controller.render({
      ...withoutApim,
      confirmation: { requiredText: 'DELETE cleanup-set-a' },
    });
    const second = controller.render({
      ...withoutApim,
      confirmation: { requiredText: 'DELETE cleanup-set-b' },
    });
    assert.notEqual(second, first);
    assert.match(second.textContent, /DELETE cleanup-set-b/);
    assert.doesNotMatch(second.textContent, /DELETE cleanup-set-a/);
  }));

test('Escape cancels and returns focus without confirming', () =>
  withDocument((document) => {
    const host = document.createElement('div');
    const trigger = document.createElement('button');
    let cancelled = '';
    let confirmed = 0;
    const controller = createDestructiveConfirmationController(host, {
      onCancel(reason) {
        cancelled = reason;
      },
      onConfirm() {
        confirmed += 1;
      },
    });
    const dialog = controller.render(reviewModel());
    controller.open(trigger);
    dialog.dispatchEvent({ type: 'cancel' });
    assert.equal(cancelled, 'escape');
    assert.equal(confirmed, 0);
    assert.equal(dialog.open, false);
    assert.equal(document.activeElement, trigger);
  }));

test('dialog source and styling use native modal and containment hooks without sign-in-code language', async () => {
  const [source, css] = await Promise.all([
    readFile(REVIEW_SOURCE, 'utf8'),
    readFile(REVIEW_CSS, 'utf8'),
  ]);
  assert.match(source, /el\(\s*'dialog'/);
  assert.match(source, /dialog\.showModal\(\)/);
  assert.match(source, /dialog\.addEventListener\('cancel'/);
  assert.match(source, /method:\s*'dialog'/);
  assert.match(css, /clamp\(18\.75rem,\s*22vw,\s*20rem\)/);
  assert.match(css, /#run-ledger\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?bottom:\s*0;/);
  assert.match(css, /\.ledger-actions\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?bottom:\s*0;/);
  assert.match(css, /\.destructive-confirmation-scroll\s*\{[\s\S]*?overscroll-behavior:\s*contain;/);
  assert.doesNotMatch(`${source}\n${css}`, /device[\s-]?code|devicelogin|user code/i);
});
