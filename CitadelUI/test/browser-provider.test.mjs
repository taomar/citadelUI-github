import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { BrowserDirectoryProvider, sha256 } from '../web/js/directory-provider.mjs';
import { assertSupportedScan } from '../web/js/workspace-context.mjs';
import { discoverWorkspace } from '../shared/citadel-core.mjs';
import { WorkspaceService } from '../web/js/workspace-service.mjs';

globalThis.crypto ||= webcrypto;

class MockFileHandle {
  kind = 'file';

  constructor(name, content, trace) {
    this.name = name;
    this.content = new TextEncoder().encode(content);
    this.trace = trace;
    this.lastModified = Date.now();
  }

  async getFile() {
    this.trace.push(`read:${this.name}`);
    const bytes = this.content.slice();
    return {
      size: bytes.byteLength,
      lastModified: this.lastModified,
      arrayBuffer: async () => bytes.buffer,
    };
  }

  async createWritable() {
    this.trace.push(`writable:${this.name}`);
    return {
      write: async (bytes) => {
        this.content = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
      },
      close: async () => {
        this.lastModified += 1;
      },
      abort: async () => {},
    };
  }

  async isSameEntry(other) {
    return other === this;
  }
}

class MockDirectoryHandle {
  kind = 'directory';

  constructor(name, entries, trace, path = name) {
    this.name = name;
    this.children = new Map();
    this.trace = trace;
    this.path = path;
    for (const [childName, value] of Object.entries(entries)) {
      this.children.set(
        childName,
        typeof value === 'string'
          ? new MockFileHandle(childName, value, trace)
          : new MockDirectoryHandle(childName, value, trace, `${path}/${childName}`)
      );
    }
  }

  async queryPermission() {
    return 'granted';
  }

  async requestPermission() {
    return 'granted';
  }

  async *entries() {
    this.trace.push(`entries:${this.path}`);
    yield* this.children.entries();
  }

  async getDirectoryHandle(name, options = {}) {
    this.trace.push(`directory:${this.path}/${name}`);
    let child = this.children.get(name);
    if (!child && options.create) {
      child = new MockDirectoryHandle(name, {}, this.trace, `${this.path}/${name}`);
      this.children.set(name, child);
    }
    if (!child || child.kind !== 'directory') {
      throw new DOMException('Not found', 'NotFoundError');
    }
    return child;
  }

  async getFileHandle(name, options = {}) {
    this.trace.push(`file:${this.path}/${name}`);
    let child = this.children.get(name);
    if (!child && options.create) {
      child = new MockFileHandle(name, '', this.trace);
      this.children.set(name, child);
    }
    if (!child || child.kind !== 'file') throw new DOMException('Not found', 'NotFoundError');
    return child;
  }

  async removeEntry(name) {
    const child = this.children.get(name);
    if (!child) throw new DOMException('Not found', 'NotFoundError');
    if (child.kind === 'directory' && child.children.size) {
      throw new DOMException('Directory is not empty', 'InvalidModificationError');
    }
    this.children.delete(name);
  }

  async isSameEntry(other) {
    return other === this;
  }
}

function fixture(name, trace) {
  return new MockDirectoryHandle(name, {
    '.azure': {
      dev: {
        '.env':
          'SECRET=never-read\r\n' +
          'AZURE_SUBSCRIPTION_ID="11111111-1111-1111-1111-111111111111"\r\n' +
          'AFTER_SECRET=also-never-read\r\n',
      },
    },
    '.env': 'ROOT_SECRET=never-read',
    '.scratch-contracts': {
      fixture: {
        'main.bicepparam': "param environmentName = 'qa'\n",
      },
    },
    bicep: {
      infra: {
        'main.bicepparam':
          "using 'main.bicep'\nparam apimSku = 'Developer'\nparam apimServiceName = readEnvironmentVariable('APIM_SERVICE_NAME', 'local-apim')\nparam resourceGroupName = 'rg-local'\n",
        'main.bicep':
          "@allowed(['Developer', 'Basic'])\nparam apimSku string\nparam apimServiceName string\nparam resourceGroupName string\n",
        onboarding: {
          'main.bicepparam': "param llmBackendConfig = []\n",
        },
        policy: {
          'main.xml': '<policies><inbound /></policies>',
        },
      },
    },
    notes: {
      'ignore.txt': 'unrelated',
    },
  }, trace);
}

const trace = [];
const provider = new BrowserDirectoryProvider(fixture('arbitrary-folder-name', trace));
const entries = await provider.entries();
assert.deepEqual(
  entries.map((entry) => entry.alias),
  [
    'bicep/infra/main.bicep',
    'bicep/infra/main.bicepparam',
    'bicep/infra/onboarding/main.bicepparam',
    'bicep/infra/policy/main.xml',
  ]
);
assert.equal(trace.some((entry) => entry.includes('.azure/')), false, 'provider entered .azure');
assert.equal(trace.some((entry) => entry.includes('.env')), false, 'provider opened .env');
assert.equal(
  trace.some((entry) => entry.includes('.scratch-contracts')),
  false,
  'provider entered a hidden test directory'
);

const beforeDenied = trace.length;
await assert.rejects(() => provider.read('.azure/dev/.env'), /\.azure/);
await assert.rejects(() => provider.read('.env'), /environment files/);
assert.equal(trace.length, beforeDenied, 'denied aliases touched a handle');

const subscription = await provider.readSubscriptionId('dev');
assert.deepEqual(
  {
    available: subscription.available,
    configured: subscription.configured,
    value: subscription.value,
    valid: subscription.valid,
    source: subscription.source,
  },
  {
    available: true,
    configured: true,
    value: '11111111-1111-1111-1111-111111111111',
    valid: true,
    source: '.azure/dev/.env',
  }
);
assert.equal('text' in subscription, false, 'subscription bridge exposed full env text');
assert.equal('bytes' in subscription, false, 'subscription bridge exposed full env bytes');
const savedSubscription = await provider.writeSubscriptionId(
  'dev',
  '22222222-2222-2222-2222-222222222222',
  subscription.hash
);
assert.equal(savedSubscription.value, '22222222-2222-2222-2222-222222222222');
const envHandle = await (await (await provider.root.getDirectoryHandle('.azure'))
  .getDirectoryHandle('dev')).getFileHandle('.env');
const envBytes = new Uint8Array(await (await envHandle.getFile()).arrayBuffer());
const envText = new TextDecoder().decode(envBytes);
assert.match(envText, /^SECRET=never-read\r\n/);
assert.match(envText, /\r\nAFTER_SECRET=also-never-read\r\n$/);
assert.equal((envText.match(/AZURE_SUBSCRIPTION_ID/g) || []).length, 1);
await assert.rejects(
  () => provider.writeSubscriptionId(
    'dev',
    '33333333-3333-3333-3333-333333333333',
    subscription.hash
  ),
  /changed outside/
);

const source = await provider.read('bicep/infra/main.bicepparam');
const replacement = new TextEncoder().encode(source.text.replace('Developer', 'Basic'));
const written = await provider.write('bicep/infra/main.bicepparam', replacement, {
  expectedHash: source.hash,
  finalHash: await sha256(replacement),
});
assert.match(written.text, /Basic/);
await assert.rejects(
  () => provider.write('bicep/infra/main.bicepparam', replacement, { expectedHash: source.hash }),
  /File changed outside Citadel UI\. Reload before saving\./
);

const beforeDiscovery = trace.length;
const catalog = await discoverWorkspace(provider);
const discoveryTrace = trace.slice(beforeDiscovery);
assert.equal(catalog.compatibility, 'degraded');
assert.equal(catalog.capabilities.main, null);
assert.equal(catalog.capabilities.llmOnboarding, null);
assert(catalog.missingCapabilities.includes('bicep/infra/main.bicepparam'));
assert(catalog.missingCapabilities.includes('bicep/infra/llm-backend-onboarding/main.bicepparam'));
const incompleteMain = catalog.files.find((file) => file.path === 'bicep/infra/main.bicepparam');
assert.equal(incompleteMain.capability, 'generic');
assert.equal(incompleteMain.envVarCount, 0);
assert.equal(incompleteMain.expressions[0].default, 'local-apim');
assert.equal(
  discoveryTrace.some((entry) => entry.includes('.azure/')),
  false,
  'discovery entered .azure'
);
assert.equal(
  discoveryTrace.some((entry) => entry.includes('.env')),
  false,
  'discovery opened .env'
);

const environments = ['dev-checkout', 'quality-gate', 'release-tree'];
for (const folder of environments) {
  const localTrace = [];
  const attached = new BrowserDirectoryProvider(fixture(folder, localTrace));
  assert.equal((await discoverWorkspace(attached)).compatibility, 'degraded');
  assert.equal(localTrace.some((entry) => entry.includes('.azure/')), false);
}

const screenshotMain = [
  "using 'main.bicep'",
  "param environmentName = 'qa'",
  "param location = 'eastus'",
  "param resourceGroupName = 'rg'",
  "param apimServiceName = 'apim'",
  "param vnetName = 'vnet'",
  "param apimSku = 'Developer'",
  'param apimSkuUnits = 1',
  'param aiSearchInstances = []',
  'param aiFoundryInstances = []',
  "param entraTenantId = 'tenant'",
  "param entraClientId = 'client'",
].join('\n');
const completeLlm = [
  'param apim = {}',
  'param apimManagedIdentity = {}',
  'param llmBackendConfig = []',
  'param configureCircuitBreaker = false',
  'param circuitBreakerDefaults = {}',
  'param configureSessionAffinity = false',
  'param sessionAffinityDefaults = {}',
  'param modelAliases = {}',
].join('\n');
const completeAccess = [
  "param apim = {}",
  'param useTargetAzureKeyVault = false',
  'param keyVault = {}',
  "param useCase = 'qa'",
  'param apiNameMapping = {}',
  'param services = []',
  "param productTerms = ''",
  'param useTargetFoundry = false',
  "param policyXml = loadTextContent('policies/default-ai-product-policy.xml')",
  ...Array.from({ length: 8 }, (_, index) => `param complete${index + 1} = ''`),
].join('\n');
const screenshotFixture = new BrowserDirectoryProvider(
  new MockDirectoryHandle('screenshot-fixture', {
    bicep: {
      infra: {
        'main.bicepparam': screenshotMain,
        'llm-backend-onboarding': { 'main.bicepparam': completeLlm },
        'citadel-access-contracts': {
          'main.bicepparam': completeAccess,
          policies: {
            'default-ai-product-policy.xml': '<policies><inbound /></policies>',
          },
        },
      },
    },
  }, [])
);
const screenshotCatalog = await discoverWorkspace(screenshotFixture);
assert.equal(screenshotCatalog.compatibility, 'degraded');
assert.equal(screenshotCatalog.capabilities.main, null);
assert.equal(screenshotCatalog.capabilities.llmOnboarding, 'bicep/infra/llm-backend-onboarding/main.bicepparam');
assert.equal(screenshotCatalog.capabilities.accessContracts.length, 1);
assert.throws(
  () => assertSupportedScan({ compatibility: screenshotCatalog.compatibility, catalog: screenshotCatalog }),
  /Missing primary editor capabilities/
);

const deniedHandle = fixture('denied', []);
deniedHandle.queryPermission = async () => 'denied';
deniedHandle.requestPermission = async () => 'denied';
await assert.rejects(
  () => new BrowserDirectoryProvider(deniedHandle).assertWritable({ request: true }),
  /permission is required/
);

const oversized = new BrowserDirectoryProvider(
  new MockDirectoryHandle('oversized', {
    'main.bicepparam': 'x'.repeat(8 * 1024 * 1024 + 1),
  }, [])
);
await assert.rejects(() => oversized.read('main.bicepparam'), /8 MiB/);

{
  const templateParam = await readFile(
    new URL('../../bicep/infra/citadel-access-contracts/main.bicepparam', import.meta.url),
    'utf8'
  );
  const templatePolicy = await readFile(
    new URL(
      '../../bicep/infra/citadel-access-contracts/policies/default-ai-product-policy.xml',
      import.meta.url
    ),
    'utf8'
  );
  const root = new MockDirectoryHandle('contract-create', {
    bicep: {
      infra: {
        'citadel-access-contracts': {
          'main.bicepparam': templateParam,
          policies: { 'default-ai-product-policy.xml': templatePolicy },
          contracts: {},
        },
      },
    },
  }, []);
  const contractProvider = new BrowserDirectoryProvider(root);
  assert.deepEqual(
    await contractProvider.missingDirectories(
      'bicep/infra/citadel-access-contracts/contracts/qa-alpha/main.bicepparam'
    ),
    ['bicep/infra/citadel-access-contracts/contracts/qa-alpha']
  );
  const workspace = new WorkspaceService({
    contextProvider: () => ({
      projectId: 'project',
      environment: { id: 'isolated', label: 'Isolated' },
      provider: contractProvider,
    }),
    commitFiles: async (files) => {
      for (const file of files) {
        await contractProvider.write(file.alias, file.after, {
          create: true,
          expectedHash: null,
          finalHash: await sha256(file.after),
        });
      }
      return {
        transactionId: 'contract-create',
        files: await Promise.all(
          files.map(async (file) => ({ alias: file.alias, hash: await sha256(file.after) }))
        ),
      };
    },
  });
  const createdContract = await workspace.createContract({ name: 'qa-alpha' });
  const parameter = await contractProvider.read(`${createdContract.dir}/main.bicepparam`);
  assert.match(
    parameter.text,
    /policyXml:\s*loadTextContent\('\.\/ai-product-policy\.xml'\)/
  );
  const listing = await workspace.contracts();
  const listed = listing.contracts.find((entry) => entry.id === 'contracts/qa-alpha');
  assert.equal(listed.hasPolicy, true);
  const reloaded = await workspace.contract('contracts/qa-alpha');
  assert.equal(reloaded.hasPolicy, true);
  assert.equal(reloaded.policy.path, `${createdContract.dir}/ai-product-policy.xml`);
}

{
  const root = new MockDirectoryHandle('undo', {
    bicep: {
      infra: {
        'citadel-access-contracts': {
          contracts: {
            'qa-alpha': {
              'main.bicepparam': 'created',
              'ai-product-policy.xml': '<policies />',
            },
            unrelated: { 'keep.xml': '<keep />' },
          },
        },
      },
    },
  }, []);
  const cleanupProvider = new BrowserDirectoryProvider(root);
  const source = await cleanupProvider.read(
    'bicep/infra/citadel-access-contracts/contracts/qa-alpha/main.bicepparam'
  );
  await assert.rejects(
    () =>
      cleanupProvider.remove(source.alias, {
        expectedHash: source.hash,
        pruneEmptyTo: 'bicep/infra/another-root',
      }),
    /cleanup boundary/
  );
  assert.equal((await cleanupProvider.read(source.alias)).text, 'created');
  await cleanupProvider.remove(source.alias, {
    expectedHash: source.hash,
    pruneEmptyTo: 'bicep/infra/citadel-access-contracts/contracts',
  });
  assert.ok(
    await cleanupProvider.read(
      'bicep/infra/citadel-access-contracts/contracts/qa-alpha/ai-product-policy.xml'
    )
  );
  const policy = await cleanupProvider.read(
    'bicep/infra/citadel-access-contracts/contracts/qa-alpha/ai-product-policy.xml'
  );
  await cleanupProvider.remove(policy.alias, {
    expectedHash: policy.hash,
    pruneEmptyTo: 'bicep/infra/citadel-access-contracts/contracts',
  });
  await assert.rejects(
    () =>
      cleanupProvider.read(
        'bicep/infra/citadel-access-contracts/contracts/qa-alpha/ai-product-policy.xml'
      ),
    { name: 'NotFoundError' }
  );
  assert.equal(
    (
      await cleanupProvider.read(
        'bicep/infra/citadel-access-contracts/contracts/unrelated/keep.xml'
      )
    ).text,
    '<keep />'
  );
}

{
  const root = new MockDirectoryHandle('exact-undo', {
    bicep: {
      infra: {
        'citadel-access-contracts': {
          contracts: {
            'qa-alpha': {
              'main.bicepparam': 'created',
              'ai-product-policy.xml': '<policies />',
            },
          },
        },
      },
    },
  }, []);
  const cleanupProvider = new BrowserDirectoryProvider(root);
  const base = 'bicep/infra/citadel-access-contracts/contracts/qa-alpha';
  const cleanupDirectories = [
    'bicep/infra/citadel-access-contracts/contracts',
    base,
  ];
  for (const alias of [`${base}/main.bicepparam`, `${base}/ai-product-policy.xml`]) {
    const source = await cleanupProvider.read(alias);
    await cleanupProvider.remove(alias, {
      expectedHash: source.hash,
      removeEmptyDirectories: cleanupDirectories,
    });
  }
  const accessRoot = await root
    .getDirectoryHandle('bicep')
    .then((handle) => handle.getDirectoryHandle('infra'))
    .then((handle) => handle.getDirectoryHandle('citadel-access-contracts'));
  await assert.rejects(
    () => accessRoot.getDirectoryHandle('contracts'),
    { name: 'NotFoundError' }
  );
}

console.log('browser provider: incomplete primary fixtures rejected; forbidden source access: 0');
