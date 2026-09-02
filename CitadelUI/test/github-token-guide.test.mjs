import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { classifyToken } from '../server/github/sessions.mjs';

const source = await readFile(
  fileURLToPath(new URL('../web/js/github-setup.mjs', import.meta.url)),
  'utf8'
);

test('the landing page offers both a GitHub.com and a command-line route', () => {
  assert.match(source, /On GitHub\.com/);
  assert.match(source, /From the command line/);
  assert.match(source, /How to create this token/);
  // It opens as a dialog rather than expanding the form in place.
  assert.match(source, /showDialog\(\s*\n?\s*'Create a GitHub access token'/);
});

test('the guidance names the exact permissions Citadel requires, and no more', () => {
  for (const required of ['Contents', 'Read and write', 'Metadata', 'Read-only']) {
    assert.match(source, new RegExp(required.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')), required);
  }
  // Repository access must be limited, which is the step users most often miss.
  assert.match(source, /Only select repositories/);

  // Pull request write must not be requested. Citadel opens a compare URL in the
  // browser, where github.com's own session authorises the user; it never calls
  // the pull request API, so asking for that permission over-scopes the token.
  assert.doesNotMatch(source, /row\('Pull requests'/);
});

test('nothing in the product calls the pull request API', async () => {
  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const roots = ['web/js', 'server'].map((part) =>
    fileURLToPath(new URL(`../${part}/`, import.meta.url))
  );
  const walk = async (directory) => {
    const found = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) found.push(...(await walk(path)));
      else if (entry.name.endsWith('.mjs')) found.push(path);
    }
    return found;
  };
  for (const root of roots) {
    for (const file of await walk(root)) {
      const text = await readFile(file, 'utf8');
      // An API call would look like `/repos/<name>/pulls`. A compare URL, which
      // is what the product actually uses, does not.
      assert.equal(
        /['"`/]pulls\b/.test(text),
        false,
        `${file} appears to call the pull request API, which the token guidance does not grant`
      );
    }
  }
});

test('the guidance points at the fine-grained token page, not classic tokens', () => {
  assert.match(source, /https:\/\/github\.com\/settings\/personal-access-tokens\/new/);
  assert.equal(source.includes('settings/tokens/new'), false);
});

/**
 * The prefilled form is a convenience, not a way to smuggle in extra access.
 * It may request exactly the one permission the product uses, and it must not
 * name a target account: hard-coding `target_name` or `owner` would silently
 * point the token at the wrong place for anyone whose repositories live in an
 * organisation.
 */
test('the prefilled token form requests contents=write and nothing more', () => {
  const template = source.match(/const TOKEN_PAGE_PREFILLED = `([^`]+)`/)?.[1];
  assert.ok(template, 'the prefilled token URL template must exist');
  const url = new URL(template.replace('${TOKEN_PAGE}', 'https://github.com/settings/personal-access-tokens/new'));
  assert.equal(url.origin, 'https://github.com');
  assert.equal(url.pathname, '/settings/personal-access-tokens/new');

  assert.equal(url.searchParams.get('contents'), 'write');
  assert.equal(url.searchParams.get('name'), 'Citadel Control Panel');
  assert.equal(url.searchParams.get('description'), 'Edit Citadel configuration repositories');
  assert.equal(url.searchParams.get('expires_in'), '30');

  // The Resource owner is the user's choice, never ours.
  for (const forbidden of ['target_name', 'owner', 'org', 'organization']) {
    assert.equal(url.searchParams.has(forbidden), false, `${forbidden} must not be prefilled`);
  }

  // No permission beyond Contents may be requested.
  const permitted = new Set(['name', 'description', 'expires_in', 'contents']);
  for (const key of url.searchParams.keys()) {
    assert.ok(permitted.has(key), `unexpected prefilled parameter: ${key}`);
  }
  for (const scope of ['pull_requests', 'workflows', 'administration', 'admin', 'members', 'secrets']) {
    assert.equal(url.searchParams.has(scope), false, `${scope} must not be requested`);
  }
});

test('the prefilled action is a safe external link with the exact current-UI steps', () => {
  assert.match(source, /'Open prefilled GitHub token form'/);
  // Every external anchor in the guide opens in a new tab without handing the
  // opener to github.com.
  const anchors = [...source.matchAll(/element\(\s*\n?\s*'a',\s*\n?\s*\{([\s\S]{0,240}?)\}/g)];
  assert.ok(anchors.length >= 2, 'the guide must contain external links');
  for (const [, attributes] of anchors) {
    if (!attributes.includes('href')) continue;
    assert.match(attributes, /target:\s*'_blank'/);
    assert.match(attributes, /rel:\s*'noopener noreferrer'/);
  }

  // The six steps the current GitHub UI actually requires.
  assert.match(source, /Resource owner/);
  assert.match(source, /choose the user or organization that owns the Citadel repositories/);
  assert.match(source, /Repository access/);
  assert.match(source, /then select the Citadel repositories/);
  assert.match(source, /Permissions (\\u203a|\u203a) Repository permissions/);
  assert.match(source, /use the permission search/);
  assert.match(source, /is added automatically by GitHub and may not be editable/);
  assert.match(source, /Leave every other Repository, Account and Organization permission at/);
  assert.match(source, /No access/);
  assert.match(source, /Pull requests is not required/);
  assert.match(source, /copy it once, paste it only into Citadel, and use a short expiration/);
});

/**
 * The command-line route must not tell users to run `gh auth token`. That
 * returns the CLI's own OAuth credential, which `classifyToken` refuses, so
 * following it would produce a token that can never work here.
 */
test('the command-line route warns against gh auth token, which Citadel refuses', () => {
  assert.match(source, /Do not use/);
  assert.match(source, /gh auth token/);

  const cliOauthToken = `gho_${'a'.repeat(36)}`;
  assert.throws(
    () => classifyToken(cliOauthToken),
    (error) => error.code === 'GITHUB_TOKEN_CLASSIC',
    'a gh CLI OAuth token must still be refused by the server'
  );
  assert.equal(classifyToken(`github_pat_${'b'.repeat(40)}`).kind, 'fine-grained');
});

test('the verification commands scope the check to the token being verified', () => {
  // A bare `gh api` would silently report whatever the CLI is already logged in
  // as, which is exactly the confusion the guidance exists to prevent.
  assert.match(source, /gh api user/);
  assert.match(source, /user\/repos\?per_page=100/);
  assert.match(source, /GH_TOKEN/);
});

/**
 * The token must never reach shell history, an argument list, or an exported
 * environment. `export GH_TOKEN=github_pat_...` fails all three: it is typed in
 * full, recorded in history, and inherited by every later child process.
 */
test('the verification commands never put the token in history or the environment', () => {
  const secret = 'github_pat_';
  // No recipe may contain a literal token value at all.
  assert.doesNotMatch(source, new RegExp(`export\\s+\\w+=${secret}`));
  assert.doesNotMatch(source, new RegExp(`\\$env:\\w+\\s*=\\s*['"]?${secret}`));
  assert.doesNotMatch(source, new RegExp(`=\\s*${secret}\\.\\.\\.`));

  // Both shells read it at a masked prompt instead.
  assert.match(source, /Read-Host[^\n]*-MaskInput/);
  assert.match(source, /read -rsp/);

  // And both remove it again, on every path.
  assert.match(source, /finally \{[\s\S]{0,200}Remove-Item Env:GH_TOKEN/);
  assert.match(source, /trap '[^']*unset [A-Z_]+'/);
  assert.match(source, /unset CITADEL_TOKEN/);
});

test('the curl fallback reuses the prompted variable and never echoes it', () => {
  assert.match(source, /curl -sH "Authorization: Bearer \$CITADEL_TOKEN"/);
  assert.match(source, /Never echo the token/);
  // `echo` appears only to terminate the silent `read` prompt's line.
  const echoes = [...source.matchAll(/echo[^\n']*/g)].map((match) => match[0]);
  for (const line of echoes) {
    assert.doesNotMatch(line, /TOKEN|github_pat/, `an echo may not print the token: ${line}`);
  }
});
