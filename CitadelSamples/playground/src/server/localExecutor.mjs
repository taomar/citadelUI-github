/**
 * The local executor.
 *
 * It runs a plan the SERVER rebuilt, never one the browser sent. Everything it
 * may do is enumerated:
 *
 *   artifact    write generated text into the run workspace, nowhere else
 *   azure-cli   spawn `az` with an argument array, `shell: false`, against the
 *               operation registry's allow-list
 *   http        one HTTPS request, or a bounded burst of identical ones
 *   library     spawn the selected Python interpreter on a SHIPPED script, with
 *               parameters passed as JSON on stdin — never generated source
 *   assertion   evaluate captured output; no side effect
 *
 * Timeouts, output limits, concurrency, cancellation and redaction are enforced
 * here rather than left to the caller, because a caller that forgets one of
 * them is the failure mode this module exists to prevent.
 */

import { ALLOWED_EXECUTABLES, executableIdentity, isAllowedExecutable } from '../core/types.mjs';
import { isSecretRef } from '../core/secrets.mjs';
import { parseHttpResponse, readHeader } from '../core/parsing.mjs';
import { evaluateAssertion } from './assertions.mjs';
import { clip, createRedactor } from './redaction.mjs';
import { PARSERS, resolveAzOperation, resolvePythonWrapper } from './registry.mjs';

export const DEFAULT_LIMITS = Object.freeze({
  stepTimeoutMs: 180_000,
  runTimeoutMs: 900_000,
  maxOutputBytes: 256 * 1024,
  maxResponseBytes: 1024 * 1024,
  maxBurstRequests: 200,
  maxConcurrency: 16,
  maxArtifactBytes: 512 * 1024,
});

/** Only https, and only a host — never a file, data or loopback-bypass URL. */
export function assertExecutableUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error(`"${url}" is not a URL.`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Refused ${parsed.protocol}//… — this executor only makes https requests.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Refused a URL carrying inline credentials.');
  }
  return parsed;
}

/* --------------------------------------------------------------- bindings */

const BINDING = /\{\{steps\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)\}\}/g;

/** Resolve `{{steps.x.y}}` tokens and `SecretRef`s into live values. */
function resolveValue(value, outputs, secrets) {
  if (isSecretRef(value)) {
    const resolved = secrets[value.ref];
    if (typeof resolved !== 'string' || resolved === '') {
      throw new Error(`Missing secret value for ${value.ref}.`);
    }
    return resolved;
  }
  if (typeof value === 'string') {
    const whole = value.match(/^\{\{steps\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)\}\}$/);
    if (whole) {
      const bound = outputs.get(`${whole[1]}.${whole[2]}`);
      return bound === undefined ? '' : bound;
    }
    return value.replace(BINDING, (_match, stepId, output) => {
      const bound = outputs.get(`${stepId}.${output}`);
      return bound === undefined ? '' : String(bound);
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, outputs, secrets));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolveValue(item, outputs, secrets);
    return out;
  }
  return value;
}

/* ------------------------------------------------------------- the runner */

/**
 * @param {object} options
 * @param {object} options.transports  { spawn, fetch, writeFile, access }
 * @param {object} options.workspace   from `createRunWorkspace`
 * @param {object} [options.limits]
 * @param {string} [options.pythonExecutable]
 */
export function createLocalExecutor({ transports, workspace, limits = {}, pythonExecutable = 'python', pythonRoot }) {
  const bounds = { ...DEFAULT_LIMITS, ...limits };

  /**
   * @param {object} plan       rebuilt server-side
   * @param {object} context    { sampleId, inputs, secrets, acknowledgement, contract, signal, onProgress }
   */
  async function execute(plan, context) {
    const { sampleId, inputs = {}, secrets = {}, acknowledgement = null, contract = null, signal, onProgress } = context;
    const redactor = createRedactor(Object.values(secrets).filter((value) => typeof value === 'string'));
    const outputs = new Map();
    const stepResults = [];
    const configurationUpdates = {};
    const secretUpdates = {};
    const startedAt = Date.now();

    const report = (record) => {
      stepResults.push(record);
      onProgress?.({ type: 'step', step: publicStep(record) });
      return record;
    };

    for (const step of plan.steps) {
      if (signal?.aborted) {
        report({ id: step.id, kind: step.type, title: step.title, state: 'cancelled', durationMs: 0, evidence: {} });
        break;
      }
      if (Date.now() - startedAt > bounds.runTimeoutMs) {
        report({
          id: step.id,
          kind: step.type,
          title: step.title,
          state: 'failed',
          durationMs: 0,
          detail: `The whole run exceeded its ${Math.round(bounds.runTimeoutMs / 1000)}s budget before this step started.`,
          evidence: {},
        });
        break;
      }
      onProgress?.({ type: 'step-start', step: { id: step.id, title: step.title, kind: step.type } });
      const began = Date.now();
      let record;
      try {
        record = await runStep(step, {
          plan,
          sampleId,
          inputs,
          secrets,
          acknowledgement,
          contract,
          outputs,
          stepResults,
          redactor,
          signal,
        });
      } catch (error) {
        record = {
          id: step.id,
          kind: step.type,
          title: step.title,
          state: signal?.aborted ? 'cancelled' : 'failed',
          detail: redactor.text(error?.message ?? String(error)),
          evidence: {},
        };
      }
      record.durationMs = Date.now() - began;
      Object.assign(configurationUpdates, record.configurationUpdates ?? {});
      Object.assign(secretUpdates, record.secretUpdates ?? {});
      for (const value of Object.values(record.secretUpdates ?? {})) redactor.add(value);
      report(record);
      // A step that did not complete stops the run. In particular, a failed or
      // inconclusive selection must never be followed by a command carrying an
      // empty binding.
      if (record.state !== 'completed' && record.state !== 'skipped') break;
    }

    return summarise({ plan, stepResults, configurationUpdates, secretUpdates, redactor, signal, startedAt });
  }

  /* ------------------------------------------------------------- one step */

  async function runStep(step, context) {
    switch (step.type) {
      case 'artifact':
        return runArtifact(step, context);
      case 'azure-cli':
        return runAzureCli(step, context);
      case 'http':
        return runHttp(step, context);
      case 'library':
        return runLibrary(step, context);
      case 'assertion': {
        const result = evaluateAssertion(step, context);
        for (const [name, value] of Object.entries(result.outputs ?? {})) {
          if (!step.produces.includes(name)) {
            throw new Error(`Assertion "${step.id}" produced undeclared output "${name}".`);
          }
          context.outputs.set(`${step.id}.${name}`, value);
        }
        const evidence = context.redactor.value(result.evidence ?? {});
        return {
          id: step.id,
          kind: 'assertion',
          title: step.title,
          state: result.status === 'passed' ? 'completed' : result.status === 'failed' ? 'failed' : 'inconclusive',
          assertion: {
            id: step.id,
            status: result.status,
            detail: context.redactor.text(result.detail),
            evidence,
          },
          detail: context.redactor.text(result.detail),
          evidence,
          configurationUpdates: result.configurationUpdates ?? {},
        };
      }
      default:
        throw new Error(`Step type "${step.type}" is not executable by this executor.`);
    }
  }

  async function runArtifact(step, { outputs, secrets, redactor }) {
    const artifact = step.artifact ?? {};
    const target = workspace.resolve(artifact.path);
    if (target.staged) await workspace.stageAccelerator();
    await workspace.ensureDirFor(target.absolute);
    const content = String(resolveValue(artifact.content, outputs, secrets) ?? '');
    if (Buffer.byteLength(content, 'utf-8') > bounds.maxArtifactBytes) {
      throw new Error(`The generated file exceeds the ${bounds.maxArtifactBytes}-byte artifact limit.`);
    }
    await transports.writeFile(target.absolute, content, 'utf-8');
    for (const produced of step.produces ?? []) outputs.set(`${step.id}.${produced}`, target.relative);
    return {
      id: step.id,
      kind: 'artifact',
      title: step.title,
      state: 'completed',
      detail: `Written to the run workspace at \`${target.relative}\`.`,
      evidence: redactor.value({
        path: target.relative,
        bytes: Buffer.byteLength(content, 'utf-8'),
        language: artifact.language ?? '',
        stagedAlongsideTemplates: target.staged,
      }),
      artifactPath: target.relative,
    };
  }

  async function runAzureCli(step, { sampleId, inputs, outputs, secrets, redactor, signal }) {
    const entry = resolveAzOperation(sampleId, step);
    const command = step.command ?? {};
    if (!isAllowedExecutable(command.executable) || executableIdentity(command.executable) !== 'az') {
      throw new Error(`Refused to spawn "${command.executable}" for an azure-cli step.`);
    }
    const args = (command.args ?? []).map((arg) => String(resolveValue(arg, outputs, secrets)));
    // A path argument is executed against the run workspace, not against
    // whatever the plan text says.
    const mapped = await mapPathArguments(args);
    const result = await runProcess(command.executable, mapped, { signal, cwd: workspace.root });
    const stdout = clip(result.stdout, bounds.maxOutputBytes);
    const stderr = clip(result.stderr, bounds.maxOutputBytes);
    if (result.code !== 0) {
      return {
        id: step.id,
        kind: 'azure-cli',
        title: step.title,
        state: result.timedOut ? 'failed' : signal?.aborted ? 'cancelled' : 'failed',
        detail: result.timedOut
          ? `\`az ${entry.verbs.join(' ')}\` exceeded its ${Math.round(bounds.stepTimeoutMs / 1000)}s timeout.`
          : `\`az ${entry.verbs.join(' ')}\` exited ${result.code}.`,
        evidence: { exitCode: result.code, stderr: redactor.text(stderr.text) },
      };
    }
    let parsed = null;
    try {
      parsed = PARSERS[entry.parse ?? 'json'](stdout.text);
    } catch (error) {
      return {
        id: step.id,
        kind: 'azure-cli',
        title: step.title,
        state: 'failed',
        detail: `The command succeeded but its output did not parse as ${entry.parse}: ${error.message}`,
        evidence: { stdout: redactor.text(stdout.text.slice(0, 2000)) },
      };
    }
    const mappedOut = entry.map(parsed, { inputs }) ?? {};
    for (const [name, value] of Object.entries(mappedOut.outputs ?? {})) {
      outputs.set(`${step.id}.${name}`, value);
    }
    // A credential-producing step never contributes its value to evidence, and
    // registers it so every later step's output is scrubbed of it.
    if (entry.credential) {
      for (const value of Object.values(mappedOut.outputs ?? {})) redactor.add(typeof value === 'string' ? value : '');
      for (const value of Object.values(mappedOut.secretUpdates ?? {})) redactor.add(value);
    }
    if (mappedOut.secretUpdates?.['gatewayAccess.apiKey']) {
      outputs.set(`${step.id}.__keyReturned`, true);
    }
    return {
      id: step.id,
      kind: 'azure-cli',
      title: step.title,
      state: 'completed',
      detail: entry.summary,
      evidence: redactor.value(mappedOut.evidence ?? {}),
      configurationUpdates: mappedOut.configurationUpdates ?? {},
      secretUpdates: mappedOut.secretUpdates ?? {},
    };
  }

  async function runHttp(step, { outputs, secrets, redactor, signal }) {
    const request = step.request ?? {};
    const url = assertExecutableUrl(resolveValue(request.url, outputs, secrets));
    const headers = resolveValue(request.headers ?? {}, outputs, secrets);
    const body =
      request.body === undefined || request.body === null
        ? undefined
        : typeof request.body === 'string'
          ? resolveValue(request.body, outputs, secrets)
          : JSON.stringify(resolveValue(request.body, outputs, secrets));
    const timeoutMs = Math.min((request.timeoutSeconds ?? 60) * 1000, bounds.stepTimeoutMs);

    if (request.repeat) {
      return runBurst(step, { url, headers, body, request, outputs, redactor, signal });
    }

    const response = await fetchOnce({ url, method: request.method ?? 'GET', headers, body, timeoutMs, signal });
    if (response.error) {
      return {
        id: step.id,
        kind: 'http',
        title: step.title,
        state: signal?.aborted ? 'cancelled' : 'failed',
        detail: redactor.text(response.error),
        evidence: { url: url.toString(), method: request.method ?? 'GET' },
      };
    }
    const parsed = parseHttpResponse({ status: response.status, headers: response.headers, text: response.text });
    const jsonRpcBody = parsed.format === 'sse' ? parsed.data : parsed.format === 'json' ? parsed.data : null;

    for (const [name, source] of Object.entries(request.capture ?? {})) {
      outputs.set(`${step.id}.${name}`, captureFrom(source, { response, parsed, jsonRpcBody }));
    }
    for (const produced of step.produces ?? []) {
      const key = `${step.id}.${produced}`;
      if (!outputs.has(key)) outputs.set(key, undefined);
    }
    const ok = response.status >= 200 && response.status < 300;
    return {
      id: step.id,
      kind: 'http',
      title: step.title,
      // The assertion step, not this one, decides whether a 2xx means success.
      state: ok ? 'completed' : 'failed',
      detail: `HTTP ${response.status} · ${parsed.format}`,
      jsonRpcBody,
      evidence: redactor.value({
        url: url.toString(),
        method: request.method ?? 'GET',
        status: response.status,
        format: parsed.format,
        sessionCaptured: Boolean(readHeader(response.headers, 'Mcp-Session-Id')),
        bodyPreview: clip(parsed.text, 2000).text,
      }),
    };
  }

  async function runBurst(step, { url, headers, body, request, outputs, redactor, signal }) {
    const count = Math.min(Number(request.repeat.count) || 1, bounds.maxBurstRequests);
    const concurrency = Math.max(1, Math.min(Number(request.repeat.concurrency) || 1, bounds.maxConcurrency));
    const timeoutMs = Math.min((request.repeat.timeoutSeconds ?? 30) * 1000, bounds.stepTimeoutMs);
    const statusCodes = new Array(count).fill(0);
    const errors = [];
    let next = 0;

    async function worker() {
      while (next < count) {
        if (signal?.aborted) return;
        const index = next++;
        const response = await fetchOnce({ url, method: request.method ?? 'POST', headers, body, timeoutMs, signal });
        if (response.error) {
          statusCodes[index] = 0;
          if (errors.length < 20) errors.push(redactor.text(response.error));
        } else {
          statusCodes[index] = response.status;
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, worker));
    const attempted = statusCodes.filter((code) => code !== 0 || errors.length > 0).length;
    outputs.set(`${step.id}.statusCodes`, statusCodes);
    outputs.set(`${step.id}.errors`, errors);
    const histogram = {};
    for (const code of statusCodes) histogram[code] = (histogram[code] ?? 0) + 1;
    return {
      id: step.id,
      kind: 'http',
      title: step.title,
      state: signal?.aborted ? 'cancelled' : 'completed',
      detail: `${count} request(s) at concurrency ${concurrency}.`,
      evidence: {
        url: url.toString(),
        requested: count,
        attempted,
        concurrency,
        statusHistogram: histogram,
        transportErrors: errors.length,
        firstErrors: errors.slice(0, 3),
      },
    };
  }

  async function runLibrary(step, { sampleId, plan, inputs, outputs, secrets, contract, redactor, signal }) {
    const wrapper = resolvePythonWrapper(sampleId, step);
    if (wrapper.skipWhen?.({ outputs })) {
      return {
        id: step.id,
        kind: 'library',
        title: step.title,
        state: 'skipped',
        detail: wrapper.skipReason ?? 'Not needed for this run.',
        evidence: {},
      };
    }
    const preflight = await preflightPython(wrapper.modules ?? [], { signal });
    if (!preflight.ok) {
      return {
        id: step.id,
        kind: 'library',
        title: step.title,
        state: 'blocked',
        detail: preflight.detail,
        evidence: { missingModules: preflight.missing, install: preflight.install },
      };
    }
    const params = wrapper.params({ inputs, step, plan, contract, outputs });
    // Any path parameter is executed against the run workspace.
    for (const key of wrapper.workspacePaths ?? []) {
      if (!params[key]) continue;
      const target = workspace.resolve(params[key]);
      if (target.staged) await workspace.stageAccelerator();
      params[key] = target.absolute;
    }
    if (Object.prototype.hasOwnProperty.call(params, 'agentUrl') && params.agentUrl) {
      // The wrapper makes a network call, so the same https-only rule applies.
      assertExecutableUrl(params.agentUrl);
    }
    const env = {};
    for (const [name, ref] of Object.entries(wrapper.secretEnv ?? {})) {
      const value = secrets[ref];
      if (typeof value !== 'string' || value === '') throw new Error(`Missing secret value for ${ref}.`);
      env[name] = value;
    }
    const script = `${pythonRoot}/${wrapper.script}`;
    const result = await runProcess(pythonExecutable, [script], {
      signal,
      cwd: workspace.root,
      stdin: JSON.stringify(params),
      env,
    });
    const stdout = clip(result.stdout, bounds.maxOutputBytes);
    if (result.code !== 0) {
      return {
        id: step.id,
        kind: 'library',
        title: step.title,
        state: result.timedOut ? 'failed' : signal?.aborted ? 'cancelled' : 'failed',
        detail: redactor.text(clip(result.stderr, 4000).text) || `The wrapper exited ${result.code}.`,
        evidence: { exitCode: result.code, script: wrapper.script },
      };
    }
    let payload = null;
    try {
      payload = JSON.parse(stdout.text.trim().split('\n').pop() ?? 'null');
    } catch {
      return {
        id: step.id,
        kind: 'library',
        title: step.title,
        state: 'failed',
        detail: 'The wrapper succeeded but did not return a JSON result on its last stdout line.',
        evidence: { script: wrapper.script },
      };
    }
    if (payload?.error) {
      return {
        id: step.id,
        kind: 'library',
        title: step.title,
        state: 'failed',
        detail: redactor.text(String(payload.error)),
        evidence: { script: wrapper.script, type: payload.type ?? '' },
      };
    }
    const mapped = wrapper.map(payload) ?? {};
    for (const [name, value] of Object.entries(mapped.outputs ?? {})) outputs.set(`${step.id}.${name}`, value);
    if (wrapper.credential) {
      for (const value of Object.values(mapped.outputs ?? {})) redactor.add(typeof value === 'string' ? value : '');
      for (const value of Object.values(mapped.secretUpdates ?? {})) redactor.add(value);
    }
    return {
      id: step.id,
      kind: 'library',
      title: step.title,
      state: 'completed',
      detail: wrapper.summary,
      evidence: redactor.value(mapped.evidence ?? {}),
      secretUpdates: mapped.secretUpdates ?? {},
    };
  }

  /* --------------------------------------------------------------- plumbing */

  /** A path argument is rewritten to its run-workspace location. */
  async function mapPathArguments(args) {
    const out = [];
    for (const arg of args) {
      if (looksLikeWorkspacePath(arg)) {
        const target = workspace.resolve(arg);
        if (target.staged) await workspace.stageAccelerator();
        out.push(target.absolute);
      } else {
        out.push(arg);
      }
    }
    return out;
  }

  async function runProcess(executable, args, { signal, cwd, stdin, env = {} }) {
    if (!isAllowedExecutable(executable)) {
      throw new Error(`Refused to spawn "${executable}": it is not on the executable allow-list.`);
    }
    return transports.spawn({
      executable,
      args,
      cwd,
      stdin,
      env,
      signal,
      timeoutMs: bounds.stepTimeoutMs,
      maxOutputBytes: bounds.maxOutputBytes,
    });
  }

  async function preflightPython(modules, { signal }) {
    if (modules.length === 0) return { ok: true };
    const probe = modules.map((name) => `import ${name}`).join('; ');
    const result = await runProcess(pythonExecutable, ['-c', probe], { signal, cwd: workspace.root });
    if (result.code === 0) return { ok: true };
    const missing = modules.filter((name) => result.stderr.includes(name.split('.')[0]));
    const install = 'python -m pip install -r runtime/requirements.txt';
    return {
      ok: false,
      missing: missing.length > 0 ? missing : modules,
      install,
      detail:
        result.spawnFailed === true
          ? `No Python interpreter was found at \`${pythonExecutable}\`. Install Python 3.10 or newer, then run: ${install}`
          : `A required Python module is not importable. Nothing is installed for you. Run this yourself, then re-run the sample: ${install}`,
    };
  }

  async function fetchOnce({ url, method, headers, body, timeoutMs, signal }) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await transports.fetch(url.toString(), {
        method,
        headers,
        body,
        signal: controller.signal,
        // A gateway must not be able to bounce this request somewhere else.
        redirect: 'error',
      });
      const text = await readBounded(response, bounds.maxResponseBytes);
      return { status: response.status, headers: response.headers, text };
    } catch (error) {
      const aborted = signal?.aborted;
      return {
        error: aborted
          ? 'Cancelled.'
          : error?.name === 'AbortError'
            ? `Timed out after ${Math.round(timeoutMs / 1000)}s.`
            : String(error?.message ?? error),
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  return { execute, limits: bounds };
}

function looksLikeWorkspacePath(arg) {
  const value = String(arg);
  if (value.startsWith('-')) return false;
  return /^runtime\/accelerator\//.test(value) || /\.(bicep|bicepparam|xml|json)$/i.test(value);
}

async function readBounded(response, limitBytes) {
  if (typeof response.body?.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value ?? []);
      total += chunk.byteLength;
      if (total > limitBytes) {
        await reader.cancel('response limit exceeded').catch(() => {});
        throw new Error(`The response exceeded the ${limitBytes}-byte limit.`);
      }
      text += decoder.decode(chunk, { stream: true });
    }
    return `${text}${decoder.decode()}`;
  }
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf-8') > limitBytes) {
      throw new Error(`The response exceeded the ${limitBytes}-byte limit.`);
    }
    return text;
  }
  return '';
}

function captureFrom(source, { response, parsed, jsonRpcBody }) {
  const spec = String(source);
  if (spec === 'response.status') return response.status;
  if (spec === 'response.body') return clip(parsed.text, 4000).text;
  if (spec === 'response.json') return parsed.data;
  if (spec === 'response.jsonrpc.result') return jsonRpcBody?.result ?? undefined;
  if (spec === 'response.jsonrpc.error') return jsonRpcBody?.error ?? undefined;
  const header = spec.match(/^response\.headers\['(.+)'\]$/);
  if (header) return readHeader(response.headers, header[1]) ?? '';
  return undefined;
}

/** The public shape of a step result. Never carries a credential. */
function publicStep(record) {
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    state: record.state,
    durationMs: record.durationMs ?? 0,
    detail: record.detail ?? '',
    evidence: record.evidence ?? {},
    ...(record.artifactPath ? { artifactPath: record.artifactPath } : {}),
    ...(record.assertion ? { assertion: record.assertion } : {}),
  };
}

function summarise({ plan, stepResults, configurationUpdates, secretUpdates, redactor, signal, startedAt }) {
  const steps = stepResults.map(publicStep);
  const assertions = stepResults.filter((step) => step.assertion).map((step) => step.assertion);
  const failed = stepResults.filter((step) => step.state === 'failed');
  const blocked = stepResults.filter((step) => step.state === 'blocked');
  const cancelled = signal?.aborted || stepResults.some((step) => step.state === 'cancelled');
  const inconclusive = assertions.filter((assertion) => assertion.status === 'inconclusive');
  const ran = stepResults.length;
  const expected = plan.steps.length;

  let state = 'completed';
  let summary = `All ${ran} step(s) ran and every assertion passed.`;
  if (cancelled) {
    state = 'cancelled';
    summary = `Cancelled after ${ran} of ${expected} step(s).`;
  } else if (blocked.length > 0) {
    state = 'blocked';
    summary = blocked[0].detail || 'A required runtime is missing, so the sample was not run.';
  } else if (failed.length > 0) {
    state = 'failed';
    summary = `${failed.length} step(s) failed: ${failed.map((step) => step.title).join('; ')}.`;
  } else if (ran < expected) {
    state = 'inconclusive';
    summary = `Only ${ran} of ${expected} step(s) ran.`;
  } else if (inconclusive.length > 0) {
    state = 'inconclusive';
    summary = `${inconclusive.length} assertion(s) could not be decided: ${inconclusive.map((a) => a.detail).join(' ')}`;
  }

  return {
    state,
    sampleId: plan.sampleId,
    summary: redactor.text(summary),
    detail: '',
    steps,
    assertions,
    configurationUpdates,
    // Handed to the requesting browser only; never persisted, never logged.
    secretUpdates,
    meta: {
      executor: 'local',
      durationMs: Date.now() - startedAt,
      stepsRun: ran,
      stepsPlanned: expected,
      artifacts: stepResults.filter((step) => step.artifactPath).map((step) => step.artifactPath),
    },
  };
}
