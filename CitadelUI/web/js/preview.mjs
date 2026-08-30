/**
 * Optimistic view of a document.
 *
 * Edits are queued as path-addressed operations and only reach the file when
 * the user confirms the save. The form, however, is rebuilt from the server's
 * document on every change -- so without this layer a pending edit would vanish
 * the instant it was made: a typed value would snap back to its old contents,
 * and an appended array item would never appear at all.
 *
 * Applying the queued operations to a copy of the parsed values keeps the form
 * showing what the user has actually expressed, while the file on disk and the
 * server's document stay untouched until commit. The server remains the single
 * authority for what gets written; this is presentation only.
 *
 * Removals are the subtle case. The server resolves every operation against
 * spans of the *original* text, so a queued index always means "the nth element
 * as the file has it", never "the nth element as the screen now shows it". The
 * preview therefore tombstones removed elements and compacts them only once the
 * whole batch has been placed, so original indices stay meaningful throughout.
 * `toOriginalIndex` is the matching translation for the opposite direction.
 */

const TOMB = Symbol('removed');

/**
 * `__args` is the sentinel the server's `resolvePath` uses to descend into a
 * call's argument list. The preview has to honour the same convention or an
 * edit to an environment fallback -- `int(readEnvironmentVariable('X','1'))` --
 * resolves on the server but vanishes from the screen, which reads to the user
 * as "the value would not change".
 */
const ARGS = '__args';

function step(node, segment) {
  if (node === null || typeof node !== 'object') return undefined;
  if (segment === ARGS) return node.__expr === 'call' ? node.args : undefined;
  return node[segment];
}

/** Walk to a container, yielding null rather than throwing on a stale path. */
function containerAt(root, segments) {
  let node = root;
  for (const segment of segments) {
    if (node === null || typeof node !== 'object') return null;
    node = step(node, segment);
  }
  return node === null || typeof node !== 'object' ? null : node;
}

function applyOne(param, op) {
  const rest = op.path.slice(1);

  if (op.op === 'set') {
    if (!rest.length) {
      param.value = op.value;
      return;
    }
    const parent = containerAt(param.value, rest.slice(0, -1));
    if (parent) parent[rest[rest.length - 1]] = op.value;
    return;
  }

  if (op.op === 'append') {
    const target = containerAt(param.value, rest);
    if (Array.isArray(target)) target.push(op.value);
    return;
  }

  if (op.op === 'addProperty') {
    const target = containerAt(param.value, rest);
    if (target && !Array.isArray(target)) target[op.key] = op.value;
    return;
  }

  if (op.op === 'remove') {
    if (!rest.length) return;
    const key = rest[rest.length - 1];
    const parent = containerAt(param.value, rest.slice(0, -1));
    if (!parent) return;
    if (Array.isArray(parent) && typeof key === 'number') parent[key] = TOMB;
    else delete parent[key];
  }
}

/** Drop tombstones once every operation in the batch has been placed. */
function compact(value) {
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      if (item === TOMB) continue;
      out.push(compact(item));
    }
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) value[key] = compact(item);
  }
  return value;
}

/**
 * Translate a screen-relative array index into the index the file still has.
 *
 * `removedBefore` is the ascending list of original indices already removed
 * from that same array earlier in this batch.
 */
export function toOriginalIndex(index, removedBefore) {
  let result = index;
  for (const removed of removedBefore) {
    if (removed <= result) result += 1;
  }
  return result;
}

function pathKey(path) {
  return JSON.stringify(path);
}

/** Original indices already removed from the array at `prefix`, ascending. */
function removalsAt(operations, prefix) {
  const key = pathKey(prefix);
  return operations
    .filter(
      (o) =>
        o.op === 'remove' &&
        o.path.length === prefix.length + 1 &&
        typeof o.path[o.path.length - 1] === 'number' &&
        pathKey(o.path.slice(0, -1)) === key
    )
    .map((o) => o.path[o.path.length - 1])
    .sort((a, b) => a - b);
}

/** Rewrite a path the screen produced into the path the file understands. */
function toOriginalPath(path, operations) {
  const out = [];
  for (const segment of path) {
    if (typeof segment !== 'number') {
      out.push(segment);
      continue;
    }
    out.push(toOriginalIndex(segment, removalsAt(operations, out)));
  }
  return out;
}

/** Length of the array the file currently has at `path`, or null. */
function originalArrayLength(doc, path) {
  const param = doc && doc.params.find((p) => p.name === path[0]);
  if (!param) return null;
  const node = containerAt(param.value, path.slice(1));
  return Array.isArray(node) ? node.length : null;
}

function operationTarget(op) {
  return op.op === 'addProperty' ? [...op.path, op.key] : op.path;
}

function originalHasPath(doc, path) {
  const param = doc && doc.params.find((candidate) => candidate.name === path[0]);
  if (!param) return false;
  if (path.length === 1) return true;
  const parent = containerAt(param.value, path.slice(1, -1));
  return Boolean(parent) && Object.prototype.hasOwnProperty.call(parent, path[path.length - 1]);
}

/**
 * Add an operation to the pending batch, in the form the server can apply.
 *
 * Two things make this more than a push, and both come from the same fact: the
 * server resolves operations against spans of the original text.
 *
 * First, indices. The screen numbers elements as it displays them, but a queued
 * index has to mean "the nth element the file has". `toOriginalPath` reconciles
 * the two whenever a removal is already pending.
 *
 * Second, and more consequential: an element appended in this batch has no span
 * in the file at all, so an edit to it cannot be an operation of its own -- the
 * server would have nothing to resolve and the save would fail. Such an edit is
 * therefore folded into the queued append, which is still client-owned. This is
 * what makes "add a backend, then add a model to it" work: the model edit
 * rewrites the pending backend rather than addressing a span that does not
 * exist yet.
 */
export function queueOperation(operations, op, doc) {
  const path = toOriginalPath(op.path, operations);

  const prefix = [];
  for (let i = 0; i < path.length; i += 1) {
    const segment = path[i];
    if (typeof segment !== 'number') {
      prefix.push(segment);
      continue;
    }

    const length = originalArrayLength(doc, prefix);
    if (length === null || segment < length) {
      prefix.push(segment);
      continue;
    }

    // Past the end of what the file holds: this addresses an appended element.
    const key = pathKey(prefix);
    const appends = [];
    operations.forEach((candidate, index) => {
      if (candidate.op === 'append' && pathKey(candidate.path) === key) {
        appends.push(index);
      }
    });

    const index = appends[segment - length];
    if (index === undefined) return operations;

    const next = operations.slice();
    const rest = path.slice(i + 1);

    if (op.op === 'remove' && !rest.length) {
      next.splice(index, 1);
      return next;
    }

    const holder = { value: structuredClone(operations[index].value) };
    applyOne(holder, { ...op, path: ['', ...rest] });
    next[index] = { ...operations[index], value: compact(holder.value) };
    return next;
  }

  const candidate = { ...op, path };
  if (['set', 'remove', 'addProperty'].includes(candidate.op)) {
    const target = operationTarget(candidate);
    const key = pathKey(target);
    const index = operations.findIndex(
      (existing) =>
        ['set', 'remove', 'addProperty'].includes(existing.op) &&
        pathKey(operationTarget(existing)) === key
    );
    if (index >= 0) {
      const next = operations.slice();
      const exists = originalHasPath(doc, target);

      if (candidate.op === 'remove' && operations[index].op === 'addProperty' && !exists) {
        next.splice(index, 1);
        return next;
      }

      if (candidate.op === 'remove') {
        next[index] = { op: 'remove', path: target };
        return next;
      }

      next[index] = exists
        ? { op: 'set', path: target, value: candidate.value }
        : { op: 'addProperty', path: target.slice(0, -1), key: target[target.length - 1], value: candidate.value };
      return next;
    }
  }

  return [...operations, candidate];
}

/**
 * Return a document whose parameter values reflect the pending operations.
 *
 * The original document is never mutated: parameters are shallow-copied, and
 * only the values an operation actually touches are deep-cloned.
 */
export function previewDocument(doc, operations) {
  if (!doc || !operations || !operations.length) return doc;

  const params = doc.params.map((param) => ({ ...param }));
  const byName = new Map(params.map((param) => [param.name, param]));
  const touched = new Set();

  for (const op of operations) {
    if (!op || !Array.isArray(op.path) || !op.path.length) continue;
    const param = byName.get(op.path[0]);
    if (!param) continue;

    if (!touched.has(param.name)) {
      param.value = structuredClone(param.value);
      touched.add(param.name);
    }
    applyOne(param, op);
  }

  for (const name of touched) {
    const param = byName.get(name);
    param.value = compact(param.value);
  }

  return { ...doc, params };
}
