/**
 * The offline self-test.
 *
 * This is deliberately NOT a twentieth catalogue recipe and NOT a live
 * scenario. It exists so a user can prove — through the real UI and the real
 * server, with zero setup — that this exact checkout behaves as documented,
 * without an Azure subscription, without a gateway, without a credential and
 * without a single outbound network call.
 *
 * What it checks are structural, offline invariants of THIS checkout: the
 * imported notebook's integrity, the fixed catalogue size, the presence of
 * the vendored offline bundle, workspace isolation, and the same-origin guard
 * that protects every state-changing endpoint (including this one). None of
 * that requires contacting Azure, so every result here carries
 * `azureContacted: false` and `liveEvidence: false` — fixed, not measured —
 * and nothing here is randomised, timestamped, or otherwise variable between
 * runs on an unchanged checkout. A caller cannot widen, narrow or otherwise
 * configure what is inspected: the request accepts exactly one field
 * (`protocolVersion`) and nothing else.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ACCELERATOR_ROOT, EXECUTION_PROTOCOL_VERSION, RUN_WORKSPACE_ROOT, SOURCE_NOTEBOOK } from '../core/types.mjs';
import { RequestRefused } from './runRequest.mjs';

/** Distinguishes this result from any of the 19 sample ids at a glance. */
export const SELF_TEST_SCENARIO = 'offline-self-test';

/**
 * Validate the self-test request body.
 *
 * The wire shape is exactly `{ protocolVersion }` — no sample id, no inputs,
 * no plan, no configuration of any kind. Anything else is refused by name so
 * this endpoint can never grow into a general-purpose inspection API.
 *
 * @param {unknown} payload
 */
export function validateSelfTestRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RequestRefused('The self-test request body must be a JSON object.');
  }
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== 'protocolVersion') {
    throw new RequestRefused(
      'The self-test request accepts exactly one field, `protocolVersion`. It never accepts a sample id, inputs, a plan or any other configuration — the checks it runs are fixed.',
      { code: 'forbidden-member' },
    );
  }
  if (payload.protocolVersion !== EXECUTION_PROTOCOL_VERSION) {
    throw new RequestRefused(
      `Unsupported protocol version ${payload.protocolVersion}. This server speaks version ${EXECUTION_PROTOCOL_VERSION}.`,
      { code: 'protocol-version' },
    );
  }
  return true;
}

/** Recompute the imported notebook's hash from disk. No network involved. */
async function checkNotebookProvenance(playgroundRoot) {
  const id = 'notebook-provenance';
  const label = 'The imported notebook on disk is byte-identical to its recorded provenance';
  try {
    const notebookPath = resolve(playgroundRoot, '..', SOURCE_NOTEBOOK.fileName);
    const bytes = await readFile(notebookPath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const passed = sha256 === SOURCE_NOTEBOOK.sha256 && bytes.length > 0;
    return {
      id,
      label,
      passed,
      detail: passed
        ? `sha256 ${sha256} (${bytes.length} bytes)`
        : `sha256 ${sha256} does not match the recorded ${SOURCE_NOTEBOOK.sha256}`,
    };
  } catch (error) {
    return { id, label, passed: false, detail: `Could not read the notebook: ${String(error?.message ?? error)}` };
  }
}

/** Exactly 19 recipes, never a twentieth. */
function checkCatalogueSize(catalogue) {
  const id = 'catalogue-sample-count';
  const label = `The catalogue declares exactly ${catalogue.expectedSampleCount} recipes`;
  const passed = catalogue.expectedSampleCount === 19 && catalogue.samples.length === catalogue.expectedSampleCount;
  return {
    id,
    label,
    passed,
    detail: `${catalogue.samples.length} sample(s) present; ${catalogue.expectedSampleCount} expected`,
  };
}

/** The vendored offline bundle is present, so an operator run needs nothing fetched. */
async function checkAcceleratorBundlePresent(playgroundRoot) {
  const id = 'accelerator-bundle-present';
  const label = 'The vendored offline accelerator bundle is present on disk';
  try {
    const base = resolve(playgroundRoot, ACCELERATOR_ROOT);
    let files = 0;
    const walk = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(resolve(dir, entry.name));
        else files += 1;
      }
    };
    await walk(base);
    return { id, label, passed: files > 0, detail: `${files} file(s) under ${ACCELERATOR_ROOT}` };
  } catch (error) {
    return { id, label, passed: false, detail: `${ACCELERATOR_ROOT} is missing: ${String(error?.message ?? error)}` };
  }
}

/** Generated run workspaces never enter version control. */
async function checkRunWorkspaceIgnored(playgroundRoot) {
  const id = 'run-workspace-ignored';
  const label = 'Generated run workspaces are excluded from version control';
  try {
    const text = await readFile(resolve(playgroundRoot, '.gitignore'), 'utf-8');
    const passed = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .some((line) => line === RUN_WORKSPACE_ROOT || line === `${RUN_WORKSPACE_ROOT}/`);
    return {
      id,
      label,
      passed,
      detail: passed ? `\`${RUN_WORKSPACE_ROOT}\` is listed in .gitignore` : `\`${RUN_WORKSPACE_ROOT}\` is not listed in .gitignore`,
    };
  } catch (error) {
    return { id, label, passed: false, detail: `Could not read .gitignore: ${String(error?.message ?? error)}` };
  }
}

/**
 * Exercise the production same-origin guard directly, with synthetic
 * requests. This proves the guard behaves correctly without making a real
 * network call to anything — including this server.
 */
function checkSameOriginGuard(checkStateChangingRequest, { port, host, publicOrigin }) {
  const id = 'same-origin-guard';
  const label = 'The same-origin guard refuses a cross-site request and accepts a same-origin one';
  const jsonHeaders = { 'content-type': 'application/json' };
  const crossSite = checkStateChangingRequest(
    { headers: { ...jsonHeaders, 'sec-fetch-site': 'cross-site' } },
    { port, host },
  );
  const sameOrigin = checkStateChangingRequest(
    {
      headers: {
        ...jsonHeaders,
        'sec-fetch-site': 'same-origin',
        ...(publicOrigin ? { origin: publicOrigin } : {}),
      },
    },
    { port, host, publicOrigin },
  );
  const passed = crossSite.ok === false && crossSite.status === 403 && sameOrigin.ok === true;
  return {
    id,
    label,
    passed,
    detail: passed
      ? 'a cross-site request was refused with 403 and a same-origin request was accepted'
      : `unexpected guard behaviour: cross-site=${JSON.stringify(crossSite)} same-origin=${JSON.stringify(sameOrigin)}`,
  };
}

/**
 * Run every offline check and return one fixed-shape result.
 *
 * Nothing here is a "sample" or a "scenario" in the catalogue's own sense —
 * `scenario` is fixed to `SELF_TEST_SCENARIO`, which never collides with a
 * catalogue id, and `azureContacted`/`liveEvidence` are hard-coded `false`
 * rather than computed, so this can never be confused with live evidence.
 *
 * @param {object} options
 * @param {string} options.playgroundRoot absolute path to `CitadelSamples/playground`
 * @param {object} options.catalogue the server's own catalogue (`CATALOGUE`)
 * @param {'preview'|'execute'} options.mode
 * @param {Function} options.checkStateChangingRequest the production guard function
 * @param {number} options.port
 * @param {string} options.host
 * @param {string|null} options.publicOrigin
 */
export async function runSelfTest({
  playgroundRoot,
  catalogue,
  mode,
  checkStateChangingRequest,
  port,
  host,
  publicOrigin = null,
}) {
  const checks = [
    await checkNotebookProvenance(playgroundRoot),
    checkCatalogueSize(catalogue),
    await checkAcceleratorBundlePresent(playgroundRoot),
    await checkRunWorkspaceIgnored(playgroundRoot),
    checkSameOriginGuard(checkStateChangingRequest, { port, host, publicOrigin }),
  ];
  const passed = checks.every((check) => check.passed);
  return Object.freeze({
    scenario: SELF_TEST_SCENARIO,
    state: passed ? 'passed' : 'failed',
    summary: passed
      ? 'All offline checks passed. This is a fixed, local demonstration — it contacted no Azure service and produced no live evidence.'
      : 'One or more offline checks failed on this checkout. See each check for detail. This is still not a live Azure scenario.',
    mode,
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    // Fixed, not measured: this endpoint never dials out, in any state.
    azureContacted: false,
    liveEvidence: false,
    checks: Object.freeze(checks),
  });
}
