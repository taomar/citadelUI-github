import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicJson } from './atomic-json.mjs';
import { transactionError } from './transactions.mjs';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const MAX_CAPABILITIES = 12;
const MAX_CAPABILITY_LENGTH = 64;
export const REGISTRY_VERSION = 4;
const COMPATIBILITY = new Set([
  'unscanned',
  'supported',
  'degraded',
  'read-only',
  'unavailable',
  'invalid-citadel-root',
]);

function id(value, name) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw transactionError(400, 'INVALID_REGISTRY_ID', `Invalid ${name}.`);
  }
  return value;
}

function label(value, name) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > 160 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw transactionError(400, 'INVALID_REGISTRY_LABEL', `Invalid ${name}.`);
  }
  return normalized;
}

function optionalTimestamp(value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || value.length > 40) {
    throw transactionError(400, 'INVALID_REGISTRY_TIMESTAMP', `Invalid ${name}.`);
  }

  return value;
}

function folderDisplayName(value) {
  const folderName = label(value, 'folder display name');
  const lowerFolderName = folderName.toLowerCase();
  if (
    folderName.includes('/') ||
    folderName.includes('\\') ||
    folderName === '.' ||
    folderName === '..' ||
    lowerFolderName === '.azure' ||
    lowerFolderName === '.env' ||
    lowerFolderName.startsWith('.env.')
  ) {
    throw transactionError(400, 'INVALID_FOLDER_NAME', 'Folder display name must not be a path.');
  }
  return folderName;
}

function displayPath(value) {
  const localPath =
    value === null || value === undefined ? null : String(value).trim();
  if (
    localPath !== null &&
    (
      !localPath ||
      localPath.length > 1024 ||
      /[\u0000-\u001f\u007f]/.test(localPath) ||
      !/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/.test(localPath)
    )
  ) {
    throw transactionError(400, 'INVALID_LOCAL_PATH', 'Local path must be an absolute display path.');
  }
  return localPath;
}

function gitRefName(value, name) {
  const ref = typeof value === 'string' ? value.trim() : '';
  if (
    !ref ||
    ref.length > 255 ||
    /[\u0000-\u001f\u007f ~^:?*[\\]/.test(ref) ||
    ref.includes('..') ||
    ref.includes('//') ||
    ref.includes('@{') ||
    ref.startsWith('/') ||
    ref.endsWith('/') ||
    ref.startsWith('-') ||
    ref.endsWith('.lock') ||
    ref === '@' ||
    ref.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))
  ) {
    throw transactionError(400, 'INVALID_REGISTRY_BRANCH', `Invalid ${name}.`);
  }
  return ref;
}

function repositoryFullName(value) {
  const fullName = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(fullName)) {
    throw transactionError(400, 'INVALID_REGISTRY_REPOSITORY', 'Invalid repository full name.');
  }
  return fullName;
}

/**
 * Tagged source union for registry v4.
 *
 * `source` is the single authority for where an environment's files live. A v2
 * record has no `source`, so its flat folder fields are migrated into a
 * `kind: 'local'` source here rather than being carried alongside it, which
 * keeps exactly one description of the source per environment.
 *
 * v4 adds connection ownership to the GitHub arm. A GitHub environment names the
 * connection profile it was attached through, the exact branch the user chose,
 * the head that branch was validated at, and what Citadel detected there. It
 * still never carries a token or a credential session id: a profile id is a
 * durable metadata reference, and the credential it may unlock lives elsewhere.
 *
 * `connectionProfileId` is nullable because a v3 record predates profiles and
 * cannot be given one honestly — there is no recorded account identity to bind
 * it to. Such a record is shown as needing reconnection, and the first reconnect
 * binds it.
 */
function environmentSource(value, legacy) {
  if (value === undefined || value === null) {
    return {
      kind: 'local',
      folderName: folderDisplayName(legacy.folderName),
      localPath: displayPath(legacy.localPath),
    };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw transactionError(400, 'INVALID_REGISTRY_SOURCE', 'Invalid environment source.');
  }
  if (value.kind === 'local') {
    if (Object.keys(value).some((key) => !['kind', 'folderName', 'localPath'].includes(key))) {
      throw transactionError(400, 'INVALID_REGISTRY_SOURCE', 'Local source contains unsupported fields.');
    }
    return {
      kind: 'local',
      folderName: folderDisplayName(value.folderName),
      localPath: displayPath(value.localPath),
    };
  }
  if (value.kind === 'github') {
    const allowed = new Set([
      'kind',
      'connectionProfileId',
      'repositoryId',
      'fullName',
      'sourceBranch',
      'workingBranch',
      'writeMode',
      'lastKnownHead',
      'capabilities',
      'validatedAt',
    ]);
    if (Object.keys(value).some((key) => !allowed.has(key))) {
      throw transactionError(400, 'INVALID_REGISTRY_SOURCE', 'GitHub source contains unsupported fields.');
    }
    const repositoryId = Number(value.repositoryId);
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
      throw transactionError(400, 'INVALID_REGISTRY_SOURCE', 'Invalid repository id.');
    }
    const writeMode = value.writeMode === undefined ? 'working-branch' : String(value.writeMode);
    if (writeMode !== 'working-branch' && writeMode !== 'direct') {
      throw transactionError(400, 'INVALID_REGISTRY_SOURCE', 'Invalid GitHub write mode.');
    }
    return {
      kind: 'github',
      connectionProfileId: optionalId(value.connectionProfileId, 'connection profile id'),
      repositoryId,
      fullName: repositoryFullName(value.fullName),
      sourceBranch: gitRefName(value.sourceBranch, 'source branch'),
      workingBranch: gitRefName(value.workingBranch, 'working branch'),
      writeMode,
      lastKnownHead: optionalCommit(value.lastKnownHead),
      capabilities: capabilityList(value.capabilities),
      validatedAt: optionalTimestamp(value.validatedAt, 'validation time'),
    };
  }
  throw transactionError(400, 'INVALID_REGISTRY_SOURCE', 'Unsupported environment source kind.');
}

function optionalId(value, name) {
  if (value === null || value === undefined || value === '') return null;
  return id(value, name);
}

function optionalCommit(value) {
  if (value === null || value === undefined || value === '') return null;
  const sha = String(value).toLowerCase();
  if (!COMMIT_PATTERN.test(sha)) {
    throw transactionError(400, 'INVALID_REGISTRY_SOURCE', 'Invalid last known head.');
  }
  return sha;
}

/**
 * What Citadel detected on the validated branch, for display only.
 *
 * Bounded in both directions: a list this long or a string this wide is not a
 * capability name, and the catalogue renders these directly.
 */
function capabilityList(value) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length > MAX_CAPABILITIES) {
    throw transactionError(400, 'INVALID_REGISTRY_SOURCE', 'Invalid capability list.');
  }
  return value.map((item) => {
    const text = typeof item === 'string' ? item.trim() : '';
    if (!text || text.length > MAX_CAPABILITY_LENGTH || /[\u0000-\u001f\u007f]/.test(text)) {
      throw transactionError(400, 'INVALID_REGISTRY_SOURCE', 'Invalid capability name.');
    }
    return text;
  });
}

function positiveInteger(value, name) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 1_000_000) {
    throw transactionError(400, 'INVALID_REGISTRY_VERSION', `Invalid ${name}.`);
  }
  return normalized;
}

function project(value) {
  const allowed = new Set(['id', 'label', 'createdAt', 'updatedAt']);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw transactionError(400, 'INVALID_REGISTRY_PROJECT', 'Invalid project metadata.');
  }
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw transactionError(400, 'INVALID_REGISTRY_PROJECT', 'Project metadata contains unsupported fields.');
  }
  return {
    id: id(value.id, 'project id'),
    label: label(value.label, 'project label'),
    createdAt: optionalTimestamp(value.createdAt, 'project created time'),
    updatedAt: optionalTimestamp(value.updatedAt, 'project updated time'),
  };
}

function environment(value) {
  const allowed = new Set([
    'id',
    'projectId',
    'label',
    'source',
    'folderName',
    'localPath',
    'fingerprint',
    'toolVersion',
    'settingsVersion',
    'fingerprintVersion',
    'compatibility',
    'createdAt',
    'updatedAt',
    'lastOpenedAt',
    'lastScannedAt',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw transactionError(400, 'INVALID_REGISTRY_ENVIRONMENT', 'Invalid environment metadata.');
  }
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw transactionError(
      400,
      'INVALID_REGISTRY_ENVIRONMENT',
      'Environment metadata contains unsupported fields.'
    );
  }
  const source = environmentSource(value.source, value);
  const fingerprint =
    value.fingerprint === null || value.fingerprint === undefined ? null : String(value.fingerprint);
  if (fingerprint !== null && !HASH_PATTERN.test(fingerprint)) {
    throw transactionError(400, 'INVALID_FINGERPRINT', 'Invalid capability fingerprint.');
  }
  const compatibility = String(value.compatibility || 'unscanned');
  if (!COMPATIBILITY.has(compatibility)) {
    throw transactionError(400, 'INVALID_COMPATIBILITY', 'Invalid compatibility state.');
  }
  return {
    id: id(value.id, 'environment id'),
    projectId: id(value.projectId, 'project id'),
    label: label(value.label, 'environment label'),
    source,
    fingerprint,
    toolVersion: label(value.toolVersion || '1.0.0-local', 'tool version'),
    settingsVersion: positiveInteger(value.settingsVersion || 1, 'settings version'),
    fingerprintVersion: positiveInteger(value.fingerprintVersion || 1, 'fingerprint version'),
    compatibility,
    createdAt: optionalTimestamp(value.createdAt, 'environment created time'),
    updatedAt: optionalTimestamp(value.updatedAt, 'environment updated time'),
    lastOpenedAt: optionalTimestamp(value.lastOpenedAt, 'environment opened time'),
    lastScannedAt: optionalTimestamp(value.lastScannedAt, 'environment scanned time'),
  };
}

/**
 * Upgrade a persisted registry document to v4.
 *
 * Only known older versions are migrated. A document from a newer Citadel UI is
 * left byte-identical and refused, because silently rewriting it would drop
 * fields this version does not understand.
 *
 * v3 GitHub sources gain the connection-ownership fields as nulls. They are not
 * invented: a v3 record has no recorded account identity, so binding it to a
 * profile here would be a guess, and a guess about which credential owns a
 * repository is exactly the thing this schema exists to prevent. Those records
 * surface as `Reconnect`.
 *
 * Environment labels become unique per project in v4. Existing data may violate
 * that, and refusing to start would strand a user's whole registry behind a rule
 * added for their benefit, so duplicates are suffixed deterministically instead.
 */
function migrate(current) {
  const version = Number(current?.version ?? 1);
  if (version === REGISTRY_VERSION) return current;
  if (version > REGISTRY_VERSION) {
    throw transactionError(
      409,
      'REGISTRY_VERSION_UNSUPPORTED',
      `This /data registry was written by a newer Citadel UI (schema v${version}). Upgrade Citadel UI or point it at a different data directory.`
    );
  }
  if (version !== 1 && version !== 2 && version !== 3) {
    throw transactionError(
      409,
      'REGISTRY_VERSION_UNSUPPORTED',
      `Unsupported Citadel registry schema v${version}.`
    );
  }
  const taken = new Map();
  return {
    ...current,
    version: REGISTRY_VERSION,
    environments: (current?.environments || []).map((item) => {
      const record = item?.source
        ? { ...item }
        : (() => {
            const { folderName, localPath, ...rest } = item || {};
            return {
              ...rest,
              source: {
                kind: 'local',
                folderName: folderName || 'Selected folder',
                localPath: localPath ?? null,
              },
            };
          })();
      if (record.source?.kind === 'github') {
        record.source = {
          connectionProfileId: null,
          lastKnownHead: null,
          capabilities: null,
          validatedAt: null,
          ...record.source,
        };
      }
      record.label = uniqueLabel(record.label, record.projectId, taken);
      return record;
    }),
  };
}

/** Deterministic de-duplication used only by migration. */
function uniqueLabel(value, projectId, taken) {
  const base = typeof value === 'string' && value.trim() ? value.trim() : 'Environment';
  const scope = String(projectId || '');
  let candidate = base;
  let counter = 2;
  while (taken.has(`${scope}\u0000${labelKey(candidate)}`)) {
    const suffix = ` (${counter})`;
    candidate = `${base.slice(0, 160 - suffix.length)}${suffix}`;
    counter += 1;
  }
  taken.set(`${scope}\u0000${labelKey(candidate)}`, true);
  return candidate;
}

function labelKey(value) {
  return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

/**
 * Two invariants the catalogue depends on, enforced over the merged result
 * rather than over the incoming batch.
 *
 * Checking only what the browser sent would let a rename collide with a record
 * it did not resend, so both rules are evaluated against the document that is
 * about to be written.
 *
 * 1. An environment label is unique inside its project, because the catalogue,
 *    the command bar and every activity line identify a workspace by that label.
 * 2. One repository and source branch is attached once per project and
 *    connection. The same branch reached through a different connection is a
 *    legitimately different workspace; the same branch twice through the same
 *    connection is a duplicate the user meant to open, not create.
 */
function assertUnique(environments) {
  const labels = new Set();
  const attachments = new Set();
  for (const item of environments) {
    const labelIdentity = `${item.projectId}\u0000${labelKey(item.label)}`;
    if (labels.has(labelIdentity)) {
      throw transactionError(
        409,
        'DUPLICATE_ENVIRONMENT_LABEL',
        `This project already has a workspace named "${item.label}". Choose a different name.`
      );
    }
    labels.add(labelIdentity);
    if (item.source?.kind !== 'github') continue;
    const attachmentIdentity = [
      item.projectId,
      item.source.connectionProfileId || '',
      item.source.repositoryId,
      item.source.sourceBranch,
    ].join('\u0000');
    if (attachments.has(attachmentIdentity)) {
      throw transactionError(
        409,
        'DUPLICATE_ENVIRONMENT_SOURCE',
        `${item.source.fullName} on ${item.source.sourceBranch} is already attached to this project through this connection. Open the existing workspace instead.`
      );
    }
    attachments.add(attachmentIdentity);
  }
}

export class RegistryStore {
  constructor(options) {
    this.path = join(options.dataRoot, 'settings', 'registry.json');
    this.now = options.now || (() => Date.now());
    this.queue = Promise.resolve();
  }

  async initialize() {
    try {
      const current = JSON.parse(await readFile(this.path, 'utf8'));
      const upgraded = migrate(current);
      if (!current.epoch || upgraded !== current) {
        await atomicJson(this.path, { ...upgraded, epoch: current.epoch || randomUUID() });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await atomicJson(this.path, {
        version: REGISTRY_VERSION,
        epoch: randomUUID(),
        revision: 0,
        updatedAt: new Date(this.now()).toISOString(),
        projects: [],
        environments: [],
      });
    }
  }

  async read() {
    const current = JSON.parse(await readFile(this.path, 'utf8'));
    const upgraded = migrate(current);
    if (current.epoch && upgraded === current) return current;
    const next = { ...upgraded, epoch: current.epoch || randomUUID() };
    await atomicJson(this.path, next);
    return next;
  }

  /**
   * Authoritative source record for one environment.
   *
   * GitHub routes resolve repository and branch from here rather than trusting
   * request parameters, so a browser cannot point an environment at a different
   * repository by editing a request body.
   */
  async getEnvironment(environmentId) {
    const current = await this.read();
    return current.environments.find((item) => item.id === environmentId) || null;
  }

  async reconcile(input = {}) {
    const work = async () => {
      for (const [name, value, limit] of [
        ['projects', input.projects ?? [], 100],
        ['environments', input.environments ?? [], 500],
        ['removed project ids', input.removedProjectIds ?? [], 100],
        ['removed environment ids', input.removedEnvironmentIds ?? [], 500],
      ]) {
        if (!Array.isArray(value) || value.length > limit) {
          throw transactionError(400, 'INVALID_REGISTRY_LIST', `Invalid ${name}.`);
        }
      }
      const current = await this.read();
      if (
        input.expectedEpoch !== current.epoch ||
        input.expectedRevision !== current.revision
      ) {
        throw transactionError(
          409,
          'REGISTRY_CONFLICT',
          'Registry metadata changed or was reset. Reload before saving.'
        );
      }
      const projects = new Map(current.projects.map((item) => [item.id, item]));
      const environments = new Map(current.environments.map((item) => [item.id, item]));
      for (const projectId of input.removedProjectIds || []) {
        const key = id(projectId, 'removed project id');
        projects.delete(key);
        for (const item of environments.values()) {
          if (item.projectId === key) environments.delete(item.id);
        }
      }
      for (const environmentId of input.removedEnvironmentIds || []) {
        environments.delete(id(environmentId, 'removed environment id'));
      }
      for (const candidate of input.projects || []) {
        const item = project(candidate);
        projects.set(item.id, item);
      }
      for (const candidate of input.environments || []) {
        const item = environment(candidate);
        if (!projects.has(item.projectId)) {
          throw transactionError(400, 'UNKNOWN_REGISTRY_PROJECT', 'Environment project is unknown.');
        }
        environments.set(item.id, item);
      }
      const merged = [...environments.values()];
      assertUnique(merged);
      const next = {
        version: REGISTRY_VERSION,
        epoch: current.epoch,
        revision: current.revision + 1,
        updatedAt: new Date(this.now()).toISOString(),
        projects: [...projects.values()].sort((left, right) => left.label.localeCompare(right.label)),
        environments: merged.sort((left, right) => left.label.localeCompare(right.label)),
      };
      await atomicJson(this.path, next);
      return next;
    };
    const result = this.queue.then(work, work);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
