import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
const guide = (await readFile(new URL('../../guides/deployment.md', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const appReadme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
const azdProject = await readFile(new URL('../azure.yaml', import.meta.url), 'utf8');
const parameterFile = await readFile(new URL('../infra/main.bicepparam', import.meta.url), 'utf8');
const mapping = JSON.parse(await readFile(new URL('../infra/main.parameters.json', import.meta.url), 'utf8'));
const imageScript = await readFile(new URL('../scripts/deploy-image.ps1', import.meta.url), 'utf8');
const desktopReadme = await readFile(new URL('../desktop/README.md', import.meta.url), 'utf8');
const releaseRecord = await readFile(new URL('../RELEASE.md', import.meta.url), 'utf8');
const desktopPackage = JSON.parse(await readFile(new URL('../desktop/package.json', import.meta.url), 'utf8'));
const releaseTag = `citadel-ui-desktop-v${desktopPackage.version}`;
const buildCommit = 'bb6b7cae2f42ff5f4f3dac6dd9cfcd6aedcb7a9f';
const applicationSource = JSON.parse(await readFile(new URL('../desktop/application-source.json', import.meta.url), 'utf8'));
const clone = `git clone --branch ${releaseTag} --single-branch https://github.com/taomar/citadelUI-github.git`;

function section(heading) {
  const start = guide.indexOf(`## ${heading}\n`);
  assert.ok(start >= 0, `Missing deployment section: ${heading}`);
  const end = guide.indexOf('\n## ', start + 1);
  return guide.slice(start, end < 0 ? undefined : end);
}
function codeBlocks(text, language) {
  return [...text.matchAll(new RegExp('```' + language + '\\r?\\n([\\s\\S]*?)```', 'g'))]
    .map((match) => match[1]);
}

test('deployment docs: checkout instructions pin the exact published build, not main', () => {
  assert.ok(readme.indexOf(clone) >= 0 && readme.indexOf(clone) < readme.indexOf('## Overview'));
  assert.match(readme, /Never run `azd up`/);
  assert.match(readme, /git rev-parse HEAD/);
  for (const text of [readme, guide, appReadme, desktopReadme]) {
    assert.ok(text.includes(applicationSource.revision));
    assert.doesNotMatch(text, /git clone --branch main\b/);
  }
});

test('deployment docs: Electron release assets are operator-facing deployment options', () => {
  for (const text of [readme, guide, appReadme, desktopReadme]) {
    for (const asset of ['CitadelUISetup.exe', 'CitadelUIPortable.zip',
      'CitadelUI-macOS-arm64.dmg', 'CitadelUI-macOS-x64.dmg', 'SHA256SUMS.txt']) {
      assert.ok(text.includes(`releases/download/${releaseTag}/${asset}`), `Unpinned release asset: ${asset}`);
    }
    assert.doesNotMatch(text, /releases\/latest\/download\//);
  }
  const desktop = section('Windows and macOS desktop release');
  assert.match(desktop, /127\.0\.0\.1:4174/);
  assert.match(desktop, /not notarized/i);
  assert.match(desktop, /M1, M2, M3, M4/);
  assert.match(desktop, /right-click \*\*Citadel UI\*\*.*choose \*\*Open\*\*/s);
  assert.match(desktop, /restricted local\s+directory handle/);
  assert.match(desktop, /github_pat_/);
  assert.match(desktop, /gho_/);
});

test('deployment docs: release record separates the full build from its application baseline', () => {
  assert.ok(releaseRecord.includes(buildCommit));
  assert.match(releaseRecord, /5791d4358f2696c1f4ec2805bd6bcfc2c7d729e8/);
  assert.match(releaseRecord, /actions\/runs\/34866034370/);
  assert.match(releaseRecord, /173 application files/);
  assert.match(releaseRecord, /Documentation-only follow-ups do not move this tag/);
  assert.match(releaseRecord, /simulated newer release/);
  assert.match(releaseRecord, /Native\s+folder pickers.*are not\s+automated/s);
  assert.ok(releaseRecord.includes(applicationSource.revision));
  assert.match(releaseRecord, /Desktop v1\.1\.5 compatibility release/);
});
test('deployment docs: Azure examples configure a Bicep parameter file instead of a shell parameter map', () => {
  for (const heading of ['Fresh Azure deployment', 'Deploy on an existing subnet and resources']) {
    const text = section(heading);
    const code = codeBlocks(text, 'powershell').join('\n');
    assert.ok(code.includes(clone));
    assert.match(code, /cd \.\\citadelUI-github\\CitadelUI/);
    assert.match(code, /az login/);
    assert.match(code, /azd env new .* --subscription .* --location /);
    assert.match(text, /infra\/main\.bicepparam/);
    assert.match(code, /azd env get-value SERVICE_CITADELUI_URI/);
    assert.doesNotMatch(code, /ExistingResources|GetEnumerator|azd env set|az acr build|private-dns/);
    if (heading === 'Fresh Azure deployment') assert.match(code, /azd up/);
    else assert.match(code, /azd provision\s+\.\\scripts\\deploy-image\.ps1/);
  }
});

test('deployment docs: every documented Bicep parameter is supported by the input file', () => {
  assert.match(parameterFile, /^using '\.\/main\.bicep'/);
  for (const block of codeBlocks(guide, 'bicep')) {
    for (const [, name] of block.matchAll(/^param (\w+) =/gm)) {
      assert.match(parameterFile, new RegExp(`^param ${name} =`, 'm'));
      assert.ok(mapping.parameters[name], `Missing environment mapping for ${name}`);
    }
  }
  assert.match(guide, /imports evaluated, nonsecret inputs into the selected environment/);
});

test('deployment docs: hosted setup keeps owner sign-in and Key Vault', () => {
  for (const text of [readme, guide]) assert.doesNotMatch(text, /\bentra\b|AZURE_AUTH_CLIENT|az ad (app|sp)/i);
  assert.match(guide, /param allowPublicIngressWithoutAuth = true/);
  assert.match(guide, /param privateDeployment = false/);
  assert.match(guide, /preserves an existing enabled credential key/);
  assert.match(azdProject, /postprovision:\s+shell: pwsh\s+run: \.\/scripts\/ensure-credential-key\.ps1\s+continueOnError: false/);
});

test('deployment docs: parameter inputs are synchronized before resource preflight', () => {
  assert.match(azdProject, /preprovision:\s+shell: pwsh\s+run: \.\/scripts\/prepare-deployment\.ps1\s+continueOnError: false/);
  assert.match(guide, /leave subnet and workspace selectors empty/);
  assert.match(guide, /Do not put passwords, tokens or key material in the parameter file/);
});

test('deployment docs: native azd redeploys public Legacy images and retains the specialized build helper', () => {
  const text = section('Redeploy an existing Citadel UI container app');
  const code = codeBlocks(text, 'powershell').join('\n');
  assert.match(code, /azd env select/);
  assert.match(code, /^azd deploy citadelui$/m);
  assert.doesNotMatch(code, /azd (up|provision|env new)|az (acr|containerapp)/);
  assert.match(text, /LegacyRegistryPermissions/);
  assert.match(text, /ABAC or private registries/);
  assert.match(text, /scripts\\deploy-image\.ps1/);
  assert.match(text, /does not run provisioning hooks or initialize a missing\s+credential-encryption key/);
  assert.match(imageScript, /--container-name citadelui --image \$ImageReference/);
  assert.match(imageScript, /azd env set SERVICE_CITADELUI_IMAGE_NAME \$ImageReference/);
  assert.match(imageScript, /@\('--source-acr-auth-id', '\[caller\]'\)/);
  assert.doesNotMatch(imageScript, /azd (up|provision|env new)/);
});

test('deployment docs: private endpoint staging and logging limitations are explicit', () => {
  assert.match(guide, /provisioning\/build host must be inside that network/);
  assert.match(guide, /`azure-monitor` plus diagnostic settings/);
  assert.match(guide, /public workspace ingestion\/query remain disabled/);
  assert.match(guide, /ordinary azd remote build is\s+not sufficient/);
});

test('deployment docs: both local shells are runnable from a clone', () => {
  for (const text of [section('Local deployment - PowerShell'), appReadme]) {
    const [code] = codeBlocks(text, 'powershell');
    assert.ok(code.includes(clone));
    assert.match(code, /Copy-Item container\.env\.example container\.env/);
    assert.match(code, /\.\\scripts\\start\.ps1/);
  }
  for (const text of [section('Local deployment - Bash'), appReadme]) {
    const [code] = codeBlocks(text, 'bash');
    assert.ok(code.includes(clone));
    assert.match(code, /cp container\.env\.example container\.env/);
    assert.match(code, /install -d -m 0700 -o 10001 -g 10001 \.data/);
    assert.match(code, /bash scripts\/start\.sh/);
  }
});

test('deployment docs: README deployment links resolve to guide headings', () => {
  const anchors = new Set([...guide.matchAll(/^#{1,6} (.+)$/gm)].map((match) =>
    match[1].trim().toLowerCase().replace(/[^\w -]/g, '').replaceAll(' ', '-')
  ));
  const links = [...readme.matchAll(/\]\(\.\/guides\/deployment\.md#([^)]+)\)/g)];
  assert.ok(links.length >= 6);
  for (const [, anchor] of links) assert.ok(anchors.has(anchor), `Missing guide anchor: ${anchor}`);
});
