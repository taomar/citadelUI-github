/**
 * Fake transports.
 *
 * Every execution test runs against these. Nothing here can reach a network, a
 * shell, or the real filesystem for WRITES, so the suite cannot touch the
 * user's Azure subscription, gateway, Key Vault, or anything else that costs
 * money or changes state.
 */

import nodeFs from 'node:fs';

/**
 * A spawn transport driven by a script of `{ match, result }` rules.
 *
 * `match` receives `{ executable, args, stdin, env }` and returns true when the
 * rule applies. The first matching rule wins, and an unmatched spawn is a test
 * failure rather than a silent empty success.
 */
export function fakeSpawn(rules = []) {
  const calls = [];
  const transport = async (options) => {
    calls.push({
      executable: options.executable,
      args: [...(options.args ?? [])],
      cwd: options.cwd,
      stdin: options.stdin,
      env: options.env ?? {},
      shellRequested: Object.prototype.hasOwnProperty.call(options, 'shell') ? options.shell : false,
    });
    if (options.signal?.aborted) return { code: -1, stdout: '', stderr: 'aborted', timedOut: false };
    const rule = rules.find((candidate) => candidate.match(options));
    if (!rule) {
      throw new Error(`No fake rule for: ${options.executable} ${(options.args ?? []).join(' ')}`);
    }
    if (rule.delayMs) {
      await new Promise((done) => setTimeout(done, rule.delayMs));
    }
    if (typeof rule.result === 'function') return rule.result(options);
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...rule.result };
  };
  transport.calls = calls;
  return transport;
}

/** A fetch transport driven by `{ match, response }` rules. */
export function fakeFetch(rules = []) {
  const calls = [];
  const transport = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers ?? {}, body: init.body, redirect: init.redirect });
    if (init.signal?.aborted) {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      throw error;
    }
    const rule = rules.find((candidate) => candidate.match(String(url), init, calls.length));
    if (!rule) throw new Error(`No fake rule for ${init.method ?? 'GET'} ${url}`);
    if (rule.throws) throw rule.throws;
    const response = typeof rule.response === 'function' ? rule.response(calls.length) : rule.response;
    return {
      status: response.status ?? 200,
      headers: response.headers ?? {},
      body: response.body,
      text: async () => response.text ?? '',
    };
  };
  transport.calls = calls;
  return transport;
}

/**
 * An in-memory filesystem.
 *
 * Writes always go to memory, so a test can never modify the repository. Reads
 * under `realReadRoots` are delegated to the real filesystem, which is how the
 * vendored accelerator bundle gets staged into a fake workspace: read-only,
 * from inside `CitadelSamples`, exactly as a real run would read it.
 */
export function fakeFileSystem({ realReadRoots = [] } = {}) {
  const files = new Map();
  const dirs = new Set();
  const isReal = (path) => realReadRoots.some((root) => String(path).startsWith(root));

  return {
    files,
    dirs,
    fs: {
      async mkdir(path) {
        dirs.add(String(path));
      },
      async readdir(path, options) {
        if (isReal(path)) return nodeFs.readdirSync(String(path), options);
        const base = String(path);
        const seen = new Map();
        for (const key of [...files.keys(), ...dirs]) {
          if (!key.startsWith(base) || key === base) continue;
          const rest = key.slice(base.length).replace(/^[\\/]/, '');
          const [head] = rest.split(/[\\/]/);
          if (!head) continue;
          const isDir = rest.includes('/') || rest.includes('\\');
          seen.set(head, { name: head, isDirectory: () => isDir, isFile: () => !isDir });
        }
        if (seen.size === 0 && !dirs.has(base)) throw new Error(`ENOENT: ${base}`);
        return options?.withFileTypes ? [...seen.values()] : [...seen.keys()];
      },
      async copyFile(from, to) {
        const content = isReal(from) ? nodeFs.readFileSync(String(from), 'utf-8') : (files.get(String(from)) ?? '');
        files.set(String(to), content);
      },
      async stat(path) {
        if (files.has(String(path))) return { isFile: () => true };
        throw new Error(`ENOENT: ${path}`);
      },
      async rm(path) {
        const root = String(path);
        for (const key of [...files.keys()]) {
          if (key === root || key.startsWith(`${root}\\`) || key.startsWith(`${root}/`)) files.delete(key);
        }
        for (const key of [...dirs]) {
          if (key === root || key.startsWith(`${root}\\`) || key.startsWith(`${root}/`)) dirs.delete(key);
        }
      },
    },
    writeFile: async (path, content) => {
      files.set(String(path), String(content));
    },
    access: async (path) => {
      if (!files.has(String(path))) throw new Error(`ENOENT: ${path}`);
    },
  };
}

/** Build the transports object the executor expects. */
export function makeTransports({ spawn, fetch, filesystem } = {}) {
  const fs = filesystem ?? fakeFileSystem();
  return {
    spawn: spawn ?? fakeSpawn(),
    fetch: fetch ?? fakeFetch(),
    writeFile: fs.writeFile,
    access: fs.access,
    __filesystem: fs,
  };
}

/** An SSE body carrying one JSON frame, as APIM's MCP runtime may answer. */
export function sseFrame(payload) {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}
