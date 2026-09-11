import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { applyPolicyChanges, POLICY_VARIABLES, readPolicyControls } from '../shared/policy.mjs';
import { installDom, readText } from './_dom-stub.mjs';
import { renderPolicy } from '../web/js/policyview.mjs';

const dom = installDom();
const viewport = dom.node();
globalThis.window = {
  addEventListener: (...args) => viewport.addEventListener(...args),
  removeEventListener: (...args) => viewport.removeEventListener(...args),
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
const wrap = (body) => `\uFEFF\uFEFF<policies>\r\n    <inbound>\r\n        <base />\r\n${body}\r\n    </inbound>\r\n</policies>\r\n`;
const variable = (value) => wrap(`        <set-variable name="jwtAudience" value="${value}" />`);
const all = (node, predicate) => [
  ...(predicate(node) ? [node] : []),
  ...node.children.flatMap((child) => all(child, predicate)),
];

beforeEach(() => {
  dom.root.replaceChildren(dom.modal);
});

function policyView(text, changes = []) {
  const view = renderPolicy({ path: 'synthetic-policy.xml', text, controls: readPolicyControls(text) }, {
    policyMode: 'guided',
    policyVariables: POLICY_VARIABLES,
    onboardedModels: [{ name: 'gpt-4.1', backends: ['synthetic'] }],
    onPolicyChange: (change) => changes.push(change),
  });
  dom.root.append(view);
  return view;
}

for (const [raw, logical] of [
  ['https://example.invalid/a?x=1&amp;y=&quot;quoted&quot;', 'https://example.invalid/a?x=1&y="quoted"'],
  ['&lt;tag&gt;&apos;value&apos;', "<tag>'value'"],
  ['&#38;&#34;&#39;&#60;&#62;', '&"\'<>'],
  ['&#x26;&#x22;&#x1F642;', '&"\u{1f642}'],
  ['literal&amp;quot; and &amp;#38;', 'literal&quot; and &#38;'],
]) {
  test(`R2-03 logical policy variable decodes once: ${raw}`, () => {
    const source = variable(raw);
    const found = readPolicyControls(source).variables.jwtAudience;
    assert.equal(found.value, logical);
    assert.equal(source.slice(found.span.start, found.span.end), raw);
    assert.equal(applyPolicyChanges(source, { variables: { jwtAudience: logical } }), source,
      'an unchanged logical value must preserve the original entity spelling and BOMs');
    let saved = source;
    for (const suffix of ['-first', '-second', '-third']) {
      const before = readPolicyControls(saved).variables.jwtAudience;
      const expected = before.value + suffix;
      const next = applyPolicyChanges(saved, { variables: { jwtAudience: expected } });
      const after = readPolicyControls(next).variables.jwtAudience;
      assert.equal(after.value, expected);
      assert.equal(next.slice(0, after.span.start), saved.slice(0, before.span.start));
      assert.equal(next.slice(after.span.end), saved.slice(before.span.end));
      assert.deepEqual(Buffer.from(next).subarray(0, 6), Buffer.from([239, 187, 191, 239, 187, 191]));
      saved = next;
    }
  });
}

test('R2-03 guided re-edit starts from the logical variable, including literal entity-looking text', () => {
  const source = variable('https://example.invalid/?a=1&amp;b=&quot;two&quot;&amp;literal=&amp;quot;');
  const changes = [];
  const view = policyView(source, changes);
  const field = all(view, (node) => node.getAttribute('aria-label') === 'Audience override')[0];
  assert.equal(field.value, 'https://example.invalid/?a=1&b="two"&literal=&quot;');
  field.value += '-changed';
  field.dispatch('change');
  assert.deepEqual(changes, [{
    control: 'variable', key: 'jwtAudience',
    value: 'https://example.invalid/?a=1&b="two"&literal=&quot;-changed',
  }]);
  const saved = applyPolicyChanges(source, { variables: { jwtAudience: changes[0].value } });
  const reopened = policyView(saved);
  assert.equal(all(reopened, (node) => node.getAttribute('aria-label') === 'Audience override')[0].value,
    changes[0].value);
});

test('R2-03 commented and expression variable spans stay source-owned', () => {
  const source = wrap('        <!-- <set-variable name="jwtAudience" value="example&amp;only" /> -->\r\n' +
    '        <set-variable name="jwtAudience" value="@(literal&amp;quot;)" />');
  const found = readPolicyControls(source).variables.jwtAudience;
  assert.equal(found.value, 'literal&quot;');
  assert.equal(found.expression, true);
  assert.equal(found.commented, false);
  const next = applyPolicyChanges(source, { variables: { jwtAudience: 'literal&quot;-changed' } });
  assert(next.includes('<!-- <set-variable name="jwtAudience" value="example&amp;only" /> -->'));
  assert(next.includes('value="@(literal&amp;quot;-changed)"'));
});

test('R2-03 a decoded line feed uses a multiline control instead of a sanitizing text input', () => {
  const source = variable('before&#10;after');
  const changes = [];
  const view = policyView(source, changes);
  const field = all(view, (node) => node.getAttribute('aria-label') === 'Audience override')[0];
  assert.equal(field.tagName, 'TEXTAREA');
  assert.equal(field.value, 'before\nafter');
  field.value += '-changed';
  field.dispatch('change');
  assert.equal(changes[0].value, 'before\nafter-changed');
  const saved = applyPolicyChanges(source, { variables: { jwtAudience: changes[0].value } });
  assert(saved.includes('before&#10;after-changed'));
});

test('R2-03 carriage returns require Raw XML instead of a silently normalizing guided edit', () => {
  const changes = [];
  const view = policyView(variable('before&#13;&#10;after'), changes);
  const field = all(view, (node) => node.getAttribute('aria-label') === 'Audience override')[0];
  assert.equal(field.tagName, 'TEXTAREA');
  assert(field.readOnly || field.getAttribute('readOnly'));
  assert.match(readText(view), /contains carriage returns.*Raw XML/);
  field.value = 'normalized\nvalue';
  field.dispatch('change');
  assert.deepEqual(changes, []);
});

test('R2-03 XML character references retain whitespace and unknown references are not recursively decoded', () => {
  const source = variable('a&#9;b&#10;c&#13;d &amp;amp; &unknown;');
  const logical = 'a\tb\nc\rd &amp; &unknown;';
  assert.equal(readPolicyControls(source).variables.jwtAudience.value, logical);
  const saved = applyPolicyChanges(source, { variables: { jwtAudience: logical + '-changed' } });
  assert(saved.includes('a&#9;b&#10;c&#13;d &amp;amp; &amp;unknown;-changed'));
  assert.equal(readPolicyControls(saved).variables.jwtAudience.value, logical + '-changed');
});

test('R2-03 raw limit attributes keep their interface while guided values decode numeric entities once', () => {
  const key = '@(context.Subscription.Id + &#34;&amp;quot;&#34;)';
  const source = wrap(`        <llm-token-limit counter-key="${key}" tokens-per-minute="&#49;000" />`);
  const before = readPolicyControls(source);
  assert.equal(before.tokenLimits.universal.attributes['counter-key'].value, key);
  const added = applyPolicyChanges(source, { tokenLimits: { addModel: 'gpt-4.1' } });
  const fallback = readPolicyControls(added).tokenLimits.universal.attributes;
  assert.equal(fallback['counter-key'].value, '@(context.Subscription.Id + &quot;&amp;quot;&quot;)');
  assert.equal(fallback['tokens-per-minute'].value, '1000');
  const view = policyView(source);
  assert(all(view, (node) => node.tagName === 'INPUT').some((node) => node.value === '1000'));
});

test('R2-04 a policy without a token rule offers a prerequisite, not an enabled no-op', () => {
  const source = wrap('        <!-- No token budget has been configured. -->');
  const changes = [];
  const view = policyView(source, changes);
  const action = all(view, (node) => node.tagName === 'BUTTON' &&
    readText(node) === 'Give this model its own budget')[0];
  assert(!action, 'an unsupported action must not be offered');
  assert.match(readText(view), /universal token limit in Raw XML/i);
  assert.deepEqual(changes, []);
  assert.equal(applyPolicyChanges(source, { tokenLimits: { addModel: 'gpt-4.1' } }), source);
});

for (const [shape, body] of [
  ['universal', '<llm-token-limit counter-key="@(context.Subscription.Id)" tokens-per-minute="700" />'],
  ['per-model', '<choose><when condition="@((string)context.Variables[&quot;requestedModel&quot;] == &quot;existing&quot;)"><llm-token-limit tokens-per-minute="500" /></when></choose>'],
]) {
  test(`R2-04 supported ${shape} token budgets still queue an actual model addition`, () => {
    const source = wrap(`        ${body}`);
    const changes = [];
    const view = policyView(source, changes);
    const input = all(view, (node) => node.getAttribute('role') === 'combobox')[0];
    input.value = 'gpt-4.1';
    input.dispatch('input');
    all(view, (node) => node.tagName === 'BUTTON' &&
      readText(node) === 'Give this model its own budget')[0].click();
    assert.deepEqual(changes, [{ control: 'tokenLimits', addModel: 'gpt-4.1' }]);
    const saved = applyPolicyChanges(source, { tokenLimits: { addModel: 'gpt-4.1' } });
    assert.notEqual(saved, source);
    assert(readPolicyControls(saved).tokenLimits.perModel.some((entry) => entry.model === 'gpt-4.1'));
    if (shape === 'universal') {
      assert.equal(readPolicyControls(saved).tokenLimits.universal.attributes['tokens-per-minute'].value, '700');
    }
  });
}
