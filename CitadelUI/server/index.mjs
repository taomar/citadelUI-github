/**
 * Citadel UI local server.
 *
 * Zero dependencies by necessity: the npm registry is unreachable from this
 * environment, so the whole application runs on Node built-ins with no install
 * and no build step. It binds to loopback only — this is a local authoring tool
 * for parameter files, not a deployment service.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';

import { port, host, webRoot, repoRoot } from './config.mjs';
import { discoverDeployments, readDeployment } from './discovery.mjs';
import { getSchema, clearSchemaCache } from './bicep.mjs';
import { nodeToValue } from './bicepparam/parser.mjs';
import { previewEdits, saveEdits, saveText } from './save.mjs';
import {
  listContracts,
  readContract,
  createContract,
  snapshotContract,
  orphanedSnapshots,
  restoreContract,
  applyPolicyChanges,
  readPolicyControls,
  POLICY_VARIABLES,
  THROTTLE_SPECS,
  SEMANTIC_CACHE_SPEC,
  CONTENT_SAFETY_CATEGORIES,
  CONTENT_SAFETY_OUTPUT_TYPES,
} from './contracts.mjs';
import { buildOutline } from './doclayer.mjs';
import { FOCUS_AREAS } from './focus.mjs';
import { listEnvironments, readEnvironment, writeEnvironment, resolveEnvValue } from './envlayer.mjs';
import { aggregateAccessContractTargets } from './access-targets.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Serialize a parsed document into the shape the form layer consumes. */
function documentToJson(deployment) {
  // Section layout, prose and per-parameter documentation all come from the
  // banner comments the file already carries. See doclayer.mjs for why this is
  // derived rather than curated.
  const outline = buildOutline(deployment.text, deployment.doc.params);

  return {
    path: deployment.path,
    mtimeMs: deployment.mtimeMs,
    size: deployment.size,
    using: deployment.doc.using ? deployment.doc.using.path : null,
    text: deployment.text,
    outline,
    params: deployment.doc.params.map((p) => ({
      name: p.name,
      kind: p.value.kind,
      value: nodeToValue(p.value),
      raw: deployment.text.slice(p.value.start, p.value.end),
      span: { start: p.value.start, end: p.value.end },
      doc: outline.paramDocs[p.name] || null,
    })),
  };
}

const routes = {
  'GET /api/health': async () => ({
    ok: true,
    repoRoot,
    schemaSource: 'repository',
  }),

  'GET /api/deployments': async () => {
    const data = discoverDeployments();
    return { ...data, environments: listEnvironments() };
  },

  'GET /api/deployment': async (_req, url) => {
    const path = url.searchParams.get('path');
    if (!path) throw Object.assign(new Error('Missing ?path'), { status: 400 });
    const deployment = readDeployment(path);
    const all = discoverDeployments().files;
    const meta = all.find((f) => f.path === path) || null;
    const schema = meta ? await getSchema(meta.template) : { available: false, parameters: {} };
    return { ...documentToJson(deployment), meta, schema };
  },

  'POST /api/preview': async (req) => {
    const { path, operations } = await readBody(req);
    return previewEdits(path, operations || []);
  },

  'POST /api/save': async (req) => {
    const { path, operations, expectedMtimeMs } = await readBody(req);
    return saveEdits(path, operations || [], { expectedMtimeMs });
  },

  /* ------------------------------------------------------------- focus mode */

  'GET /api/focus': async () => ({ areas: FOCUS_AREAS }),

  /* -------------------------------------------------------- access contracts */

  'GET /api/contracts': async () => {
    const listed = listContracts();
    // Surface anything whose folder has gone missing, so a contract that was
    // removed outside this app is offered back rather than silently lost.
    return { ...listed, recoverable: orphanedSnapshots() };
  },

  'GET /api/access-contract-targets': async (_req, url) =>
    aggregateAccessContractTargets({ environment: url.searchParams.get('environment') || null }),

  'POST /api/contract/restore': async (req) => {
    const { id } = await readBody(req);
    if (!id) throw Object.assign(new Error('Missing contract id'), { status: 400 });
    return restoreContract(id);
  },


  'GET /api/contract': async (_req, url) => {
    const id = url.searchParams.get('id');
    if (!id) throw Object.assign(new Error('Missing ?id'), { status: 400 });
    const contract = readContract(id);
    // Serve the parameter file in exactly the same shape as a standalone
    // deployment so the frontend has one renderer, not two.
    const doc = documentToJson(readDeployment(contract.paramFile));
    const meta = discoverDeployments().files.find((f) => f.path === contract.paramFile) || null;
    const schema = meta ? await getSchema(meta.template) : { available: false, parameters: {} };
    return { ...contract, param: { ...contract.param, ...doc, meta, schema }, meta, schema };
  },

  'POST /api/contract/create': async (req) => {
    const { name, parent } = await readBody(req);
    return createContract({ name, parent });
  },

  'POST /api/contract/policy': async (req) => {
    const { path, changes, text, expectedMtimeMs } = await readBody(req);
    if (!path) throw Object.assign(new Error('Missing policy path'), { status: 400 });

    // Two ways in: structured control edits, or the raw XML from the editor.
    // Structured edits are re-applied server-side against the file on disk so a
    // stale client can never clobber an out-of-band change.
    let next = text;
    if (changes && Object.keys(changes).length) {
      next = applyPolicyChanges(readFileSync(join(repoRoot, path), 'utf8'), changes);
    }
    if (typeof next !== 'string') {
      throw Object.assign(new Error('Nothing to save'), { status: 400 });
    }
    return saveText(path, next, { expectedMtimeMs, onSaved: () => snapshotContract(dirname(path)) });
  },

  'POST /api/contract/policy/preview': async (req) => {
    const { path, changes, text } = await readBody(req);
    if (!path) throw Object.assign(new Error('Missing policy path'), { status: 400 });
    const before = readFileSync(join(repoRoot, path), 'utf8');
    const after =
      changes && Object.keys(changes).length
        ? applyPolicyChanges(before, changes)
        : typeof text === 'string'
          ? text
          : before;
    return { path, before, after, changed: after !== before, controls: readPolicyControls(after) };
  },

  'GET /api/environments': async () => ({ environments: listEnvironments() }),

  'GET /api/environment': async (_req, url) => {
    const name = url.searchParams.get('name');
    if (!name) throw Object.assign(new Error('Missing ?name'), { status: 400 });
    return readEnvironment(name);
  },

  'POST /api/environment': async (req) => {
    const { name, updates } = await readBody(req);
    if (!name) throw Object.assign(new Error('Missing environment name'), { status: 400 });
    return writeEnvironment(name, updates || {});
  },

  'POST /api/resolve': async (req) => {
    const { environment, variables } = await readBody(req);
    const env = environment ? readEnvironment(environment) : { entries: [] };
    return {
      environment: environment || null,
      resolved: (variables || []).map((v) => resolveEnvValue(env.entries, v.name, v.default)),
    };
  },

  /**
   * Models actually onboarded behind the gateway.
   *
   * A contract's `allowedModels` is a filter over what the gateway serves, so
   * naming a model that no backend hosts produces a product that rejects every
   * request for it. Reading the onboarding file turns that from a typing
   * exercise into a choice, and marks any name the gateway does not serve.
   */
  'GET /api/onboarded-models': async () => {
    const { doc } = readDeployment('bicep/infra/llm-backend-onboarding/main.bicepparam');
    const param = doc.params.find((p) => p.name === 'llmBackendConfig');
    const entries = param ? nodeToValue(param.value) : [];
    const seen = new Map();

    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || typeof entry !== 'object') continue;
      for (const model of entry.supportedModels || []) {
        if (!model || typeof model.name !== 'string') continue;
        const found = seen.get(model.name) || {
          name: model.name,
          backendType: entry.backendType || null,
          backends: [],
        };
        if (entry.backendId) found.backends.push(entry.backendId);
        seen.set(model.name, found);
      }
    }

    return { models: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  },

  /** The documented policy switches, so the browser and the writer agree on the set. */
  'GET /api/policy-variables': async () => ({
    variables: POLICY_VARIABLES,
    throttles: THROTTLE_SPECS,
    semanticCache: SEMANTIC_CACHE_SPEC,
    contentSafety: {
      categories: CONTENT_SAFETY_CATEGORIES,
      outputTypes: CONTENT_SAFETY_OUTPUT_TYPES,
    },
  }),

  'POST /api/refresh-schema': async () => {
    clearSchemaCache();
    return { ok: true };
  },
};

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = normalize(join(webRoot, rel));
  if (!target.startsWith(webRoot)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(target);
    if (info.isDirectory()) throw new Error('directory');
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const key = `${req.method} ${url.pathname}`;

  if (url.pathname.startsWith('/api/')) {
    const handler = routes[key];
    if (!handler) return sendJson(res, 404, { error: `No route for ${key}` });
    try {
      const result = await handler(req, url);
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.message });
    }
  }

  if (req.method !== 'GET') {
    res.writeHead(405).end('Method not allowed');
    return;
  }
  await serveStatic(req, res, url.pathname);
});

server.listen(port, host, () => {
  console.log(`\n  Citadel UI`);
  console.log(`  repository : ${repoRoot}`);
  console.log(`  serving    : http://${host}:${port}\n`);
});
