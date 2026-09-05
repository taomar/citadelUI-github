/**
 * Real transports.
 *
 * `spawnProcess` is the only place in this application that starts a process.
 * It refuses anything outside the executable allow-list, never uses a shell,
 * never composes a command string, bounds the output it will buffer, enforces a
 * timeout, and kills the whole process tree it created — by handle, never by
 * name — when the run is cancelled.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile, access } from 'node:fs/promises';
import { isAbsolute, win32 } from 'node:path';

import { ALLOWED_EXECUTABLES, executableIdentity } from '../core/types.mjs';

const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const MAX_PROCESS_STDIN_BYTES = 1024 * 1024;
const MAX_PROCESS_TIMEOUT_MS = 15 * 60 * 1000;
const WINDOWS_TREE_KILL_TIMEOUT_MS = 5000;

export const INHERITED_ENVIRONMENT_KEYS = Object.freeze([
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'AZURE_CONFIG_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]);

export const SYSTEM_BROWSER_ENVIRONMENT_KEYS = Object.freeze([
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_CURRENT_DESKTOP',
  'XDG_SESSION_TYPE',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
]);

const EXPLICIT_ENVIRONMENT_KEYS = Object.freeze([
  'CITADEL_GATEWAY_ACCESS_API_KEY',
  'AZURE_CORE_LOGIN_EXPERIENCE_V2',
  'AZURE_CORE_NO_COLOR',
  'AZURE_CORE_OUTPUT',
]);

/**
 * Build the complete child environment. Host credentials and unrelated service
 * settings are not inherited; wrappers may add only reviewed, registry-owned
 * secret variables.
 */
export function createProcessEnvironment(explicit = {}, source = process.env, { profile = 'default' } = {}) {
  if (!explicit || typeof explicit !== 'object' || Array.isArray(explicit)) {
    throw new Error('Process environment overrides must be an object.');
  }
  if (!['default', 'system-browser'].includes(profile)) {
    throw new Error(`Unknown process environment profile "${profile}".`);
  }

  const result = {};
  const inheritedKeys =
    profile === 'system-browser'
      ? [...INHERITED_ENVIRONMENT_KEYS, ...SYSTEM_BROWSER_ENVIRONMENT_KEYS]
      : INHERITED_ENVIRONMENT_KEYS;
  for (const key of inheritedKeys) {
    const value = source[key];
    if (typeof value === 'string' && value !== '' && !value.includes('\0')) result[key] = value;
  }
  for (const [key, value] of Object.entries(explicit)) {
    if (!EXPLICIT_ENVIRONMENT_KEYS.includes(key)) {
      throw new Error(`Refused unapproved process environment variable "${key}".`);
    }
    if (typeof value !== 'string' || value.includes('\0')) {
      throw new Error(`Process environment variable "${key}" must be a string without NUL bytes.`);
    }
    result[key] = value;
  }

  return {
    ...result,
    NO_COLOR: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  };
}

/**
 * Resolve a Windows command without handing it to cmd.exe.
 *
 * The official Azure CLI MSI exposes `az.cmd`, which is a two-line shim over
 * its bundled Python runtime. Node cannot execute a .cmd file with
 * `shell:false`, and enabling a shell would break the executor's central
 * security invariant. Resolve that one known launcher shape to the same
 * `python.exe -IBm azure.cli` invocation the shim performs.
 */
export function resolveSpawnInvocation(
  executable,
  args,
  {
    platform = process.platform,
    pathValue = process.env.PATH ?? '',
    pathExt = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
    exists = existsSync,
  } = {},
) {
  if (platform !== 'win32') return { executable, args: [...args] };

  const resolved = resolveWindowsCommand(executable, { pathValue, pathExt, exists });
  if (!resolved) return { executable, args: [...args] };

  const extension = win32.extname(resolved).toLowerCase();
  if (executableIdentity(executable) === 'az' && (extension === '.cmd' || extension === '.bat')) {
    const bundledPython = win32.resolve(win32.dirname(resolved), '..', 'python.exe');
    if (!exists(bundledPython)) {
      throw new Error(
        `Azure CLI was found at "${resolved}", but its bundled Python runtime is missing. Repair the Azure CLI installation.`,
      );
    }
    return {
      executable: bundledPython,
      args: ['-IBm', 'azure.cli', ...args],
    };
  }

  if (extension === '.cmd' || extension === '.bat') {
    throw new Error(`Refused to launch "${resolved}" because command shims require a shell.`);
  }
  return { executable: resolved, args: [...args] };
}

function resolveWindowsCommand(executable, { pathValue, pathExt, exists }) {
  const requested = String(executable);
  const hasDirectory = win32.isAbsolute(requested) || requested.includes('\\') || requested.includes('/');
  const extension = win32.extname(requested);
  const extensions = extension
    ? ['']
    : String(pathExt)
        .split(';')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
  const directories = hasDirectory
    ? ['']
    : String(pathValue)
        .split(';')
        .map((item) => item.trim().replace(/^"|"$/g, ''))
        .filter(Boolean);

  for (const directory of directories) {
    for (const suffix of extensions) {
      const candidate = directory ? win32.join(directory, `${requested}${suffix}`) : `${requested}${suffix}`;
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * @param {object} options
 * @param {string} options.executable  must be on the allow-list
 * @param {string[]} options.args      passed as an array; never joined
 * @param {(chunk:{stream:'stdout'|'stderr',text:string}) => void} [options.onOutput]
 * @param {boolean} [options.captureOutput] whether stdout/stderr are retained in the result
 * @param {'default'|'system-browser'} [options.environmentProfile] reviewed inherited environment profile
 * @returns {Promise<{code:number, stdout:string, stderr:string, timedOut:boolean, aborted:boolean, spawnFailed?:boolean}>}
 */
export function spawnProcess({
  executable,
  args = [],
  cwd,
  stdin,
  env = {},
  signal,
  timeoutMs = 180_000,
  maxOutputBytes = 256 * 1024,
  allowedExecutables = ALLOWED_EXECUTABLES,
  onOutput,
  captureOutput = true,
  environmentProfile = 'default',
}) {
  if (!Array.isArray(allowedExecutables) || !allowedExecutables.includes(executable)) {
    return Promise.reject(new Error(`Refused to spawn "${executable}": it is not on the executable allow-list.`));
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    return Promise.reject(new Error('Process arguments must be an array of strings.'));
  }
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    return Promise.reject(new Error('A process may run only with an absolute workspace cwd.'));
  }
  if (stdin !== undefined && typeof stdin !== 'string') {
    return Promise.reject(new Error('Process stdin must be a string when supplied.'));
  }
  if (Buffer.byteLength(stdin ?? '', 'utf-8') > MAX_PROCESS_STDIN_BYTES) {
    return Promise.reject(new Error(`Process stdin exceeds the ${MAX_PROCESS_STDIN_BYTES}-byte limit.`));
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_PROCESS_TIMEOUT_MS) {
    return Promise.reject(new Error(`Process timeout must be between 1 and ${MAX_PROCESS_TIMEOUT_MS} milliseconds.`));
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_PROCESS_OUTPUT_BYTES) {
    return Promise.reject(
      new Error(`Process output limit must be between 1 and ${MAX_PROCESS_OUTPUT_BYTES} bytes per stream.`),
    );
  }
  if (onOutput !== undefined && typeof onOutput !== 'function') {
    return Promise.reject(new Error('Process output observer must be a function when supplied.'));
  }
  if (typeof captureOutput !== 'boolean') {
    return Promise.reject(new Error('Process output capture must be a boolean.'));
  }
  let childEnv;
  try {
    childEnv = createProcessEnvironment(env, process.env, { profile: environmentProfile });
  } catch (error) {
    return Promise.reject(error);
  }
  if (signal?.aborted) {
    return Promise.resolve({ code: -1, stdout: '', stderr: '', timedOut: false, aborted: true });
  }
  let invocation;
  try {
    invocation = resolveSpawnInvocation(executable, args);
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(invocation.executable, invocation.args, {
        cwd,
        // No shell, ever. The arguments above are the whole command.
        shell: false,
        windowsHide: true,
        // A detached child on POSIX gets its own process group, so cancelling
        // kills the tree this run created and nothing else.
        detached: process.platform !== 'win32',
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        code: -1,
        stdout: '',
        stderr: captureOutput ? String(error?.message ?? error) : '',
        timedOut: false,
        aborted: false,
        spawnFailed: true,
      });
      return;
    }

    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let stdinFailed = false;
    let spawnFailed = false;
    let termination;

    const collect = (chunk, which) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf-8');
      if (which === 'out') {
        const remaining = maxOutputBytes - stdoutBytes;
        if (remaining <= 0) return;
        const accepted = bytes.subarray(0, remaining);
        if (captureOutput) stdout.push(accepted);
        stdoutBytes += accepted.byteLength;
        onOutput?.({ stream: 'stdout', text: accepted.toString('utf-8') });
      } else {
        const remaining = maxOutputBytes - stderrBytes;
        if (remaining <= 0) return;
        const accepted = bytes.subarray(0, remaining);
        if (captureOutput) stderr.push(accepted);
        stderrBytes += accepted.byteLength;
        onOutput?.({ stream: 'stderr', text: accepted.toString('utf-8') });
      }
    };

    child.stdout?.on('data', (chunk) => collect(chunk, 'out'));
    child.stderr?.on('data', (chunk) => collect(chunk, 'err'));

    const killTree = () => {
      if (!termination) termination = terminateProcessTree(child);
      return termination;
    };

    const timer = setTimeout(() => {
      timedOut = true;
      void killTree();
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      void killTree();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const finish = async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (termination) await termination;
      const result = {
        code,
        stdout: captureOutput ? decodeCollectedOutput(stdout, stdoutBytes, maxOutputBytes) : '',
        stderr: captureOutput ? decodeCollectedOutput(stderr, stderrBytes, maxOutputBytes) : '',
        timedOut,
        aborted,
      };
      if (spawnFailed) result.spawnFailed = true;
      resolve(result);
    };

    child.on('error', (error) => {
      spawnFailed = true;
      collect(String(error?.message ?? error), 'err');
      void finish(-1);
    });
    child.on('close', (code) => void finish(stdinFailed ? -1 : (code ?? -1)));

    const onStdinError = (error) => {
      stdinFailed = true;
      collect(`Process stdin failed: ${String(error?.message ?? error)}`, 'err');
    };
    child.stdin?.on('error', onStdinError);
    try {
      if (typeof stdin === 'string') {
        child.stdin?.end(stdin, 'utf-8');
      } else {
        child.stdin?.end();
      }
    } catch (error) {
      onStdinError(error);
    }
  });
}

function decodeCollectedOutput(chunks, byteLength, maxBytes) {
  const text = Buffer.concat(chunks, byteLength).toString('utf-8');
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return text;

  // Invalid or boundary-split UTF-8 can expand to a three-byte replacement
  // character. Trim by string boundary so the returned evidence remains within
  // the same byte ceiling as the raw collector.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), 'utf-8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1]) && /[\uDC00-\uDFFF]/.test(text[low] ?? '')) low -= 1;
  return text.slice(0, low);
}

function terminateProcessTree(child) {
  if (typeof child.pid !== 'number') {
    try {
      child.kill();
    } catch {
      /* the child had already exited */
    }
    return Promise.resolve();
  }

  if (process.platform !== 'win32') {
    try {
      // A negative pid targets the process group created by `detached`.
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* the child had already exited */
      }
    }
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const taskkill = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    let killer;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const fallback = () => {
      try {
        child.kill();
      } catch {
        /* the child had already exited */
      }
      finish();
    };
    const timer = setTimeout(() => {
      try {
        killer?.kill();
      } catch {
        /* taskkill had already exited */
      }
      fallback();
    }, WINDOWS_TREE_KILL_TIMEOUT_MS);

    try {
      killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        env: createProcessEnvironment(),
        stdio: 'ignore',
      });
      killer.once('error', fallback);
      killer.once('close', (code) => {
        if (code !== 0) {
          fallback();
          return;
        }
        finish();
      });
    } catch {
      fallback();
    }
  });
}

/** `python3.11` and `C:\...\python.exe` both identify as `python`. */
export { executableIdentity };

/** The transports the executor receives in production. */
export function realTransports() {
  return {
    spawn: spawnProcess,
    fetch: (...args) => globalThis.fetch(...args),
    writeFile,
    access,
  };
}
