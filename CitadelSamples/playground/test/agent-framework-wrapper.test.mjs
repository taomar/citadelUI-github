import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnProcess } from '../src/server/transports.mjs';

const PLAYGROUND_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const WRAPPER = resolve(PLAYGROUND_ROOT, 'runtime', 'python', 'agent_framework_ask.py');
const HARNESS = resolve(PLAYGROUND_ROOT, 'test', 'fixtures', 'agent_framework_ask_harness.py');
const PYTHON = process.env.CITADEL_PLAYGROUND_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const API_KEY = 'wrapper-secret-that-must-not-appear';
const AGENT_URL = 'https://gateway.example.test/agent/hr-chat-agent';
const CARD_URL = `${AGENT_URL}/.well-known/agent.json`;

const validCard = (url = AGENT_URL) => ({
  name: 'HR',
  description: 'HR agent',
  supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
});

let pythonAvailable;

async function hasPython() {
  if (!pythonAvailable) {
    pythonAvailable = spawnProcess({
      executable: PYTHON,
      args: ['--version'],
      cwd: PLAYGROUND_ROOT,
      timeoutMs: 5000,
      allowedExecutables: [PYTHON],
    }).then((result) => !result.spawnFailed && result.code === 0);
  }
  return pythonAvailable;
}

async function runWrapper(scenario) {
  const result = await spawnProcess({
    executable: PYTHON,
    args: [HARNESS, WRAPPER, JSON.stringify(scenario)],
    cwd: PLAYGROUND_ROOT,
    stdin: JSON.stringify({
      agentUrl: AGENT_URL,
      apiKeyHeader: 'api-key',
      cardPath: '/.well-known/agent.json',
      question: 'What is our leave policy?',
      timeoutSeconds: 10,
    }),
    env: { CITADEL_GATEWAY_ACCESS_API_KEY: API_KEY },
    timeoutMs: 10_000,
    allowedExecutables: [PYTHON],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.includes(API_KEY), false, 'the wrapper or harness returned the key');
  assert.equal(result.stderr.includes(API_KEY), false, 'the wrapper or harness logged the key');

  const lines = result.stdout.trim().split(/\r?\n/);
  const harnessLine = lines.find((line) => line.startsWith('__CITADEL_HARNESS__'));
  assert.ok(harnessLine, `missing harness result in:\n${result.stdout}`);
  const state = JSON.parse(harnessLine.slice('__CITADEL_HARNESS__'.length));
  const wrapperLine = lines.find((line) => line.startsWith('{'));
  assert.ok(wrapperLine, `missing wrapper result in:\n${result.stdout}`);
  return { state, payload: JSON.parse(wrapperLine) };
}

test('the Agent Framework wrapper keeps the key out of global headers and succeeds on the exact gateway route', async (t) => {
  if (!(await hasPython())) {
    t.skip('Python is not installed on this test host');
    return;
  }

  const { state, payload } = await runWrapper({ card: validCard(), answer: 'Use the leave portal.' });
  assert.equal(state.exitCode, 0);
  assert.equal(state.agentConstructed, 1);
  assert.deepEqual(state.clientDefaultCredentialHeaders, [[]], 'the key must not be a client default header');
  assert.deepEqual(
    state.requests,
    [
      { method: 'GET', url: CARD_URL, credentialHeaders: ['api-key'] },
      { method: 'POST', url: AGENT_URL, credentialHeaders: ['api-key'] },
    ],
  );
  assert.equal(payload.answer, 'Use the leave portal.');
  assert.deepEqual(payload.card.transportUrls, [AGENT_URL]);
  assert.deepEqual(payload.route, {
    validated: true,
    expectedOrigin: 'https://gateway.example.test',
    expectedAgentPath: '/agent/hr-chat-agent',
  });
});

test('the Agent Framework wrapper rejects card-controlled destinations before they receive a request or key', async (t) => {
  if (!(await hasPython())) {
    t.skip('Python is not installed on this test host');
    return;
  }

  const cases = [
    ['alternate origin', 'https://attacker.example/collect'],
    ['alternate port', 'https://gateway.example.test:444/agent/hr-chat-agent'],
    ['userinfo', 'https://user@gateway.example.test/agent/hr-chat-agent'],
    ['fragment', 'https://gateway.example.test/agent/hr-chat-agent#outside'],
    ['encoded path', 'https://gateway.example.test/agent/%68r-chat-agent'],
    ['disallowed path', 'https://gateway.example.test/agent/other-agent'],
  ];

  for (const [label, advertisedUrl] of cases) {
    const { state, payload } = await runWrapper({ card: validCard(advertisedUrl) });
    assert.equal(state.exitCode, 1, label);
    assert.equal(state.agentConstructed, 0, `${label}: A2AAgent was constructed before card validation`);
    assert.deepEqual(state.clientDefaultCredentialHeaders, [[]], `${label}: key became a client default`);
    assert.deepEqual(
      state.requests,
      [{ method: 'GET', url: CARD_URL, credentialHeaders: ['api-key'] }],
      `${label}: a card-controlled endpoint received a request`,
    );
    assert.equal(state.requests.some((request) => request.url === advertisedUrl), false, label);
    assert.equal(payload.type, 'agent-run', label);
  }
});

test('the Agent Framework wrapper refuses redirects without contacting the redirect target', async (t) => {
  if (!(await hasPython())) {
    t.skip('Python is not installed on this test host');
    return;
  }

  const redirectTarget = 'https://attacker.example/card';
  const { state, payload } = await runWrapper({ card: validCard(), redirect: redirectTarget });
  assert.equal(state.exitCode, 1);
  assert.equal(state.agentConstructed, 0);
  assert.deepEqual(state.clientDefaultCredentialHeaders, [[]]);
  assert.deepEqual(state.requests, [{ method: 'GET', url: CARD_URL, credentialHeaders: ['api-key'] }]);
  assert.equal(state.requests.some((request) => request.url === redirectTarget), false);
  assert.match(payload.error, /redirects are not allowed/i);
});
