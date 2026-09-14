import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createBuildInfo, verifyPackagedSources } from '../desktop/source-integrity.mjs';

const run = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'citadel-desktop-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args) => (await run('git', args, { cwd: root, windowsHide: true })).stdout.trim();
  await git('init', '--quiet');
  for (const directory of ['server', 'shared', 'web']) {
    await mkdir(join(root, 'CitadelUI', directory), { recursive: true });
    await writeFile(join(root, 'CitadelUI', directory, 'module.mjs'), `export const name = '${directory}';\n`);
  }
  await writeFile(join(root, 'README.md'), 'Fixture\n');
  await git('add', '.');
  await git('-c', 'user.name=Desktop fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '--quiet', '-m', 'Fixture source');
  const source = { revision: await git('rev-parse', 'HEAD'), ref: 'reviewed-application' };
  return { root, source, version: '1.1.4', requireClean: true };
}

test('desktop build identity pins the current application, not the old main snapshot', async () => {
  const source = JSON.parse(await readFile(new URL('../desktop/application-source.json', import.meta.url), 'utf8'));
  assert.equal(source.revision, '5791d4358f2696c1f4ec2805bd6bcfc2c7d729e8');
  assert.equal(source.ref, 'taomar-citadel-orchestrator');
});

test('desktop packaging records the exact reviewed application and release revision', async (t) => {
  const setup = await fixture(t);
  const info = await createBuildInfo(setup.root, setup);
  assert.equal(info.applicationRevision, setup.source.revision);
  assert.equal(info.releaseRevision, setup.source.revision);
  assert.equal(info.dirty, false);
  assert.equal(Object.keys(info.files).length, 3);
  assert.match(info.files['web/module.mjs'].sha256, /^[a-f0-9]{64}$/);
});

test('desktop packaging refuses stale or changed application code', async (t) => {
  const setup = await fixture(t);
  await writeFile(join(setup.root, 'CitadelUI', 'web', 'module.mjs'), 'old application\n');
  await assert.rejects(createBuildInfo(setup.root, setup), /stale or modified application/);
});

test('desktop packaging refuses extra untracked runtime files', async (t) => {
  const setup = await fixture(t);
  await writeFile(join(setup.root, 'CitadelUI', 'web', 'unexpected.mjs'), 'extra\n');
  await assert.rejects(createBuildInfo(setup.root, setup), /untracked or ignored files/);
});

test('desktop release packaging refuses an uncommitted checkout', async (t) => {
  const setup = await fixture(t);
  await writeFile(join(setup.root, 'README.md'), 'uncommitted release\n');
  await assert.rejects(createBuildInfo(setup.root, setup), /clean committed checkout/);
  assert.equal((await createBuildInfo(setup.root, { ...setup, requireClean: false })).dirty, true);
});

test('desktop package verification detects a stale file after packaging', async (t) => {
  const setup = await fixture(t);
  const info = await createBuildInfo(setup.root, setup);
  const resources = join(setup.root, 'packaged');
  await cp(join(setup.root, 'CitadelUI'), resources, { recursive: true });
  await writeFile(join(resources, 'desktop-build.json'), JSON.stringify(info));
  assert.equal((await verifyPackagedSources(resources)).applicationRevision, setup.source.revision);
  await writeFile(join(resources, 'web', 'module.mjs'), 'stale packaged renderer\n');
  await assert.rejects(verifyPackagedSources(resources), /does not match.*web\/module\.mjs/);
});

test('desktop package verification detects missing bundled parser assets', async (t) => {
  const setup = await fixture(t);
  const info = await createBuildInfo(setup.root, setup);
  const resources = join(setup.root, 'packaged');
  await cp(join(setup.root, 'CitadelUI'), resources, { recursive: true });
  await writeFile(join(resources, 'desktop-build.json'), JSON.stringify(info));
  await rm(join(resources, 'shared', 'module.mjs'));
  await assert.rejects(verifyPackagedSources(resources), /does not match.*shared\/module\.mjs/);
});
