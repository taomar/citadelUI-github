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
import { win32 } from 'node:path';

import { ALLOWED_EXECUTABLES, executableIdentity } from '../core/types.mjs';

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
 * @returns {Promise<{code:number, stdout:string, stderr:string, timedOut:boolean, spawnFailed?:boolean}>}
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
}) {
  const base = executableIdentity(executable);
  if (!allowedExecutables.includes(base)) {
    return Promise.reject(new Error(`Refused to spawn "${executable}": it is not on the executable allow-list.`));
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    return Promise.reject(new Error('Process arguments must be an array of strings.'));
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
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error), timedOut: false, spawnFailed: true });
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;

    const collect = (chunk, which) => {
      const text = chunk.toString('utf-8');
      if (which === 'out') {
        if (stdoutBytes >= maxOutputBytes) return;
        stdoutBytes += Buffer.byteLength(text, 'utf-8');
        stdout += text;
      } else {
        if (stderrBytes >= maxOutputBytes) return;
        stderrBytes += Buffer.byteLength(text, 'utf-8');
        stderr += text;
      }
    };

    child.stdout?.on('data', (chunk) => collect(chunk, 'out'));
    child.stderr?.on('data', (chunk) => collect(chunk, 'err'));

    const killTree = () => {
      try {
        if (process.platform === 'win32') {
          child.kill();
        } else if (typeof child.pid === 'number') {
          // Negative pid targets the process group created by `detached`.
          process.kill(-child.pid, 'SIGTERM');
        }
      } catch {
        /* the child had already exited */
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    const onAbort = () => killTree();
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut });
    };

    child.on('error', (error) => {
      stderr += String(error?.message ?? error);
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));

    if (typeof stdin === 'string') {
      child.stdin?.end(stdin, 'utf-8');
    } else {
      child.stdin?.end();
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
