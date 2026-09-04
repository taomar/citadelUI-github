/**
 * Assertion evaluation.
 *
 * Every assertion kind the 19 plans use is implemented here. Three rules hold
 * throughout, and they are what separate this from the notebook:
 *
 *   1. An HTTP 2xx is never enough on its own. A JSON-RPC body carrying an
 *      `error` member is a failure regardless of status.
 *   2. `inconclusive` is a real outcome. An empty metrics window inside the
 *      ingestion delay, or a verification with nothing to verify, is reported
 *      as inconclusive rather than as a pass.
 *   3. Evidence is data the run actually observed. When a step did not run,
 *      the assertion says so instead of assuming.
 */

import { extractToolCallText, extractToolNames, interpretJsonRpc, parseWeatherPayload } from '../core/parsing.mjs';

const PASS = 'passed';
const FAIL = 'failed';
const UNKNOWN = 'inconclusive';

function outcome(status, detail, evidence = {}, outputs = {}, configurationUpdates = {}) {
  return { status, detail, evidence, outputs, configurationUpdates };
}

/** `{{steps.x.y}}` -> the recorded output, or undefined. */
function readSource(source, outputs) {
  if (typeof source !== 'string') return undefined;
  const match = source.match(/^\{\{steps\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)\}\}$/);
  if (!match) return undefined;
  return outputs.get(`${match[1]}.${match[2]}`);
}

const EVALUATORS = {
  equals({ assertion, outputs }) {
    const actual = readSource(assertion.source, outputs);
    const expected = assertion.expected;
    if (actual === undefined) return outcome(UNKNOWN, 'The value being compared was never produced.');
    return actual === expected
      ? outcome(PASS, `Matched \`${expected}\`.`, { actual })
      : outcome(FAIL, `Expected \`${expected}\`, observed \`${actual}\`. ${assertion.remediation ?? ''}`.trim(), { actual, expected });
  },

  contains({ assertion, outputs }) {
    const actual = readSource(assertion.source, outputs);
    const expected = assertion.expected;
    if (actual === undefined) return outcome(UNKNOWN, 'The collection being searched was never produced.');
    const list = Array.isArray(actual) ? actual : [actual];
    const found = list.some((item) =>
      typeof item === 'string' ? item === expected : JSON.stringify(item ?? '').includes(String(expected)),
    );
    return found
      ? outcome(PASS, `\`${expected}\` is present.`, { count: list.length })
      : outcome(FAIL, `\`${expected}\` is not in the ${list.length} value(s) returned.`, { observed: list.slice(0, 20) });
  },

  'role-assignment'({ assertion, outputs, step }) {
    const assignments = readSource(assertion.source, outputs);
    if (!Array.isArray(assignments)) return outcome(UNKNOWN, 'The role-assignment listing was never produced.');
    const expectedScope = readSource(assertion.expectedScope, outputs) ?? assertion.expectedScope;
    const match = assignments.find((assignment) => {
      const role = assignment?.role ?? assignment?.roleDefinitionName;
      return role === assertion.expectedRole && assignment?.scope === expectedScope;
    });
    if (!match) {
      return outcome(
        FAIL,
        `No assignment with role \`${assertion.expectedRole}\` exists at \`${expectedScope}\`.`,
        {
          observed: assignments.slice(0, 20).map((assignment) => ({
            role: assignment?.role ?? assignment?.roleDefinitionName ?? '',
            scope: assignment?.scope ?? '',
          })),
        },
      );
    }
    return outcome(
      PASS,
      `Role \`${assertion.expectedRole}\` is assigned at the intended project scope.`,
      { role: assertion.expectedRole, scope: expectedScope },
      step.produces?.[0] ? { [step.produces[0]]: true } : {},
    );
  },

  'non-empty'({ assertion, outputs }) {
    const actual = readSource(assertion.source, outputs);
    if (actual === undefined) return outcome(UNKNOWN, 'Nothing was produced to check.');
    const text = typeof actual === 'string' ? actual.trim() : actual;
    const empty = text === '' || text === null || (Array.isArray(text) && text.length === 0);
    return empty
      ? outcome(FAIL, 'The value came back empty.')
      : outcome(PASS, 'A non-empty value was returned.', { length: typeof text === 'string' ? text.length : undefined });
  },

  guard({ acknowledgement }) {
    // The executor refuses the run outright when this is not satisfied, so
    // reaching the evaluator means it held.
    return outcome(PASS, 'The non-production confirmation and the per-run acknowledgement were both present.', {
      acknowledgedAt: acknowledgement?.at ?? null,
    });
  },

  'http-status'({ assertion, outputs }) {
    const status = readSource(assertion.source, outputs);
    if (typeof status !== 'number') return outcome(UNKNOWN, 'No HTTP status was captured.');
    return status < 300
      ? outcome(PASS, `HTTP ${status}.`, { status })
      : outcome(FAIL, `HTTP ${status}. Any status of 300 or above is a failure here.`, { status });
  },

  'identity-selection'({ assertion, outputs }) {
    const identity = readSource(assertion.source, outputs);
    if (!identity || typeof identity !== 'object') {
      return outcome(FAIL, 'API Management has no managed identity to grant.');
    }

    const userAssigned = Object.values(identity.userAssignedIdentities ?? {}).filter(
      (entry) => entry && typeof entry.principalId === 'string' && entry.principalId,
    );
    const requestedPrincipal = String(assertion.selectedPrincipalId ?? '').trim();
    let selected = null;

    if (requestedPrincipal) {
      selected =
        userAssigned.find((entry) => entry.principalId === requestedPrincipal) ??
        (identity.principalId === requestedPrincipal
          ? { principalId: identity.principalId, clientId: '' }
          : null);
      if (!selected) {
        return outcome(
          FAIL,
          `The configured principal ID \`${requestedPrincipal}\` is not attached to this API Management service.`,
          { userAssignedCount: userAssigned.length, hasSystemAssigned: Boolean(identity.principalId) },
        );
      }
    } else if (userAssigned.length === 1) {
      selected = userAssigned[0];
    } else if (userAssigned.length > 1) {
      return outcome(
        FAIL,
        `${userAssigned.length} user-assigned identities are attached. Enter the intended principal and client IDs explicitly, then run again.`,
        { userAssignedCount: userAssigned.length },
      );
    } else if (identity.principalId) {
      selected = { principalId: identity.principalId, clientId: '' };
    }

    if (!selected?.principalId) {
      return outcome(FAIL, 'No usable user-assigned or system-assigned identity was found.');
    }
    const clientId = String(selected.clientId ?? assertion.selectedClientId ?? '');
    return outcome(
      PASS,
      clientId
        ? 'Selected the single matching user-assigned identity.'
        : 'Selected the system-assigned identity.',
      { principalId: selected.principalId, clientId, userAssignedCount: userAssigned.length },
      { principalId: selected.principalId, clientId },
      {
        'foundry.apimIdentityPrincipalId': selected.principalId,
        'foundry.apimIdentityClientId': clientId,
      },
    );
  },

  jsonrpc({ assertion, outputs, stepResults }) {
    const source = String(assertion.source ?? '');
    const stepId = source.match(/\{\{steps\.([A-Za-z0-9_-]+)\./)?.[1];
    const step = stepResults.find((candidate) => candidate.id === stepId);
    const body = step?.jsonRpcBody ?? null;
    const status = outputs.get(`${stepId}.status`);
    const verdict = interpretJsonRpc({ status, body });
    if (verdict.outcome === 'success') return outcome(PASS, verdict.reason, { status });
    if (verdict.outcome === 'failure') return outcome(FAIL, verdict.reason, { status, error: verdict.error });
    return outcome(UNKNOWN, verdict.reason, { status });
  },

  'mcp-tools'({ assertion, outputs, stepResults }) {
    const initialize = stepResults.find((step) => step.id === 'mcp-initialize');
    const listStep = stepResults.find((step) => step.id === 'tools-list');
    if (!initialize || !listStep) return outcome(UNKNOWN, 'The handshake did not complete, so the tool inventory is unknown.');
    const sessionId = outputs.get('mcp-initialize.sessionId');
    const verdict = interpretJsonRpc({ status: outputs.get('tools-list.status'), body: listStep.jsonRpcBody });
    if (verdict.outcome !== 'success') return outcome(FAIL, verdict.reason, { sessionCaptured: Boolean(sessionId) });
    const names = extractToolNames(verdict.result);
    if (names.length === 0) return outcome(FAIL, '`tools/list` returned an empty tool array.', { sessionCaptured: Boolean(sessionId) });
    return outcome(PASS, `${names.length} tool(s) returned.`, { tools: names, sessionCaptured: Boolean(sessionId) });
  },

  'weather-payload'({ assertion, outputs, stepResults }) {
    const callStep = stepResults.find((step) => step.id === 'tools-call');
    const verdict = interpretJsonRpc({ status: outputs.get('tools-call.status'), body: callStep?.jsonRpcBody });
    if (verdict.outcome !== 'success') return outcome(verdict.outcome === 'failure' ? FAIL : UNKNOWN, verdict.reason);
    const payload = parseWeatherPayload(extractToolCallText(verdict.result));
    if (!payload) return outcome(FAIL, 'The first content block did not parse as JSON.');
    const missing = (assertion.expectedFields ?? []).filter((field) => payload[field] === undefined);
    if (missing.length > 0) return outcome(FAIL, `The payload is missing: ${missing.join(', ')}.`, { payload });
    if (assertion.expectedUnit && payload.temperature_format !== assertion.expectedUnit) {
      return outcome(
        FAIL,
        `Expected \`${assertion.expectedUnit}\` for this city, observed \`${payload.temperature_format}\`.`,
        { payload },
      );
    }
    return outcome(PASS, 'Every expected field is present and the unit branch matches the city.', { payload });
  },

  'a2a-card'({ assertion, outputs }) {
    const card = readSource(assertion.source, outputs);
    if (!card || typeof card !== 'object') return outcome(UNKNOWN, 'No agent card was captured.');
    if (!card.name || !card.description) return outcome(FAIL, 'The card is missing `name` or `description`.', { card });
    const urls = collectUrls(card);
    const leaking = urls.filter((url) => /\.services\.ai\.azure\.com/i.test(url));
    if (leaking.length > 0) {
      return outcome(FAIL, `The card still advertises ${leaking.length} Foundry transport URL(s), which would let clients bypass the gateway.`, {
        offending: leaking,
      });
    }
    return outcome(PASS, 'The card resolves and every transport URL points at the gateway.', { name: card.name, urls });
  },

  'rate-limit'({ assertion, outputs }) {
    const codes = readSource(assertion.source, outputs);
    if (!Array.isArray(codes) || codes.length === 0) return outcome(UNKNOWN, 'The burst produced no status codes.');
    const histogram = {};
    for (const code of codes) histogram[code] = (histogram[code] ?? 0) + 1;
    const throttled = codes.filter((code) => code === 429).length;
    const errors = codes.filter((code) => code === 0 || code === -1).length;
    if (throttled === 0) {
      return outcome(
        FAIL,
        `No response carried HTTP 429 across ${codes.length} calls. The deployed limit may differ from ${assertion.limitPerMinute}/minute, the policy branch may not have applied, or the window had already reset.`,
        { histogram, transportErrors: errors },
      );
    }
    return outcome(PASS, `${throttled}/${codes.length} calls were throttled.`, { histogram, transportErrors: errors });
  },

  selection({ assertion, outputs, step }) {
    const candidates = readSource(assertion.source, outputs);
    if (candidates === undefined) return outcome(UNKNOWN, 'No candidate list was produced.');
    const list = Array.isArray(candidates) ? candidates : [candidates];
    const names = list.map((item) => (typeof item === 'string' ? item : (item?.name ?? '')));
    const explicit = assertion.selected && !String(assertion.selected).startsWith('(') ? String(assertion.selected) : '';
    if (names.length === 0) return outcome(FAIL, 'The candidate list is empty. There is nothing to select.', { names });
    if (explicit) {
      return names.includes(explicit)
        ? selectedOutcome(assertion, step, names, explicit, `The explicit name \`${explicit}\` is in the candidate list.`)
        : outcome(FAIL, `\`${explicit}\` is not among ${names.join(', ')}.`, { names });
    }
    if (names.length === 1) {
      return selectedOutcome(assertion, step, names, names[0], `Exactly one candidate: \`${names[0]}\`.`);
    }
    const preferredNeedle = String(assertion.preferContains ?? '').toLowerCase();
    const preferred = preferredNeedle
      ? names.filter((name) => name.toLowerCase().includes(preferredNeedle))
      : [];
    if (preferred.length === 1) {
      return selectedOutcome(
        assertion,
        step,
        names,
        preferred[0],
        `Selected \`${preferred[0]}\` as the only candidate containing \`${preferredNeedle}\`.`,
      );
    }
    return outcome(FAIL, `${names.length} candidates and no way to choose between them. Name one explicitly and re-run.`, { names });
  },

  shape({ assertion, outputs, step }) {
    const value = readSource(assertion.source, outputs);
    if (value === undefined) return outcome(UNKNOWN, 'The value being inspected was never produced.');
    if (typeof value === 'string') {
      if (value.trim() === '') return outcome(FAIL, 'The value came back empty.');
      if (/^https?:\/\//i.test(value) && !/^https:\/\//i.test(value)) {
        return outcome(FAIL, 'The URL is not https.', { value });
      }
      const produced = assertion.outputSuffix ? `${value}${assertion.outputSuffix}` : value;
      const outputValues = step.produces?.[0] ? { [step.produces[0]]: produced } : {};
      return outcome(PASS, 'A non-empty value was returned.', { value: produced }, outputValues);
    }
    if (Array.isArray(value)) {
      return value.length > 0
        ? outcome(PASS, `${value.length} entr${value.length === 1 ? 'y' : 'ies'} returned.`, { count: value.length, sample: value.slice(0, 5) })
        : outcome(FAIL, 'The collection came back empty.');
    }
    return value === null
      ? outcome(FAIL, 'The value came back null.')
      : outcome(PASS, 'An object was returned.', { keys: Object.keys(value).slice(0, 20) });
  },

  classification({ assertion, outputs, step }) {
    const existing = readSource(assertion.source, outputs);
    if (!Array.isArray(existing)) return outcome(UNKNOWN, 'The API listing was never produced.');
    const candidates = assertion.candidateLlmApis ?? [];
    const actual = candidates.filter((name) => existing.includes(name)).sort();
    const configured = [...(assertion.configuredLlmApis ?? [])].sort();
    if (JSON.stringify(actual) !== JSON.stringify(configured)) {
      return outcome(
        FAIL,
        `Gateway discovery found LLM APIs [${actual.join(', ') || 'none'}], but this plan was generated for [${configured.join(', ') || 'none'}]. The discovered list was applied to the form; review it and run again before any artifact is written or deployed.`,
        { apiCount: existing.length, discoveredLlmApis: actual, configuredLlmApis: configured },
      );
    }
    return outcome(
      PASS,
      `Classified against ${existing.length} API(s) on the gateway.`,
      { apiCount: existing.length, discoveredLlmApis: actual, expectations: assertion.expectations ?? [] },
      Object.fromEntries(
        (step.produces ?? [])
          .filter((name) => Object.prototype.hasOwnProperty.call(assertion.outputValues ?? {}, name))
          .map((name) => [name, assertion.outputValues[name]]),
      ),
    );
  },

  metrics({ assertion, outputs }) {
    const rows = readSource(assertion.source, outputs);
    if (!Array.isArray(rows)) return outcome(UNKNOWN, 'The query returned no table.');
    if (rows.length > 0) return outcome(PASS, `${rows.length} metric row(s) inside the window.`, { rows: rows.slice(0, 20) });
    return outcome(
      UNKNOWN,
      `No rows inside the last ${assertion.lookbackMinutes} minutes. Azure Monitor ingestion typically lags a few minutes, so this is inconclusive rather than a failure until ${assertion.ingestionDelayMinutes} minute(s) have passed since the calls.`,
      { rowCount: 0 },
    );
  },

  'circuit-breaker'({ assertion, outputs, stepResults }) {
    const readSteps = stepResults.filter((step) => step.id.startsWith('read-backend-'));
    if (readSteps.length === 0) return outcome(UNKNOWN, 'No backend was read.');
    const problems = [];
    const observed = [];
    for (const step of readSteps) {
      const breaker = outputs.get(`${step.id}.circuitBreaker`);
      const rule = breaker?.rules?.[0];
      if (!rule) {
        problems.push(`${step.id}: no circuit breaker rule is configured.`);
        continue;
      }
      const condition = rule.failureCondition ?? {};
      observed.push({ step: step.id, count: condition.count, interval: condition.interval, tripDuration: rule.tripDuration });
      const expected = assertion.expected ?? {};
      if (expected.failureCount !== undefined && condition.count !== expected.failureCount) {
        problems.push(`${step.id}: failure count is ${condition.count}, expected ${expected.failureCount}.`);
      }
      if (expected.failureInterval && condition.interval !== expected.failureInterval) {
        problems.push(`${step.id}: interval is ${condition.interval}, expected ${expected.failureInterval}.`);
      }
      if (expected.tripDuration && rule.tripDuration !== expected.tripDuration) {
        problems.push(`${step.id}: trip duration is ${rule.tripDuration}, expected ${expected.tripDuration}.`);
      }
      if (expected.acceptRetryAfter !== undefined && Boolean(rule.acceptRetryAfter) !== Boolean(expected.acceptRetryAfter)) {
        problems.push(`${step.id}: acceptRetryAfter is ${Boolean(rule.acceptRetryAfter)}, expected ${expected.acceptRetryAfter}.`);
      }
    }
    return problems.length === 0
      ? outcome(PASS, `${readSteps.length} backend(s) carry the expected circuit breaker.`, { observed })
      : outcome(FAIL, problems.join(' '), { observed });
  },

  all({ assertion, outputs, stepResults }) {
    const keyLength = readSource(assertion.source, outputs);
    if (typeof keyLength !== 'number') return outcome(UNKNOWN, 'The api-key secret was never read.');
    if (keyLength <= 0) return outcome(FAIL, 'The api-key secret is present but empty.');
    const endpointSteps = stepResults.filter((step) => step.id.startsWith('read-endpoint-'));
    if (endpointSteps.length === 0) {
      return outcome(
        UNKNOWN,
        'The key secret is present, but no endpoint secret names are recorded, so there is nothing to verify. An empty set is not a pass.',
        { keyLength },
      );
    }
    const empty = endpointSteps.filter((step) => !String(outputs.get(`${step.id}.endpointValue`) ?? '').trim());
    return empty.length === 0
      ? outcome(PASS, `The key secret and all ${endpointSteps.length} endpoint secrets are present.`, { keyLength, endpoints: endpointSteps.length })
      : outcome(FAIL, `${empty.length} of ${endpointSteps.length} endpoint secrets are missing or empty.`, { keyLength });
  },

  'per-item'({ stepResults }) {
    const deletions = stepResults.filter((step) => step.kind === 'azure-cli' && step.id.startsWith('delete-'));
    if (deletions.length === 0) {
      return outcome(PASS, 'Both deletion switches are off, so no deletion was attempted and none is claimed.', { attempted: 0 });
    }
    const failed = deletions.filter((step) => step.state === 'failed');
    const report = deletions.map((step) => ({ id: step.id, state: step.state }));
    return failed.length === 0
      ? outcome(PASS, `${deletions.length} deletion(s), each reported on its own.`, { report })
      : outcome(FAIL, `${failed.length} of ${deletions.length} deletions failed. A partial failure is a failure.`, { report });
  },

  residue({ assertion }) {
    return outcome(PASS, `${(assertion.residue ?? []).length} residual item(s) named, with the command that removes each one.`, {
      residue: assertion.residue ?? [],
    });
  },
};

function selectedOutcome(assertion, step, names, selected, detail) {
  const outputName = step.produces?.[0];
  return outcome(
    PASS,
    detail,
    { names, selected },
    outputName ? { [outputName]: selected } : {},
    assertion.configurationPath ? { [assertion.configurationPath]: selected } : {},
  );
}

function collectUrls(value, found = [], depth = 0) {
  if (depth > 8) return found;
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) found.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, found, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectUrls(item, found, depth + 1);
  }
  return found;
}

export const ASSERTION_KINDS = Object.freeze(Object.keys(EVALUATORS));

/**
 * Evaluate one assertion step.
 *
 * @returns {{status:'passed'|'failed'|'inconclusive', detail:string, evidence:object}}
 */
export function evaluateAssertion(step, context) {
  const assertion = step.assertion ?? {};
  const evaluator = EVALUATORS[assertion.kind];
  if (!evaluator) {
    return outcome(UNKNOWN, `No evaluator is implemented for assertion kind \`${assertion.kind}\`, so nothing is claimed.`);
  }
  try {
    return evaluator({ assertion, step, ...context });
  } catch (error) {
    return outcome(UNKNOWN, `The assertion could not be evaluated: ${error?.message ?? error}`);
  }
}
