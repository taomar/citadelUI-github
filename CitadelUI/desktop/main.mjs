import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  safeStorage,
  session,
  utilityProcess,
} from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyPackagedSources } from './source-integrity.mjs';

import {
  DESKTOP_ALLOWED_HOST,
  DESKTOP_HOST,
  DESKTOP_ORIGIN,
  DESKTOP_PARTITION,
  DESKTOP_PORT,
  decodeCredentialKey,
  desktopDiagnosticsAllowed,
  desktopVersionLabel,
  desktopPermissionCheckAllowed,
  desktopPermissionAllowed,
  resourceRoot,
  serverProcessPath,
  trustedDesktopOrigin,
  trustedDesktopFileSystemRequest,
} from './runtime-config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const smokeTest = process.env.CITADEL_DESKTOP_SMOKE_TEST === 'true';
const userDataOverride = process.env.CITADEL_DESKTOP_USER_DATA_ROOT;

if (userDataOverride) app.setPath('userData', resolve(userDataOverride));
if (squirrelStartup) app.quit();

const instanceLock = app.requestSingleInstanceLock();
if (!instanceLock) app.quit();

let mainWindow = null;
let serverProcess = null;
let quitting = false;
let desktopBuild = null;

function atomicWrite(path, bytes) {
  return mkdir(dirname(path), { recursive: true }).then(async () => {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  });
}

async function encryptCredentialKey(value) {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return null;
  return safeStorage.encryptStringAsync(value);
}

async function loadCredentialKey() {
  const keyPath = join(app.getPath('userData'), 'secure', 'credential-key.bin');
  let encrypted;
  try {
    encrypted = await readFile(keyPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { key: null, reason: 'desktop-key-unreadable' };
    }
  }

  if (encrypted) {
    try {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) {
        return { key: null, reason: 'desktop-secure-storage-unavailable' };
      }
      const decrypted = await safeStorage.decryptStringAsync(encrypted);
      const key = decodeCredentialKey(decrypted.result);
      if (!key) return { key: null, reason: 'desktop-key-invalid' };
      if (decrypted.shouldReEncrypt) {
        try {
          const replacement = await safeStorage.encryptStringAsync(decrypted.result);
          await atomicWrite(keyPath, replacement);
        } catch {
          console.error(JSON.stringify({ event: 'citadel_desktop_key_reencrypt_failed' }));
        }
      }
      return { key, reason: 'ready' };
    } catch {
      return { key: null, reason: 'desktop-key-unreadable' };
    }
  }

  const key = randomBytes(32);
  const encoded = key.toString('base64');
  try {
    const protectedBytes = await encryptCredentialKey(encoded);
    if (!protectedBytes) {
      key.fill(0);
      return { key: null, reason: 'desktop-secure-storage-unavailable' };
    }
    await atomicWrite(keyPath, protectedBytes);
    return { key, reason: 'ready' };
  } catch {
    key.fill(0);
    return { key: null, reason: 'desktop-key-unreadable' };
  }
}

function childEnvironment(runtimeRoot, dataRoot) {
  const environment = {
    NODE_ENV: 'production',
    CITADEL_UI_HOST: DESKTOP_HOST,
    CITADEL_UI_PORT: String(DESKTOP_PORT),
    CITADEL_ALLOWED_HOST: DESKTOP_ALLOWED_HOST,
    CITADEL_ALLOWED_ORIGIN: DESKTOP_ORIGIN,
    CITADEL_DATA_ROOT: dataRoot,
    CITADEL_DESKTOP_RESOURCE_ROOT: runtimeRoot,
  };
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

function startServer(keyState) {
  const runtimeRoot = resourceRoot({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    desktopDirectory: here,
  });
  const entry = serverProcessPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    desktopDirectory: here,
  });
  const dataRoot = join(app.getPath('userData'), 'data');
  const child = utilityProcess.fork(entry, [], {
    cwd: runtimeRoot,
    env: childEnvironment(runtimeRoot, dataRoot),
    serviceName: 'Citadel UI Server',
    stdio: 'pipe',
  });
  serverProcess = child;

  return new Promise((resolveReady, rejectReady) => {
    let settled = false;
    let output = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectReady(new Error('The Citadel desktop server did not become ready.'));
    }, 20_000);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };

    child.once('spawn', () => {
      if (keyState.key) {
        child.postMessage({ type: 'credential-key', bytes: new Uint8Array(keyState.key) });
        keyState.key.fill(0);
      } else {
        child.postMessage({
          type: 'credential-key-unavailable',
          reason: keyState.reason,
        });
      }
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      output += chunk;
      let newline = output.indexOf('\n');
      while (newline >= 0) {
        const line = output.slice(0, newline).trim();
        output = output.slice(newline + 1);
        if (line) {
          console.log(line);
          try {
            const message = JSON.parse(line);
            if (message.event === 'citadel_ui_started' && message.status === 'ready') {
              finish(resolveReady, child);
            }
          } catch {
            // The embedded server owns its output format; non-JSON diagnostics
            // stay visible without being treated as a readiness signal.
          }
        }
        newline = output.indexOf('\n');
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => console.error(String(chunk).trim()));
    child.once('exit', (code) => {
      if (!settled) {
        finish(rejectReady, new Error(`The Citadel desktop server exited during startup (${code}).`));
        return;
      }
      if (!quitting) {
        dialog.showErrorBox(
          'Citadel UI stopped',
          'The embedded Citadel server stopped unexpectedly. Citadel UI will close.'
        );
        app.quit();
      }
    });
  });
}

function isTrustedContents(webContents) {
  return Boolean(webContents && trustedDesktopOrigin(webContents.getURL()));
}

function configureSession() {
  const desktopSession = session.fromPartition(DESKTOP_PARTITION);
  desktopSession.setPermissionCheckHandler(
    desktopPermissionCheckAllowed
  );
  desktopSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingOrigin = details?.requestingUrl || webContents?.getURL() || '';
    callback(
      isTrustedContents(webContents) &&
        desktopPermissionAllowed(permission, requestingOrigin)
    );
  });
  desktopSession.on('file-system-access-restricted', async (_event, details, callback) => {
    if (
      !mainWindow ||
      !trustedDesktopFileSystemRequest(details, mainWindow.webContents)
    ) {
      callback('deny');
      return;
    }
    if (smokeTest) {
      callback(
        details.isDirectory &&
          typeof details.path === 'string' &&
          resolve(details.path) === resolve(homedir())
          ? 'allow'
          : 'deny'
      );
      return;
    }
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Restricted folder',
      message: 'This folder is protected by the operating system.',
      detail: 'Choose another folder unless this Citadel repository must use the protected location.',
      buttons: ['Choose another folder', 'Allow this folder', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    callback(result.response === 1 ? 'allow' : result.response === 0 ? 'tryAgain' : 'deny');
  });
  return desktopSession;
}

function namesWithFillers(signature, minimum, prefix) {
  const names = [...signature];
  for (let index = 1; names.length < minimum; index += 1) {
    names.push(`${prefix}${String(index).padStart(3, '0')}`);
  }
  return names;
}

function parameterType(name) {
  if (/Units$|Count$|Capacity$|Index$/.test(name)) return 'int';
  if (/^(enable|use|configure|is)[A-Z]/.test(name)) return 'bool';
  if (/Instances$|Config$|Defaults$|Aliases$|Mapping$|services$/i.test(name)) return 'array';
  if (['apim', 'apimManagedIdentity', 'keyVault', 'useCase', 'foundry'].includes(name)) {
    return 'object';
  }
  return 'string';
}

function parameterValue(name, environmentName) {
  if (name === 'environmentName') return `'${environmentName}'`;
  if (name === 'location') return "'westeurope'";
  if (name === 'apimSku') return "'Developer'";
  const type = parameterType(name);
  if (type === 'int') return '1';
  if (type === 'bool') return 'false';
  if (type === 'array') return '[]';
  if (type === 'object') return '{}';
  return "'fixture'";
}

function bicepParamText(using, names, environmentName) {
  return [
    `using '${using}'`,
    '',
    ...names.map((name) => `param ${name} = ${parameterValue(name, environmentName)}`),
    '',
  ].join('\n');
}

function bicepTemplateText(names) {
  return [
    "targetScope = 'subscription'",
    '',
    ...names.map((name) => `param ${name} ${parameterType(name)}`),
    '',
  ].join('\n');
}

async function desktopFixtureFiles(environmentName) {
  const runtimeRoot = resourceRoot({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    desktopDirectory: here,
  });
  const { primaryCapabilities } = await import(
    pathToFileURL(join(runtimeRoot, 'shared', 'citadel-core.mjs')).href
  );
  const accessRoot = 'bicep/infra/citadel-access-contracts';
  const mainNames = namesWithFillers(
    primaryCapabilities.mainSignature,
    primaryCapabilities.mainMinimumParameters,
    'desktopMain'
  );
  const llmNames = [...primaryCapabilities.llmSignature];
  const accessNames = namesWithFillers(
    primaryCapabilities.accessSignature,
    primaryCapabilities.accessMinimumParameters,
    'desktopAccess'
  );
  return {
    mainPath: primaryCapabilities.mainPath,
    files: {
      [primaryCapabilities.mainPath]: bicepParamText('./main.bicep', mainNames, environmentName),
      'bicep/infra/main.bicep': bicepTemplateText(mainNames),
      [primaryCapabilities.llmPath]: bicepParamText('./main.bicep', llmNames, environmentName),
      'bicep/infra/llm-backend-onboarding/main.bicep': bicepTemplateText(llmNames),
      [`${accessRoot}/main.bicepparam`]: bicepParamText(
        'main.bicep',
        accessNames,
        environmentName
      ),
      [`${accessRoot}/main.bicep`]: bicepTemplateText(accessNames),
      [`${accessRoot}/policies/default-ai-product-policy.xml`]:
        '<policies><inbound><base /></inbound><backend><base /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>\n',
    },
  };
}

async function probeRestrictedFileSystemAccess(window) {
  await window.webContents.executeJavaScript(`
    (() => {
      globalThis.__citadelDesktopFileProbe = {
        done: false,
        error: null,
        handle: null
      };
      document.addEventListener('paste', (event) => {
        event.preventDefault();
        const item = event.clipboardData?.items?.[0];
        if (!item || typeof item.getAsFileSystemHandle !== 'function') {
          globalThis.__citadelDesktopFileProbe.done = true;
          globalThis.__citadelDesktopFileProbe.error = 'File-system clipboard handle unavailable';
          return;
        }
        item.getAsFileSystemHandle().then((handle) => {
          globalThis.__citadelDesktopFileProbe.handle = handle;
          globalThis.__citadelDesktopFileProbe.done = true;
        }).catch((error) => {
          globalThis.__citadelDesktopFileProbe.error = String(error);
          globalThis.__citadelDesktopFileProbe.done = true;
        });
      }, { capture: true, once: true });
      window.focus();
      document.body.focus();
    })()
  `);
  clipboard.clear();
  await Promise.race([
    clipboard.write([
      new ClipboardItem({ 'text/uri-list': pathToFileURL(homedir()).href }),
    ]),
    delay(5_000).then(() => {
      throw new Error('Restricted local file clipboard setup timed out.');
    }),
  ]);
  window.webContents.focus();
  window.webContents.paste();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await window.webContents.executeJavaScript(`
      (async () => {
        const probe = globalThis.__citadelDesktopFileProbe;
        if (!probe?.done) return { done: false };
        return {
          done: true,
          error: probe.error,
          kind: probe.handle?.kind || null,
          permission: probe.handle
            ? await probe.handle.queryPermission({ mode: 'read' })
            : null
        };
      })()
    `);
    if (result.done) return result;
    await delay(50);
  }
  return { done: false, error: 'Restricted local file access probe timed out' };
}

async function runDesktopAcceptance(window) {
  const existingFixture = await desktopFixtureFiles('desktop-before');
  const newFixture = await desktopFixtureFiles('desktop-new');
  window.show();
  window.webContents.focus();
  try {
    const localFiles = await probeRestrictedFileSystemAccess(window);
    if (
      !localFiles.done ||
      localFiles.error ||
      localFiles.kind !== 'directory' ||
      localFiles.permission !== 'granted'
    ) {
      throw new Error(`Restricted local folder selection failed: ${JSON.stringify(localFiles)}`);
    }
    const workspace = await window.webContents.executeJavaScript(`
      (async () => {
        const { BrowserDirectoryProvider } = await import('/js/directory-provider.mjs');
        const { WorkspaceRegistry } = await import('/js/registry.mjs');
        const {
          assertSupportedScan,
          attachEnvironment,
          scanProvider
        } = await import('/js/workspace-context.mjs');
        const fixtureRootName = 'citadel-desktop-acceptance-' + crypto.randomUUID();
        const storageRoot = await navigator.storage.getDirectory();
        const fixtureRoot = await storageRoot.getDirectoryHandle(fixtureRootName, { create: true });
        const writeFixture = async (name, fixture) => {
          const root = await fixtureRoot.getDirectoryHandle(name, { create: true });
          for (const [alias, text] of Object.entries(fixture.files)) {
            const parts = alias.split('/');
            const leaf = parts.pop();
            let directory = root;
            for (const part of parts) {
              directory = await directory.getDirectoryHandle(part, { create: true });
            }
            const file = await directory.getFileHandle(leaf, { create: true });
            const writable = await file.createWritable();
            await writable.write(new TextEncoder().encode(text));
            await writable.close();
          }
          return root;
        };
        const directRead = async (root, alias) => {
          const parts = alias.split('/');
          const leaf = parts.pop();
          let directory = root;
          for (const part of parts) {
            directory = await directory.getDirectoryHandle(part);
          }
          const file = await (await directory.getFileHandle(leaf)).getFile();
          return new TextDecoder().decode(await file.arrayBuffer());
        };
        const existingFixture = ${JSON.stringify(existingFixture)};
        const newFixture = ${JSON.stringify(newFixture)};
        try {
          const existingHandle = await writeFixture('existing', existingFixture);
          const newHandle = await writeFixture('new', newFixture);
          const registry = new WorkspaceRegistry({
            dbName: 'citadel-desktop-acceptance-' + crypto.randomUUID(),
            stateKey: 'citadel-desktop-acceptance.active',
            testMode: true
          });
          const existingProvider = new BrowserDirectoryProvider(existingHandle);
          await existingProvider.assertWritable({ request: true });
          const existingScan = await scanProvider(existingProvider);
          assertSupportedScan(existingScan);
          const existingPath = ${JSON.stringify(
            process.platform === 'win32'
              ? 'C:\\CitadelDesktopAcceptance\\existing'
              : '/CitadelDesktopAcceptance/existing'
          )};
          const newPath = ${JSON.stringify(
            process.platform === 'win32'
              ? 'C:\\CitadelDesktopAcceptance\\new'
              : '/CitadelDesktopAcceptance/new'
          )};
          const attachedExisting = await attachEnvironment({
            projectLabel: 'Desktop acceptance',
            environmentLabel: 'Existing local',
            localPath: existingPath,
            handle: existingHandle,
            scan: existingScan,
            provider: existingProvider,
            registry,
            mirror: async () => {}
          });

          const project = (await registry.listProjects())[0];
          const retainedHandle = await registry.getHandle(attachedExisting.environment.id);
          const existingRetained = await retainedHandle.isSameEntry(existingHandle);
          const reopenedProvider = new BrowserDirectoryProvider(retainedHandle);
          const before = await reopenedProvider.read(existingFixture.mainPath);
          const nextText = before.text.replace(
            "param environmentName = 'desktop-before'",
            "param environmentName = 'desktop-after'"
          );
          if (nextText === before.text) {
            throw new Error('Desktop value edit did not match its source.');
          }
          await reopenedProvider.write(
            existingFixture.mainPath,
            new TextEncoder().encode(nextText),
            { expectedHash: before.hash }
          );
          const after = await reopenedProvider.read(existingFixture.mainPath);

          let duplicateRejected = false;
          try {
            await registry.addEnvironment(
              project.id,
              'Duplicate existing',
              existingHandle,
              null,
              { localPath: existingPath }
            );
          } catch (error) {
            if (!/identical to, or overlaps/i.test(error?.message || '')) throw error;
            duplicateRejected = true;
          }

          const newProvider = new BrowserDirectoryProvider(newHandle);
          await newProvider.assertWritable({ request: true });
          const newScan = await scanProvider(newProvider);
          assertSupportedScan(newScan);
          const attachedNew = await attachEnvironment({
            project,
            environmentLabel: 'New local',
            localPath: newPath,
            handle: newHandle,
            scan: newScan,
            provider: newProvider,
            registry,
            mirror: async () => {}
          });
          const projects = await registry.listProjects();
          const environments = await registry.listEnvironments(project.id);
          const newRead = await newProvider.read(newFixture.mainPath);
          const storedText = await directRead(retainedHandle, existingFixture.mainPath);
          return {
            storage: 'origin-private-file-system',
            existingCompatibility: existingScan.compatibility,
            newCompatibility: newScan.compatibility,
            existingRetained,
            duplicateRejected,
            projectCount: projects.length,
            environmentCount: environments.length,
            existingSource: attachedExisting.environment.source?.kind,
            newSource: attachedNew.environment.source?.kind,
            savedValue: after.text.includes("param environmentName = 'desktop-after'"),
            storageSaved: storedText.includes("param environmentName = 'desktop-after'"),
            newValueReadable: newRead.text.includes("param environmentName = 'desktop-new'")
          };
        } finally {
          await storageRoot.removeEntry(fixtureRootName, { recursive: true });
        }
      })()
    `);
    return { localFiles, workspace };
  } finally {
    clipboard.clear();
    window.hide();
  }
}

async function waitForRenderer(window, expression, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await window.webContents.executeJavaScript(`({
      ready: Boolean(${expression}),
      error: document.querySelector('#gate-error:not([hidden])')?.textContent || null
    })`);
    if (result.error) throw new Error(`${label}: ${result.error}`);
    if (result.ready) return;
    await delay(50);
  }
  throw new Error(`Packaged UI did not reach ${label}.`);
}

async function installVersionBadge(window) {
  await window.webContents.insertCSS(`
    #citadel-desktop-version {
      position: fixed;
      left: .5rem;
      bottom: .5rem;
      z-index: 40;
      padding: .125rem .375rem;
      border-radius: .2rem;
      color: var(--nav-muted, #c3dcf2);
      background: var(--nav, #0b3c68);
      font-family: inherit;
      font-size: .6875rem;
      line-height: 1.4;
      white-space: nowrap;
      user-select: text;
    }
  `);
  const label = desktopVersionLabel(desktopBuild);
  const title = `Citadel UI ${desktopBuild.version}\nApplication source: ${desktopBuild.applicationRevision}\nRelease: ${desktopBuild.releaseRevision || 'development'}`;
  await window.webContents.executeJavaScript(`(() => {
    let badge = document.getElementById('citadel-desktop-version');
    if (!badge) {
      badge = document.createElement('small');
      badge.id = 'citadel-desktop-version';
      badge.setAttribute('aria-label', 'Citadel UI desktop version and application source');
      document.body.append(badge);
    }
    badge.textContent = ${JSON.stringify(label)};
    badge.title = ${JSON.stringify(title)};
  })()`);
}

function retainVersionBadge(window) {
  window.webContents.on('did-finish-load', () => {
    installVersionBadge(window).catch((error) => {
      if (window.isDestroyed()) return;
      console.error(JSON.stringify({ event: 'citadel_desktop_version_display_failed', error: error.message }));
      dialog.showErrorBox('Citadel UI version could not be displayed', error.message);
    });
  });
}

async function runInterfaceAcceptance(window) {
  window.show();
  await waitForRenderer(window, `document.querySelector('#gate-username')`, 'owner sign-in');
  await window.webContents.executeJavaScript(`(() => {
    if (document.querySelector('meta[name="citadel-auth"]')?.content !== 'unclaimed') {
      throw new Error('Desktop UI acceptance requires a fresh isolated profile.');
    }
    document.querySelector('#gate-username').value = 'desktop-smoke';
    document.querySelector('#gate-password').value = crypto.randomUUID();
    document.querySelector('.gate-form').requestSubmit();
  })()`);
  await waitForRenderer(window, `document.querySelector('.workspace-catalog')`, 'workspace catalog');
  const versionBadge = await window.webContents.executeJavaScript(`(() => {
    const badge = document.getElementById('citadel-desktop-version');
    const bounds = badge?.getBoundingClientRect();
    return {
      text: badge?.textContent,
      left: bounds?.left,
      bottom: bounds ? innerHeight - bounds.bottom : null,
      fontSize: badge ? parseFloat(getComputedStyle(badge).fontSize) : null
    };
  })()`);
  if (versionBadge.text !== desktopVersionLabel(desktopBuild) ||
      versionBadge.left < 0 || versionBadge.left > 24 ||
      versionBadge.bottom < 0 || versionBadge.bottom > 24 ||
      !versionBadge.fontSize || versionBadge.fontSize > 12) {
    throw new Error(`The lower-left version label is missing or misplaced: ${JSON.stringify(versionBadge)}`);
  }
  await window.webContents.executeJavaScript(`(() => {
    const add = [...document.querySelectorAll('.workspace-catalog button')]
      .find((button) => /^Add (workspace|your first workspace)$/.test(button.textContent.trim()));
    if (!add) throw new Error('The real Add workspace control is missing.');
    add.click();
  })()`);
  const selector = `dialog[open] select[aria-label="Configuration format"]`;
  await waitForRenderer(window, `document.querySelector(${JSON.stringify(selector)})`, 'configuration format selector');
  const controls = await window.webContents.executeJavaScript(`(() => {
    const selector = ${JSON.stringify(selector)};
    const formats = [...document.querySelector(selector).options].map((option) => option.value);
    const choices = () => [...document.querySelectorAll('dialog[open] .catalog-choice-option')]
      .map((button) => ({ label: button.querySelector('strong').textContent, disabled: button.disabled }));
    const bicep = choices();
    const format = document.querySelector(selector);
    format.value = 'terraform';
    format.dispatchEvent(new Event('change', { bubbles: true }));
    return { formats, bicep, terraform: choices() };
  })()`);
  const labels = ['Existing GitHub Repo', 'New GitHub Repo', 'Create local from Citadel source', 'Local'];
  if (JSON.stringify(controls.formats) !== JSON.stringify(['bicep', 'terraform']) ||
      controls.bicep.length !== labels.length || controls.terraform.length !== labels.length ||
      controls.bicep.some((item, index) => item.label !== labels[index] || item.disabled) ||
      controls.terraform.some((item, index) => item.label !== labels[index] ||
        item.disabled !== [1, 2].includes(index))) {
    throw new Error(`Packaged Add workspace is not the reviewed UI: ${JSON.stringify(controls)}`);
  }
  if (process.env.CITADEL_DESKTOP_SMOKE_SCREENSHOT) {
    const screenshot = resolve(process.env.CITADEL_DESKTOP_SMOKE_SCREENSHOT);
    await mkdir(dirname(screenshot), { recursive: true });
    await writeFile(screenshot, (await window.webContents.capturePage()).toPNG());
  }
  await window.webContents.executeJavaScript(`(() => {
    const cancel = [...document.querySelectorAll('dialog[open] button')]
      .find((button) => button.textContent.trim() === 'Cancel');
    if (!cancel) throw new Error('Add workspace cancel control is missing.');
    cancel.click();
  })()`);
  const nativeParser = await window.webContents.executeJavaScript(`(async () => {
    const { initializeNativeParser, applyNativeEdits, parseNativeValues } =
      await import('/shared/terraform/parser.mjs');
    await initializeNativeParser();
    const result = applyNativeEdits('environment_name = "before"\\n', [
      { op: 'set', path: ['environment_name'], value: 'after' }
    ]);
    return parseNativeValues(result).value.environment_name === 'after';
  })()`);
  if (!nativeParser) throw new Error('Packaged native Terraform parser failed to edit a value.');

  const created = new Promise((resolveWindow, rejectWindow) => {
    const onCreated = (child) => {
      clearTimeout(timer);
      resolveWindow(child);
    };
    const timer = setTimeout(() => {
      window.webContents.removeListener('did-create-window', onCreated);
      rejectWindow(new Error('Packaged Diagnostics did not open.'));
    }, 15_000);
    window.webContents.once('did-create-window', onCreated);
  });
  await window.webContents.executeJavaScript(`document.querySelector('a[href="/debug.html"]').click()`);
  const diagnostics = await created;
  try {
    await waitForRenderer(diagnostics,
      `document.querySelector('#debug-capture-switch:not(:disabled)') && document.querySelector('#citadel-desktop-version')`,
      'authenticated Diagnostics controls and version');
    if (!desktopDiagnosticsAllowed(diagnostics.webContents.getURL())) {
      throw new Error('Diagnostics opened outside the desktop origin.');
    }
  } finally {
    diagnostics.destroy();
  }
  return { ownerSignIn: true, currentSourceChoices: true, nativeParser, diagnostics: true, versionBadge, ...controls };
}

function protectNavigation(window) {
  window.webContents.on('will-navigate', (event, url) => {
    if (!trustedDesktopOrigin(url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

async function createWindow(desktopSession) {
  const webPreferences = {
    session: desktopSession,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    spellcheck: false,
    devTools: !app.isPackaged,
  };
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    backgroundColor: '#f4f8fc',
    autoHideMenuBar: true,
    title: `Citadel UI ${app.getVersion()} - source ${desktopBuild.applicationRevision.slice(0, 7)}${desktopBuild.dirty ? ' (development)' : ''}`,
    webPreferences,
  });
  mainWindow = window;

  protectNavigation(window);
  window.on('page-title-updated', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => desktopDiagnosticsAllowed(url)
    ? { action: 'allow', overrideBrowserWindowOptions: { webPreferences, autoHideMenuBar: true } }
    : { action: 'deny' });
  window.webContents.on('did-create-window', (child) => {
    protectNavigation(child);
    retainVersionBadge(child);
  });
  window.once('ready-to-show', () => {
    if (!smokeTest) window.show();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  await window.loadURL(DESKTOP_ORIGIN);
  await installVersionBadge(window);
  retainVersionBadge(window);
  if (smokeTest) {
    const browser = await window.webContents.executeJavaScript(
      `({
        title: document.title,
        secureContext: globalThis.isSecureContext,
        directoryPicker: typeof globalThis.showDirectoryPicker === 'function',
        indexedDB: Boolean(globalThis.indexedDB),
        origin: globalThis.location.origin
      })`
    );
    const interfaceCheck = await runInterfaceAcceptance(window);
    const acceptance = await runDesktopAcceptance(window);
    const passed =
      browser.title === 'Citadel Control Panel' &&
      browser.secureContext === true &&
      browser.directoryPicker === true &&
      browser.indexedDB === true &&
      browser.origin === DESKTOP_ORIGIN &&
      acceptance.localFiles.done === true &&
      acceptance.localFiles.error === null &&
      acceptance.localFiles.kind === 'directory' &&
      acceptance.localFiles.permission === 'granted' &&
      acceptance.workspace.storage === 'origin-private-file-system' &&
      acceptance.workspace.existingCompatibility === 'supported' &&
      acceptance.workspace.newCompatibility === 'supported' &&
      acceptance.workspace.existingRetained === true &&
      acceptance.workspace.duplicateRejected === true &&
      acceptance.workspace.projectCount === 1 &&
      acceptance.workspace.environmentCount === 2 &&
      acceptance.workspace.existingSource === 'local' &&
      acceptance.workspace.newSource === 'local' &&
      acceptance.workspace.savedValue === true &&
      acceptance.workspace.storageSaved === true &&
      acceptance.workspace.newValueReadable === true;
    console.log(JSON.stringify({
      event: 'citadel_desktop_smoke',
      passed,
      version: desktopBuild.version,
      applicationRevision: desktopBuild.applicationRevision,
      releaseRevision: desktopBuild.releaseRevision,
      dirty: desktopBuild.dirty,
      interface: interfaceCheck,
      ...browser,
      ...acceptance,
    }));
    process.exitCode = passed ? 0 : 1;
    app.quit();
  }
  return window;
}

async function launch() {
  const source = JSON.parse(await readFile(join(here, 'application-source.json'), 'utf8'));
  desktopBuild = app.isPackaged
    ? await verifyPackagedSources(process.resourcesPath)
    : { version: app.getVersion(), applicationRevision: source.revision, dirty: true };
  if (desktopBuild.applicationRevision !== source.revision || desktopBuild.version !== app.getVersion()) {
    throw new Error('The desktop version or application source does not match its build identity.');
  }
  const desktopSession = configureSession();
  const keyState = await loadCredentialKey();
  try {
    await startServer(keyState);
  } catch (error) {
    keyState.key?.fill(0);
    throw error;
  }
  await createWindow(desktopSession);
}

app.whenReady().then(launch).catch((error) => {
  if (smokeTest) {
    console.error(JSON.stringify({
      event: 'citadel_desktop_smoke_error',
      error: error?.message || 'The desktop application could not start.',
    }));
    quitting = true;
    serverProcess?.kill();
    serverProcess = null;
    app.exit(1);
    return;
  }
  dialog.showErrorBox(
    'Citadel UI could not start',
    error?.message || 'The desktop application could not start.'
  );
  app.exit(1);
});

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on('activate', () => {
  if (!mainWindow && serverProcess) {
    createWindow(session.fromPartition(DESKTOP_PARTITION)).catch((error) => {
      dialog.showErrorBox('Citadel UI could not open', error?.message || 'The window could not open.');
    });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  quitting = true;
  serverProcess?.kill();
  serverProcess = null;
});
