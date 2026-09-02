/**
 * The browser's single GitHub credential, and what the panels do with it.
 *
 * Two defects live here. Both are invisible with one panel open and obvious
 * with two: the connect lock was per panel while the session id is per browser,
 * and the token input was cleared only on the success path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { GitHubSessionManager } from '../web/js/github-session-manager.mjs';
import { RepositorySelection } from '../web/js/github-selection.mjs';

const setup = readFileSync(new URL('../web/js/github-setup.mjs', import.meta.url), 'utf8');

/** A credential exchange whose completion the test controls. */
function credential(login) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const account = {
    login,
    sessionId: `session-${login}${'x'.repeat(20)}`,
    revoked: false,
    revoke: async () => {
      account.revoked = true;
    },
  };
  return { account, release, gate };
}

function manager(exchanges) {
  const adopted = [];
  const queue = [...exchanges];
  return {
    adopted,
    instance: new GitHubSessionManager({
      connect: async () => {
        const next = queue.shift();
        await next.gate;
        return next.account;
      },
      disconnect: async () => ({ disconnected: true }),
      adopt: (id) => adopted.push(id),
    }),
  };
}

test('a second connect is refused while the first is still in flight', async () => {
  const a = credential('octo-a');
  const { instance } = manager([a]);
  const first = instance.connect('token-a');
  assert.equal(instance.connecting, true);
  await assert.rejects(instance.connect('token-b'), /already in progress/);
  a.release();
  const outcome = await first;
  assert.equal(outcome.account.login, 'octo-a');
  assert.equal(instance.connecting, false);
});

test('only the winning credential is adopted as the browser session', async () => {
  const a = credential('octo-a');
  const { instance, adopted } = manager([a]);
  const pending = instance.connect('token-a');
  // A disconnect supersedes the attempt still in flight.
  instance.generation += 1;
  a.release();
  assert.equal(await pending, null);
  // The superseded credential is revoked rather than left live on the server,
  // where it would occupy a session slot the browser can no longer address.
  assert.equal(a.account.revoked, true);
  assert.deepEqual(adopted, []);
  assert.equal(instance.connected, false);
});

test('work started under a superseded generation is recognisable as stale', async () => {
  const a = credential('octo-a');
  const { instance } = manager([a]);
  const pending = instance.connect('token-a');
  a.release();
  const outcome = await pending;
  assert.equal(instance.isCurrent(outcome.generation), true);
  // Another credential, or a disconnect, moves the application on.
  instance.reset();
  assert.equal(instance.isCurrent(outcome.generation), false);
});

test('two panels sharing the manager cannot both connect', async () => {
  const a = credential('octo-a');
  const { instance } = manager([a]);
  const panel = (repositories) =>
    new RepositorySelection({
      sessions: instance,
      listRepositories: async () => ({ repositories }),
      listBranches: async () => ({ branches: [] }),
    });
  const first = panel([{ id: 1, fullName: 'octo/a', canPush: true }]);
  const second = panel([{ id: 2, fullName: 'octo/b', canPush: true }]);

  const pending = first.beginConnect(null, 'token-a');
  // The lock is application-wide, so the *other* panel is refused too. A per
  // panel lock would let this one exchange a second credential and overwrite
  // the browser's single session id.
  await assert.rejects(second.beginConnect(null, 'token-b'), /already in progress/);
  a.release();
  await pending;

  assert.equal(first.connected, true);
  assert.deepEqual(
    first.repositories.map((repository) => repository.fullName),
    ['octo/a']
  );
  // The second panel never connected, so it shows nothing at all — least of all
  // the first credential's repositories.
  assert.equal(second.connected, false);
  assert.deepEqual(second.repositories, []);
});

test('a panel that loses the race publishes nothing', async () => {
  const a = credential('octo-a');
  const { instance } = manager([a]);
  const losing = new RepositorySelection({
    sessions: instance,
    listRepositories: async () => ({
      repositories: [{ id: 1, fullName: 'octo/stale', canPush: true }],
    }),
    listBranches: async () => ({ branches: [] }),
  });
  const pending = losing.beginConnect(null, 'token-a');
  // Something else — a disconnect, another panel — takes ownership.
  instance.generation += 1;
  a.release();
  assert.equal(await pending, null);
  assert.equal(losing.connected, false);
  assert.deepEqual(losing.repositories, []);
  // And the control is released rather than stranded mid-connect.
  assert.equal(losing.connecting, false);
});

test('disconnecting supersedes a connect still in flight', async () => {
  const a = credential('octo-a');
  const { instance, adopted } = manager([a]);
  const pending = instance.connect('token-a');
  const disconnected = instance.disconnect();
  a.release();
  assert.equal(await pending, null);
  await disconnected;
  assert.equal(a.account.revoked, true);
  assert.deepEqual(adopted, []);
  assert.equal(instance.connected, false);
});

test('the panel clears the token field before it awaits anything', () => {
  const handler = setup.slice(
    setup.indexOf('const connectButton'),
    setup.indexOf('const disconnectButton')
  );
  // The raw credential must leave the DOM whatever happens next. Clearing it
  // after the await left it in a disabled field whenever the session succeeded
  // but the repository load failed.
  const cleared = handler.indexOf("tokenInput.value = ''");
  const awaited = handler.indexOf('await selection.beginConnect');
  assert.ok(cleared > 0, 'the token field is never cleared');
  assert.ok(awaited > 0, 'the connect call was not found');
  assert.ok(cleared < awaited, 'the token field is cleared only after awaiting');
  // The value is read once, into a local, before being cleared.
  assert.match(handler, /const token = tokenInput\.value;\s*\n\s*tokenInput\.value = '';/);
  assert.match(handler, /beginConnect\(connect, token\)/);
  // And the guard is the application-wide lock, not just this panel's — and it
  // covers a restore still in flight, whose answer would otherwise land after
  // this connect and replace it.
  assert.match(handler, /sessions\?\.busy/);
});

test('the panel disconnects through the shared manager', () => {
  const handler = setup.slice(
    setup.indexOf('const disconnectButton'),
    setup.indexOf('tokenInput.addEventListener')
  );
  // Disconnecting must advance the application-wide generation, otherwise a
  // connect still in flight would quietly become the active credential after
  // the user asked to sign out.
  assert.match(handler, /sessions \? await sessions\.disconnect\(\)/);
});

test('a panel that fails to render cannot strand the credential lock', async () => {
  const instance = new GitHubSessionManager({
    connect: async () => {
      throw new Error('that token was refused');
    },
    adopt: () => {},
  });
  // `notify` runs on the path that releases the lock, so a listener throwing
  // there would hold `connecting` forever and disable Connect for good.
  instance.subscribe(() => {
    throw new Error('a panel failed to render');
  });
  await assert.rejects(instance.connect('token'), /refused/);
  assert.equal(instance.connecting, false);
  assert.equal(instance.busy, false);

  // And the next attempt still works.
  instance.exchange = async () => ({ login: 'octo', sessionId: `s${'x'.repeat(20)}` });
  const outcome = await instance.connect('token');
  assert.equal(outcome.account.login, 'octo');
});

test('a failing subscriber does not stop the others being notified', async () => {
  const seen = [];
  const instance = new GitHubSessionManager({
    connect: async () => ({ login: 'octo', sessionId: `s${'x'.repeat(20)}` }),
    adopt: () => {},
  });
  instance.subscribe(() => {
    throw new Error('first panel is broken');
  });
  instance.subscribe(() => seen.push('second'));
  await instance.connect('token');
  assert.ok(seen.length > 0, 'a later panel must still be told the credential changed');
});

test('every disconnect affordance goes through the shared manager', () => {
  const app = readFileSync(new URL('../web/js/app.mjs', import.meta.url), 'utf8');
  // Workspace settings has its own Disconnect button. Calling the transport
  // directly there would end the session without advancing the generation, so a
  // connect still in flight would become active after the user signed out.
  assert.match(app, /githubSessions\.disconnect\(\)/);
  assert.doesNotMatch(app, /\bawait disconnectGitHub\(\)/);
  assert.doesNotMatch(app, /import \{[^}]*\bdisconnectGitHub\b[^}]*\} from '\.\/github-session\.mjs'/s);
});

test('a restored session is owned by the manager and shared by every panel', async () => {
  let asked = 0;
  const instance = new GitHubSessionManager({
    status: async () => {
      asked += 1;
      return { connected: true, login: 'octo-restored' };
    },
    adopt: () => {},
  });
  const panel = (repositories) =>
    new RepositorySelection({
      sessions: instance,
      listRepositories: async () => ({ repositories }),
      listBranches: async () => ({ branches: [] }),
    });
  const first = panel([{ id: 1, fullName: 'octo/a', canPush: true }]);
  const second = panel([{ id: 1, fullName: 'octo/a', canPush: true }]);

  // Two panels restoring at once share one request rather than racing to
  // publish their own answer.
  const [a, b] = await Promise.all([instance.restore(), instance.restore()]);
  assert.equal(asked, 1);
  assert.equal(a.login, 'octo-restored');
  assert.equal(b, a);
  assert.equal(instance.connected, true);

  await first.connect(a);
  await second.connect(b);
  assert.equal(first.account.login, 'octo-restored');
  assert.equal(second.account.login, 'octo-restored');
});

test('no panel may connect while a restore is still outstanding', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const instance = new GitHubSessionManager({
    status: async () => {
      await gate;
      return { connected: true, login: 'octo-restored' };
    },
    connect: async () => ({ login: 'octo-new', sessionId: `s${'x'.repeat(20)}` }),
    adopt: () => {},
  });
  const restoring = instance.restore();
  assert.equal(instance.isRestoring, true);
  assert.equal(instance.busy, true);
  // A connect started here would be replaced by the restore's answer landing
  // afterwards, so it is refused outright.
  await assert.rejects(instance.connect('token'), /already in progress/);
  const panel = new RepositorySelection({
    sessions: instance,
    listRepositories: async () => ({ repositories: [] }),
    listBranches: async () => ({ branches: [] }),
  });
  await assert.rejects(panel.beginConnect(null, 'token'), /already in progress/);
  release();
  await restoring;
  assert.equal(instance.busy, false);
});

test('replacing a credential revokes the one it replaces', async () => {
  const previous = {
    login: 'octo-a',
    sessionId: `a${'x'.repeat(20)}`,
    revoked: false,
    revoke: async () => {
      previous.revoked = true;
    },
  };
  const next = { login: 'octo-b', sessionId: `b${'x'.repeat(20)}`, revoke: async () => {} };
  const queue = [previous, next];
  const adopted = [];
  const instance = new GitHubSessionManager({
    connect: async () => queue.shift(),
    adopt: (id) => adopted.push(id),
  });
  await instance.connect('token-a');
  assert.equal(instance.account.login, 'octo-a');
  await instance.connect('token-b');
  assert.equal(instance.account.login, 'octo-b');
  // The first credential is not left live on the server, unaddressable.
  assert.equal(previous.revoked, true);
  assert.deepEqual(adopted, [previous.sessionId, next.sessionId]);
});

test('disconnecting clears every panel, not just the one that asked', async () => {
  const account = { login: 'octo-a', sessionId: `a${'x'.repeat(20)}`, revoke: async () => {} };
  const instance = new GitHubSessionManager({
    connect: async () => account,
    disconnect: async () => ({ disconnected: true }),
    adopt: () => {},
  });
  const panels = [1, 2].map(
    () =>
      new RepositorySelection({
        sessions: instance,
        listRepositories: async () => ({
          repositories: [{ id: 1, fullName: 'octo/a', canPush: true }],
        }),
        listBranches: async () => ({ branches: [] }),
      })
  );
  // Each panel follows the manager, exactly as `createGitHubPanel` wires it.
  for (const panel of panels) {
    instance.subscribe((manager) => {
      if (!manager.connected && panel.connected) panel.reset();
    });
  }
  await instance.connect('token-a');
  for (const panel of panels) await panel.connect(account);
  assert.ok(panels.every((panel) => panel.connected));

  // Settings disconnects. No panel may keep an account or a repository list.
  await instance.disconnect();
  assert.equal(instance.connected, false);
  for (const panel of panels) {
    assert.equal(panel.connected, false);
    assert.deepEqual(panel.repositories, []);
    assert.equal(panel.repository, null);
  }
});

test('the panel subscribes to the manager and delegates restore to it', () => {
  // Restoring per panel meant a session found by one panel was invisible to the
  // others, and a disconnect elsewhere left this one showing a live account.
  assert.match(setup, /sessions\?\.subscribe\(/);
  assert.match(setup, /if \(!manager\.connected && selection\.connected\) selection\.reset\(\)/);
  assert.match(setup, /sessions \? await sessions\.restore\(\) : await status\(\)/);
});

test('every restore call site awaits the manager', () => {
  for (const [name, text] of [
    ['app.mjs', readFileSync(new URL('../web/js/app.mjs', import.meta.url), 'utf8')],
    [
      'workspace-context.mjs',
      readFileSync(new URL('../web/js/workspace-context.mjs', import.meta.url), 'utf8'),
    ],
  ]) {
    for (const match of text.matchAll(/\brestore\(\)(\S*)/g)) {
      // A bare `panel.restore();` starts an unawaited request whose answer lands
      // later and replaces whatever the user did in the meantime.
      assert.match(match[1], /^\.catch|^;?\s*$/, `${name}: ${match[0]}`);
      assert.notEqual(match[1], ';', `${name}: restore() is not awaited or chained`);
    }
  }
});
