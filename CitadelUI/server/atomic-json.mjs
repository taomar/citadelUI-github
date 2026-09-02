/**
 * One durable JSON write, shared by every `/data` metadata store.
 *
 * The registry mirror, the commit audit, the connection profiles, the credential
 * envelopes and the activity log all need the same guarantee: a reader either
 * sees the previous document or the next one, never a half-written one, and the
 * file is never group- or world-readable.
 *
 * This existed three times with three chances to drift. It is one function here
 * so that a correction to the durability or permission rules applies to every
 * store at once.
 *
 * `open(..., 'wx', 0o600)` refuses to reuse an existing temporary, `sync()`
 * forces the bytes out before the rename, and the rename is the atomic step. A
 * failed rename removes the temporary rather than leaving it behind, because the
 * data directory is bind-mounted and a growing pile of `.tmp` files is a real
 * operational problem rather than a cosmetic one.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function atomicJson(path, value) {
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
