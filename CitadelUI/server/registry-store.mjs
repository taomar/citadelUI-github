import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { transactionError } from './transactions.mjs';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
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
  const folderName = label(value.folderName, 'folder display name');
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
  const fingerprint =
    value.fingerprint === null || value.fingerprint === undefined ? null : String(value.fingerprint);
  if (fingerprint !== null && !HASH_PATTERN.test(fingerprint)) {
    throw transactionError(400, 'INVALID_FINGERPRINT', 'Invalid capability fingerprint.');
  }
  const localPath =
    value.localPath === null || value.localPath === undefined
      ? null
      : String(value.localPath).trim();
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
  const compatibility = String(value.compatibility || 'unscanned');
  if (!COMPATIBILITY.has(compatibility)) {
    throw transactionError(400, 'INVALID_COMPATIBILITY', 'Invalid compatibility state.');
  }
  return {
    id: id(value.id, 'environment id'),
    projectId: id(value.projectId, 'project id'),
    label: label(value.label, 'environment label'),
    folderName,
    localPath,
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

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
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
      if (!current.epoch) {
        await atomicJson(this.path, {
          ...current,
          version: 2,
          epoch: randomUUID(),
        });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await atomicJson(this.path, {
        version: 2,
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
    if (current.epoch) return current;
    const upgraded = {
      ...current,
      version: 2,
      epoch: randomUUID(),
    };
    await atomicJson(this.path, upgraded);
    return upgraded;
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
      const next = {
        version: 2,
        epoch: current.epoch,
        revision: current.revision + 1,
        updatedAt: new Date(this.now()).toISOString(),
        projects: [...projects.values()].sort((left, right) => left.label.localeCompare(right.label)),
        environments: [...environments.values()].sort((left, right) =>
          left.label.localeCompare(right.label)
        ),
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
