/**
 * One private Azure CLI profile for one loopback execute-server launch.
 *
 * The generated directory is never returned by an HTTP response or written to a
 * log. A marker lets a later launch conservatively reap only old directories
 * created by this application after their owning process is gone.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

const BASE_DIRECTORY_NAME = 'citadel-publish-playground';
const CONTEXT_NAME =
  /^citadel-publish-playground(?:-[0-9]+)?-azure-cli-[0-9a-f]{32}$/;
const MARKER_NAME = '.citadel-private-azure-cli-context.json';
const MARKER_KIND = 'citadel-private-azure-cli-context';
const CHILD_MARKER_PREFIX = '.citadel-private-azure-child-';
const CHILD_MARKER =
  /^\.citadel-private-azure-child-([1-9][0-9]{0,14})-([1-9][0-9]{0,14}|none)-([0-9a-f]{16})$/;
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_CREATE_ATTEMPTS = 8;

export function createPrivateAzureCliContext({
  tempRoot = tmpdir(),
  now = () => Date.now(),
  pid = process.pid,
  platform = process.platform,
  getuid = process.getuid?.bind(process),
  random = (bytes) => randomBytes(bytes).toString('hex'),
  isProcessAlive = processIsAlive,
  isProcessGroupAlive = processGroupIsAlive,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  windowsAcl = applyRestrictiveWindowsAcl,
} = {}) {
  if (typeof tempRoot !== 'string' || !isAbsolute(tempRoot) || tempRoot.includes('\0')) {
    throw new Error('The private Azure CLI context requires an absolute operating-system temporary directory.');
  }
  if (!Number.isInteger(pid) || pid < 1) throw new Error('The private Azure CLI context requires a valid process id.');
  if (!Number.isInteger(staleAfterMs) || staleAfterMs < 1000) {
    throw new Error('The private Azure CLI stale-directory age must be at least one second.');
  }

  let parentDirectory;
  const contextPrefix = contextNamePrefix({ platform, getuid });
  try {
    parentDirectory = realpathSync(resolve(tempRoot));
    const parentDetails = lstatSync(parentDirectory);
    if (!parentDetails.isDirectory() || parentDetails.isSymbolicLink()) {
      throw new Error('The operating-system temporary path is not a real directory.');
    }
    reapStaleContexts(parentDirectory, {
      contextPrefix,
      now: now(),
      currentPid: pid,
      platform,
      getuid,
      isProcessAlive,
      isProcessGroupAlive,
      staleAfterMs,
    });
  } catch {
    throw new Error('The private Azure CLI context could not prepare its protected temporary storage.');
  }

  let directory;
  let instanceId;
  const createdAt = now();
  try {
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      instanceId = `${contextPrefix}${random(16)}`;
      if (!CONTEXT_NAME.test(instanceId)) {
        throw new Error('The private Azure CLI context random source returned an invalid identifier.');
      }
      directory = join(parentDirectory, instanceId);
      try {
        mkdirSync(directory, { mode: 0o700 });
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        directory = undefined;
      }
    }
    if (!directory) throw new Error('A unique private Azure CLI directory could not be allocated.');
    protectDirectory(directory, { platform, getuid, windowsAcl });
    writeFileSync(
      join(directory, MARKER_NAME),
      JSON.stringify(markerRecord({ instanceId, pid, createdAt })),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    assertOwnedRegularMarker(join(directory, MARKER_NAME), { platform, getuid });
  } catch {
    if (directory) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        /* a later launch will conservatively consider the marked directory */
      }
    }
    throw new Error('The private Azure CLI context could not create its protected launch directory.');
  }

  let closed = false;
  let closing = null;
  const activeSpawns = new Set();
  const redact = createPathRedactor(directory, platform);

  function bindSpawn(spawn) {
    if (typeof spawn !== 'function') throw new Error('The private Azure CLI context requires a spawn function.');
    return async (options = {}) => {
      if (closed) throw new Error('The private Azure CLI context is closed.');
      if (Object.prototype.hasOwnProperty.call(options, 'onSpawn')) {
        throw new Error('The private Azure CLI context owns process tracking.');
      }
      const operation = Promise.resolve().then(() =>
        spawn({
          ...options,
          azureConfigDir: directory,
          onSpawn: ({ pid: childPid, processGroupId }) => {
            const child = normalizeChild({ pid: childPid, processGroupId });
            const childNonce = random(8);
            if (!/^[0-9a-f]{16}$/.test(childNonce)) {
              throw new Error('The private Azure CLI context random source returned an invalid child identifier.');
            }
            const childMarker = join(
              directory,
              `${CHILD_MARKER_PREFIX}${child.pid}-${child.processGroupId ?? 'none'}-${childNonce}`,
            );
            try {
              writeFileSync(childMarker, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
              assertOwnedRegularMarker(childMarker, { platform, getuid });
            } catch (error) {
              throw error;
            }
            return () => {
              rmSync(childMarker, { force: true });
            };
          },
        }),
      );
      activeSpawns.add(operation);
      try {
        const result = await operation;
        return sanitizeSpawnResult(result, redact);
      } catch (error) {
        const safe = new Error(redact(String(error?.message ?? error)));
        safe.name = typeof error?.name === 'string' ? error.name : 'Error';
        throw safe;
      } finally {
        activeSpawns.delete(operation);
      }
    };
  }

  function bindTransports(transports) {
    if (!transports || typeof transports !== 'object' || typeof transports.spawn !== 'function') {
      throw new Error('The private Azure CLI context requires process transports.');
    }
    return Object.freeze({
      ...transports,
      spawn: bindSpawn(transports.spawn),
    });
  }

  function close() {
    if (closing) return closing;
    closed = true;
    closing = Promise.allSettled([...activeSpawns]).then(() => {
      try {
        assertSafeContextDirectory(directory, {
          expectedInstanceId: instanceId,
          platform,
          getuid,
          requireMarker: true,
        });
        rmSync(directory, { recursive: true, force: false });
      } catch {
        throw new Error(
          'The private Azure CLI context could not remove its protected launch directory; crash-safe stale cleanup will retry on a later launch.',
        );
      }
    });
    return closing;
  }

  return Object.freeze({
    directory,
    bindSpawn,
    bindTransports,
    redact,
    close,
  });
}

function protectDirectory(directory, { platform, getuid, windowsAcl }) {
  const details = lstatSync(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error('The protected temporary location is not a real directory.');
  }
  chmodSync(directory, 0o700);
  if (platform === 'win32') {
    windowsAcl(directory);
    return;
  }
  if (typeof getuid === 'function' && statSync(directory).uid !== getuid()) {
    throw new Error('The protected temporary directory is owned by another user.');
  }
  if ((statSync(directory).mode & 0o077) !== 0) {
    throw new Error('The protected temporary directory grants group or other access.');
  }
}

function assertSafeContextDirectory(
  directory,
  { expectedInstanceId, platform, getuid, requireMarker },
) {
  if (!CONTEXT_NAME.test(basename(directory))) throw new Error('Unexpected private Azure CLI directory name.');
  const parent = dirname(directory);
  const parentReal = realpathSync(parent);
  const directoryReal = realpathSync(directory);
  if (!directoryReal.startsWith(`${parentReal}${sep}`)) {
    throw new Error('The private Azure CLI directory escaped its protected parent.');
  }
  const details = lstatSync(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('The private Azure CLI path is not a real directory.');
  if (platform !== 'win32' && typeof getuid === 'function' && statSync(directory).uid !== getuid()) {
    throw new Error('The private Azure CLI directory is owned by another user.');
  }
  if (requireMarker) {
    const markerPath = join(directory, MARKER_NAME);
    assertOwnedRegularMarker(markerPath, { platform, getuid });
    const marker = readMarker(markerPath);
    if (
      marker.kind !== MARKER_KIND
      || marker.instanceId !== expectedInstanceId
      || marker.instanceId !== basename(directory)
    ) {
      throw new Error('The private Azure CLI ownership marker does not match its directory.');
    }
  }
}

function assertOwnedRegularMarker(markerPath, { platform, getuid }) {
  const details = lstatSync(markerPath);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error('The private Azure CLI ownership marker is invalid.');
  if (platform !== 'win32' && typeof getuid === 'function' && statSync(markerPath).uid !== getuid()) {
    throw new Error('The private Azure CLI ownership marker is owned by another user.');
  }
}

function readMarker(markerPath) {
  const data = JSON.parse(readFileSync(markerPath, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid ownership marker.');
  const keys = Object.keys(data).sort();
  const expected = ['createdAt', 'instanceId', 'kind', 'pid', 'version'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('Invalid ownership marker shape.');
  }
  if (
    data.kind !== MARKER_KIND
    || data.version !== 1
    || !CONTEXT_NAME.test(data.instanceId)
    || !Number.isInteger(data.pid)
    || data.pid < 1
    || !Number.isFinite(data.createdAt)
    || data.createdAt < 0
  ) {
    throw new Error('Invalid ownership marker values.');
  }
  return Object.freeze(data);
}

function reapStaleContexts(
  parentDirectory,
  { contextPrefix, now, currentPid, platform, getuid, isProcessAlive, isProcessGroupAlive, staleAfterMs },
) {
  for (const entry of readdirSync(parentDirectory, { withFileTypes: true })) {
    if (
      !entry.name.startsWith(contextPrefix)
      || !entry.isDirectory()
      || entry.isSymbolicLink()
      || !CONTEXT_NAME.test(entry.name)
    ) {
      continue;
    }
    const directory = join(parentDirectory, entry.name);
    try {
      assertSafeContextDirectory(directory, {
        expectedInstanceId: entry.name,
        platform,
        getuid,
        requireMarker: true,
      });
      const marker = readMarker(join(directory, MARKER_NAME));
      const age = now - marker.createdAt;
      const childAlive = readOwnedChildren(directory, { platform, getuid }).some((child) =>
        platform !== 'win32' && child.processGroupId !== null
          ? isProcessGroupAlive(child.processGroupId)
          : isProcessAlive(child.pid),
      );
      if (age < staleAfterMs || marker.pid === currentPid || isProcessAlive(marker.pid) || childAlive) continue;
      rmSync(directory, { recursive: true, force: false });
    } catch {
      // Unmarked, malformed, linked, young, live, or foreign directories are
      // deliberately left untouched rather than guessing ownership.
    }
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function processGroupIsAlive(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function markerRecord({ instanceId, pid, createdAt }) {
  return {
    kind: MARKER_KIND,
    version: 1,
    instanceId,
    pid,
    createdAt,
  };
}

function normalizeChild(child) {
  if (
    !child
    || typeof child !== 'object'
    || Array.isArray(child)
    || !Number.isInteger(child.pid)
    || child.pid < 1
    || (child.processGroupId !== null
      && (!Number.isInteger(child.processGroupId) || child.processGroupId < 1))
  ) {
    throw new Error('Invalid owned child process record.');
  }
  const keys = Object.keys(child).sort();
  const expected = ['pid', 'processGroupId'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('Invalid owned child process shape.');
  }
  return Object.freeze({
    pid: child.pid,
    processGroupId: child.processGroupId,
  });
}

function readOwnedChildren(directory, security) {
  const children = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.name.startsWith(CHILD_MARKER_PREFIX)) continue;
    const match = CHILD_MARKER.exec(entry.name);
    if (!match || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('Invalid owned child process marker.');
    }
    const markerPath = join(directory, entry.name);
    assertOwnedRegularMarker(markerPath, security);
    children.push(normalizeChild({
      pid: Number.parseInt(match[1], 10),
      processGroupId: match[2] === 'none' ? null : Number.parseInt(match[2], 10),
    }));
  }
  return children;
}

function contextNamePrefix({ platform, getuid }) {
  if (platform === 'win32') return `${BASE_DIRECTORY_NAME}-azure-cli-`;
  if (typeof getuid !== 'function') {
    throw new Error('A Unix private Azure CLI context requires the current user id.');
  }
  const uid = getuid();
  if (!Number.isInteger(uid) || uid < 0) throw new Error('The current Unix user id is invalid.');
  return `${BASE_DIRECTORY_NAME}-${uid}-azure-cli-`;
}

function createPathRedactor(directory, platform) {
  const candidates = [...new Set([
    directory,
    directory.replaceAll('\\', '/'),
    encodeURI(directory),
    encodeURIComponent(directory),
  ])].sort((left, right) => right.length - left.length);
  const expressions = candidates.map(
    (value) => new RegExp(escapeRegExp(value), platform === 'win32' ? 'gi' : 'g'),
  );
  return (value) => {
    let text = String(value ?? '');
    for (const expression of expressions) text = text.replace(expression, '[private Azure CLI context]');
    return text;
  };
}

function sanitizeSpawnResult(result, redact) {
  if (!result || typeof result !== 'object') return result;
  return {
    ...result,
    stdout: typeof result.stdout === 'string' ? redact(result.stdout) : result.stdout,
    stderr: typeof result.stderr === 'string' ? redact(result.stderr) : result.stderr,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyRestrictiveWindowsAcl(directory) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$path = $env:CITADEL_PRIVATE_AZURE_PATH',
    '$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()',
    '$system = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-18")',
    '$acl = New-Object System.Security.AccessControl.DirectorySecurity',
    '$acl.SetOwner($identity.User)',
    '$acl.SetAccessRuleProtection($true, $false)',
    '$inheritance = [System.Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit"',
    '$propagation = [System.Security.AccessControl.PropagationFlags]::None',
    '$allow = [System.Security.AccessControl.AccessControlType]::Allow',
    '$rights = [System.Security.AccessControl.FileSystemRights]::FullControl',
    '$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($identity.User, $rights, $inheritance, $propagation, $allow)))',
    '$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system, $rights, $inheritance, $propagation, $allow)))',
    '[System.IO.Directory]::SetAccessControl($path, $acl)',
    '$check = [System.IO.Directory]::GetAccessControl($path)',
    'if (-not $check.AreAccessRulesProtected) { throw "ACL inheritance remains enabled." }',
    'if ($check.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $identity.User.Value) { throw "Owner mismatch." }',
    '$allowed = @($identity.User.Value, $system.Value)',
    '$rules = $check.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier])',
    'foreach ($rule in $rules) {',
    '  if ($rule.AccessControlType -ne $allow -or $allowed -notcontains $rule.IdentityReference.Value) { throw "Unexpected ACL entry." }',
    '}',
  ].join('; ');
  const result = spawnSync(
    powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        TEMP: process.env.TEMP || tmpdir(),
        TMP: process.env.TMP || tmpdir(),
        CITADEL_PRIVATE_AZURE_PATH: directory,
      },
    },
  );
  if (result.status !== 0 || result.error) throw new Error('Windows ACL hardening failed.');
}
