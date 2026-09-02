/**
 * The encrypted credential store, judged on the promise it makes.
 *
 * The promise is narrow and stated in `server/credentials.mjs`: a stolen `/data`
 * volume is useless without the key file. So these tests attack the envelope in
 * the ways a stolen volume permits — wrong key, no key, edited ciphertext,
 * swapped envelopes between profiles, a replayed account binding — and require
 * every one of them to fail closed rather than degrade.
 *
 * They also assert the thing that is easy to forget: that unticking the box
 * really deletes the bytes, and that with no key mounted the product still
 * works and simply refuses to persist.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CredentialVault, decodeMasterKey, sameAccount } from '../server/credentials.mjs';

const SECRET = 'github_pat_11AAAAAA0aaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

async function workspace(t, { key = randomBytes(32) } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'citadel-vault-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keyFile = join(root, 'credential.key');
  if (key) await writeFile(keyFile, key);
  const dataRoot = join(root, 'data');
  await mkdir(dataRoot, { recursive: true });
  return { root, keyFile, dataRoot, key };
}

function envelopePath(dataRoot, profileId) {
  return join(dataRoot, 'settings', 'credentials', `${profileId}.json`);
}

test('a key file is accepted as raw bytes, hex or base64, and nothing else', () => {
  const key = randomBytes(32);
  assert.deepEqual(decodeMasterKey(key), key);
  assert.deepEqual(decodeMasterKey(Buffer.from(`${key.toString('hex')}\n`)), key);
  assert.deepEqual(decodeMasterKey(Buffer.from(key.toString('base64'))), key);
  // A short key is refused rather than stretched: a vault that looks encrypted
  // and is not is worse than one that admits it is unavailable.
  assert.equal(decodeMasterKey(randomBytes(16)), null);
  assert.equal(decodeMasterKey(Buffer.from('not a key')), null);
  assert.equal(decodeMasterKey(Buffer.alloc(0)), null);
  assert.equal(decodeMasterKey('a string'), null);
});

test('a credential round-trips and is unreadable without the key', async (t) => {
  const { keyFile, dataRoot, key } = await workspace(t);
  const vault = new CredentialVault({ dataRoot, keyFile });
  await vault.initialize();
  assert.equal(vault.available, true);
  assert.deepEqual(vault.status(), { available: true, reason: 'ready' });

  assert.equal(await vault.store('profile-a', 4242, SECRET), true);
  assert.equal(await vault.load('profile-a', 4242), SECRET);

  const raw = await readFile(envelopePath(dataRoot, 'profile-a'), 'utf8');
  assert.equal(raw.includes(SECRET), false);
  assert.equal(raw.includes('github_pat_'), false);
  assert.equal(raw.includes(key.toString('base64')), false);
  assert.equal(raw.includes(key.toString('hex')), false);

  const envelope = JSON.parse(raw);
  assert.equal(envelope.version, 1);
  assert.equal(envelope.algorithm, 'AES-256-GCM');
  assert.equal(Buffer.from(envelope.secret.iv, 'base64').length, 12);
  assert.equal(Buffer.from(envelope.secret.tag, 'base64').length, 16);
  assert.equal(Buffer.from(envelope.wrappedKey.iv, 'base64').length, 12);
  // The data-encryption key and the credential are sealed under different IVs.
  assert.notEqual(envelope.wrappedKey.iv, envelope.secret.iv);

  // A second process, same volume, same key: this is the container restart.
  const restarted = new CredentialVault({ dataRoot, keyFile });
  await restarted.initialize();
  assert.equal(await restarted.load('profile-a', 4242), SECRET);

  // A thief with the volume and not the key.
  const otherKeyFile = join(dataRoot, '..', 'other.key');
  await writeFile(otherKeyFile, randomBytes(32));
  const attacker = new CredentialVault({ dataRoot, keyFile: otherKeyFile });
  await attacker.initialize();
  assert.equal(attacker.available, true);
  assert.equal(await attacker.load('profile-a', 4242), null);
});

test('every IV is unique across writes of the same credential', async (t) => {
  const { keyFile, dataRoot } = await workspace(t);
  const vault = new CredentialVault({ dataRoot, keyFile });
  await vault.initialize();
  const ivs = new Set();
  for (let index = 0; index < 12; index += 1) {
    await vault.store('profile-a', 7, SECRET);
    const envelope = JSON.parse(await readFile(envelopePath(dataRoot, 'profile-a'), 'utf8'));
    ivs.add(envelope.secret.iv);
    ivs.add(envelope.wrappedKey.iv);
  }
  // 24 seals, 24 distinct nonces. A repeated GCM nonce under one key is a
  // catastrophic failure, not a degraded one.
  assert.equal(ivs.size, 24);
});

test('tampering, swapping and rebinding all fail closed', async (t) => {
  const { keyFile, dataRoot } = await workspace(t);
  const vault = new CredentialVault({ dataRoot, keyFile });
  await vault.initialize();
  await vault.store('profile-a', 100, SECRET);
  await vault.store('profile-b', 200, 'github_pat_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

  const pathA = envelopePath(dataRoot, 'profile-a');
  const original = JSON.parse(await readFile(pathA, 'utf8'));

  // The account this envelope claims is part of its authenticated data, so
  // asking for it under another account cannot open it.
  assert.equal(await vault.load('profile-a', 101), null);

  // A flipped ciphertext byte.
  const damaged = Buffer.from(original.secret.data, 'base64');
  damaged[0] ^= 0xff;
  await writeFile(
    pathA,
    JSON.stringify({ ...original, secret: { ...original.secret, data: damaged.toString('base64') } })
  );
  assert.equal(await vault.load('profile-a', 100), null);

  // Profile B's sealed credential, moved into profile A's file. The AAD binds
  // the profile id, so the file name cannot decide whose credential this is.
  const b = JSON.parse(await readFile(envelopePath(dataRoot, 'profile-b'), 'utf8'));
  await writeFile(pathA, JSON.stringify({ ...b, profileId: 'profile-a', accountId: 100 }));
  assert.equal(await vault.load('profile-a', 100), null);

  // A wrapped DEK from B under A's ciphertext.
  await writeFile(pathA, JSON.stringify({ ...original, wrappedKey: b.wrappedKey }));
  assert.equal(await vault.load('profile-a', 100), null);

  // A truncated IV, a bad version, and a renamed algorithm.
  await writeFile(
    pathA,
    JSON.stringify({ ...original, secret: { ...original.secret, iv: Buffer.alloc(8).toString('base64') } })
  );
  assert.equal(await vault.load('profile-a', 100), null);
  await writeFile(pathA, JSON.stringify({ ...original, version: 2 }));
  assert.equal(await vault.load('profile-a', 100), null);
  await writeFile(pathA, JSON.stringify({ ...original, algorithm: 'AES-256-CBC' }));
  assert.equal(await vault.load('profile-a', 100), null);
  await writeFile(pathA, 'not json at all');
  assert.equal(await vault.load('profile-a', 100), null);
});

test('with no key mounted the vault refuses to persist and never throws', async (t) => {
  const { dataRoot } = await workspace(t, { key: null });
  const absent = new CredentialVault({ dataRoot, keyFile: null });
  await absent.initialize();
  assert.equal(absent.available, false);
  assert.equal(absent.status().reason, 'no-key-file');
  assert.equal(await absent.store('profile-a', 1, SECRET), false);
  assert.equal(await absent.load('profile-a', 1), null);
  // Nothing is created. The default deployment has no vault directory at all.
  await assert.rejects(readdir(join(dataRoot, 'settings', 'credentials')));

  const missing = new CredentialVault({ dataRoot, keyFile: join(dataRoot, 'nope.key') });
  await missing.initialize();
  assert.equal(missing.available, false);
  assert.equal(missing.status().reason, 'key-file-unreadable');

  const short = join(dataRoot, 'short.key');
  await writeFile(short, randomBytes(8));
  const weak = new CredentialVault({ dataRoot, keyFile: short });
  await weak.initialize();
  assert.equal(weak.available, false);
  assert.equal(weak.status().reason, 'key-file-invalid');
});

test('removing a credential deletes the bytes, and concurrent writes do not interleave', async (t) => {
  const { keyFile, dataRoot } = await workspace(t);
  const vault = new CredentialVault({ dataRoot, keyFile });
  await vault.initialize();

  await Promise.all([
    vault.store('profile-a', 1, `${SECRET}-1`),
    vault.store('profile-a', 1, `${SECRET}-2`),
    vault.store('profile-a', 1, `${SECRET}-3`),
  ]);
  // Serialised: whichever won, the file is one complete, openable envelope
  // rather than a half-written one.
  const survivor = await vault.load('profile-a', 1);
  assert.ok([`${SECRET}-1`, `${SECRET}-2`, `${SECRET}-3`].includes(survivor));
  // No temporary is left behind on a bind-mounted volume.
  const files = await readdir(join(dataRoot, 'settings', 'credentials'));
  assert.deepEqual(files, ['profile-a.json']);

  assert.equal(await vault.has('profile-a'), true);
  assert.equal(await vault.remove('profile-a'), true);
  assert.equal(await vault.has('profile-a'), false);
  assert.equal(await vault.load('profile-a', 1), null);
  assert.deepEqual(await readdir(join(dataRoot, 'settings', 'credentials')), []);
  // Removing something that is not there is not an error.
  assert.equal(await vault.remove('profile-a'), true);
});

test('a profile id can never escape the credential directory', async (t) => {
  const { keyFile, dataRoot } = await workspace(t);
  const vault = new CredentialVault({ dataRoot, keyFile });
  await vault.initialize();
  for (const hostile of ['../escape', 'a/b', '..', '', 'x'.repeat(200), 'a\u0000b']) {
    assert.throws(() => vault.path(hostile), /Invalid connection profile id/);
    assert.equal(await vault.load(hostile, 1), null);
    assert.equal(await vault.remove(hostile), false);
  }
});

test('account identity is compared without leaking length through an early return', () => {
  assert.equal(sameAccount(42, 42), true);
  assert.equal(sameAccount('42', 42), true);
  assert.equal(sameAccount(42, 43), false);
  assert.equal(sameAccount(42, 421), false);
  assert.equal(sameAccount(null, null), false);
  assert.equal(sameAccount(undefined, ''), false);
});
