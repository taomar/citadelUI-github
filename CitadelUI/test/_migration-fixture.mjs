import assert from 'node:assert/strict';
import { BrowserDirectoryProvider } from '../web/js/directory-provider.mjs';
import { MigrationDonor } from '../web/js/migration-donor.mjs';
import { MigrationSession } from '../web/js/migration-session.mjs';
import { LocalTransactionCoordinator } from '../web/js/mutation-coordinator.mjs';
import { createTransactionCommit } from '../web/js/transaction-client.mjs';
import { sha256 } from '../shared/source-scope.mjs';

export const encode = (text) => new TextEncoder().encode(text);
export const decode = (bytes) => new TextDecoder().decode(bytes);
const missing = () => new DOMException('Synthetic missing entry', 'NotFoundError');

/** Synthetic browser handles. No host-path access and no OS picker automation. */
export class MigrationFileHandle {
  kind = 'file';
  constructor(name, text = '', trace = [], entry = null) {
    this.name = name;
    this.trace = trace;
    this.entry = entry || { bytes: encode(text), revision: 1 };
    this.permission = 'granted';
    this.beforeRead = null;
  }
  async queryPermission(options) { this.trace.push(`permission:${options.mode}:${this.name}`); return this.permission; }
  async requestPermission(options) { this.trace.push(`request:${options.mode}:${this.name}`); return this.permission; }
  async isSameEntry(other) { return this.entry === other?.entry; }
  async getFile() {
    await this.beforeRead?.();
    this.trace.push(`read:${this.name}`);
    const bytes = this.entry.bytes.slice();
    return { size: bytes.byteLength, lastModified: this.entry.revision, arrayBuffer: async () => bytes.buffer };
  }
  async createWritable() {
    this.trace.push(`writable:${this.name}`);
    let staged;
    return {
      write: async (bytes) => { staged = bytes.slice(); },
      close: async () => { this.entry.bytes = staged; this.entry.revision += 1; this.trace.push(`write:${this.name}`); },
      abort: async () => { this.trace.push(`abort:${this.name}`); },
    };
  }
  replace(text) { this.entry.bytes = encode(text); this.entry.revision += 1; }
  alias(name) { return new MigrationFileHandle(name, '', this.trace, this.entry); }
  text() { return decode(this.entry.bytes); }
}

export class MigrationDirectoryHandle {
  kind = 'directory';
  constructor(name, files = {}, trace = [], entry = null) {
    this.name = name;
    this.trace = trace;
    this.entry = entry || { children: new Map() };
    this.permission = 'granted';
    if (!entry) {
      for (const [key, value] of Object.entries(files)) {
        this.entry.children.set(key, value?.kind ? value : typeof value === 'string'
          ? new MigrationFileHandle(key, value, trace)
          : new MigrationDirectoryHandle(key, value, trace));
      }
    }
  }
  get children() { return this.entry.children; }
  async isSameEntry(other) { return this.entry === other?.entry; }
  async queryPermission(options) { this.trace.push(`permission:${options.mode}:${this.name}`); return this.permission; }
  async requestPermission(options) { this.trace.push(`request:${options.mode}:${this.name}`); return this.permission; }
  async *entries() { this.trace.push(`enumerate:${this.name}`); yield* this.children; }
  async getDirectoryHandle(name, options = {}) {
    this.trace.push(`directory:${name}:create=${Boolean(options.create)}`);
    let handle = this.children.get(name);
    if (!handle && options.create) {
      handle = new MigrationDirectoryHandle(name, {}, this.trace);
      this.children.set(name, handle);
    }
    if (handle?.kind !== 'directory') throw missing();
    return handle;
  }
  async getFileHandle(name, options = {}) {
    this.trace.push(`file:${name}:create=${Boolean(options.create)}`);
    let handle = this.children.get(name);
    if (!handle && options.create) {
      handle = new MigrationFileHandle(name, '', this.trace);
      this.children.set(name, handle);
    }
    if (handle?.kind !== 'file') throw missing();
    return handle;
  }
  async resolve(handle) {
    if (await this.isSameEntry(handle)) return [];
    for (const [name, child] of this.children) {
      if (await child.isSameEntry(handle)) return [name];
      if (child.kind === 'directory') {
        const path = await child.resolve(handle);
        if (path !== null) return [name, ...path];
      }
    }
    return null;
  }
  alias(name) { return new MigrationDirectoryHandle(name, {}, this.trace, this.entry); }
}

export function folderFromFiles(name, files, trace = []) {
  const root = {};
  for (const [alias, content] of Object.entries(files)) {
    const parts = alias.split('/');
    const leaf = parts.pop();
    let directory = root;
    for (const part of parts) directory = directory[part] ||= {};
    directory[leaf] = content;
  }
  return new MigrationDirectoryHandle(name, root, trace);
}

export function migrationTransactionApi(hooks = {}) {
  const trace = [];
  const bodies = [];
  const backups = new Map();
  let preparation;
  const request = async (path, options = {}) => {
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
    if (body) bodies.push({ path, body });
    if (path === '/api/transactions/prepare') {
      trace.push('prepare');
      preparation = body;
      await hooks.prepare?.();
      return {
        transaction: {
          transactionId: 'synthetic-migration-transaction',
          files: body.files.map((file, index) => ({ ...file, id: `file-${index}` })),
        },
        transactionToken: 'synthetic-transaction-token',
      };
    }
    if (path.includes('/backups/') && options.method === 'PUT') {
      trace.push('backup');
      const id = path.split('/').at(-1);
      assert.equal(await sha256(options.body), options.headers['X-Citadel-Content-SHA256']);
      backups.set(id, options.body.slice());
      await hooks.backup?.();
      return { verified: true };
    }
    if (path.endsWith('/authorize')) {
      trace.push('authorize');
      assert.equal(backups.size, preparation.files.length);
      await hooks.authorize?.();
      return { authorizationToken: 'synthetic-authorization', manifestHash: 'a'.repeat(64) };
    }
    if (path.endsWith('/committing')) {
      trace.push('committing');
      await hooks.committing?.();
      return { status: 'committing' };
    }
    if (path.endsWith('/receipt')) {
      trace.push('receipt');
      await hooks.receipt?.();
      return { status: 'committed' };
    }
    if (path.includes('/backups/') && options.responseType === 'bytes') {
      trace.push('restore-backup');
      return { bytes: backups.get(path.split('?')[0].split('/').at(-1)).slice() };
    }
    if (path.endsWith('/rollback')) { trace.push('rollback'); return { status: 'rolled-back' }; }
    if (path.endsWith('/fail')) { trace.push('fail'); return { status: 'failed' }; }
    throw new Error('Unexpected synthetic transaction request');
  };
  return { request, trace, bodies, backups };
}

export const TARGET = 'bicep/infra/main.bicepparam';
export const TEMPLATE = 'bicep/infra/main.bicep';
export const CURRENT = "using './main.bicep'\n// current documentation\nparam Count = 2\nparam newDefault = true\n";
export const SCHEMA = "@minValue(1)\n@maxValue(8)\nparam Count int\nparam newDefault bool = true\n";
export const LEGACY = "using './legacy.bicep'\nparam count = 4\nparam removed = 'legacy-only'\n";

let snapshotTestRequest;
export function useSnapshotTestRequest(request) { snapshotTestRequest = request; }

export function migrationHarness(options = {}) {
  const targetTrace = [];
  const donorTrace = [];
  const root = folderFromFiles('current', options.targetFiles || {
    [TARGET]: options.targetText ?? CURRENT,
    [TEMPLATE]: options.schemaText ?? SCHEMA,
  }, targetTrace);
  const donorRoot = folderFromFiles('older-donor', options.donorFiles || {
    'main.bicepparam': options.donorText ?? LEGACY,
  }, donorTrace);
  const provider = new BrowserDirectoryProvider(root);
  const context = {
    projectId: 'synthetic-project',
    environment: {
      id: 'synthetic-current', label: 'Current workspace',
      source: { kind: 'local', folderName: 'current', localPath: 'C:\\synthetic\\current' },
    },
    provider,
  };
  const state = { context, pending: false, draft: null };
  const snapshotTargets = new Map();
  const registry = {
    getDraft: async () => state.draft,
    rememberMigrationSnapshotTarget: async (id, handle) => { snapshotTargets.set(id, handle); },
    migrationSnapshotTarget: async (id) => snapshotTargets.get(id),
    forgetMigrationSnapshotTarget: async (id) => { snapshotTargets.delete(id); },
  };
  const api = migrationTransactionApi(options.hooks || {});
  const coordinator = new LocalTransactionCoordinator({
    request: api.request, commitFiles: createTransactionCommit(api.request),
  });
  const session = new MigrationSession({
    contextProvider: () => state.context,
    registry, coordinator,
    pendingEdits: () => state.pending,
    projectLabel: 'Synthetic project',
    snapshotRequest: options.snapshotRequest || snapshotTestRequest,
  });
  const donor = new MigrationDonor({ folder: donorRoot });
  return {
    session, donor, donorRoot, root, provider, context, state, registry, coordinator, api,
    targetTrace, donorTrace,
    plan: (extra = {}) => session.plan({ donor, sourceIds: ['main.bicepparam'], targetAlias: TARGET, ...extra }),
  };
}

export async function acceptCount(harness) {
  const view = await harness.plan();
  const row = view.rows.find((entry) => entry.name.toLowerCase() === 'count');
  harness.session.decide(row.id, { kind: 'accept', candidateId: row.candidates[0].id, semanticReviewed: true });
  harness.session.keepRemaining();
  return harness.session.preview();
}

export function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
