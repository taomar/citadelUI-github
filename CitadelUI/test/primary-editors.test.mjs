import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverWorkspace, documentFromText, contractInfo } from '../shared/citadel-core.mjs';
import { BrowserDirectoryProvider } from '../web/js/directory-provider.mjs';
import { WorkspaceService } from '../web/js/workspace-service.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const trace = [];

class NodeFileHandle {
  kind = 'file';

  constructor(path) {
    this.path = path;
    this.name = basename(path);
  }

  async getFile() {
    trace.push(`read:${relative(repositoryRoot, this.path).replaceAll('\\', '/')}`);
    const [bytes, info] = await Promise.all([readFile(this.path), stat(this.path)]);
    return {
      size: bytes.length,
      lastModified: info.mtimeMs,
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  }
}

class NodeDirectoryHandle {
  kind = 'directory';

  constructor(path) {
    this.path = path;
    this.name = basename(path);
  }

  async queryPermission() {
    return 'granted';
  }

  async *entries() {
    const alias = relative(repositoryRoot, this.path).replaceAll('\\', '/') || '.';
    trace.push(`entries:${alias}`);
    for (const entry of await readdir(this.path, { withFileTypes: true })) {
      const path = join(this.path, entry.name);
      if (entry.isDirectory()) yield [entry.name, new NodeDirectoryHandle(path)];
      else if (entry.isFile()) yield [entry.name, new NodeFileHandle(path)];
    }
  }

  async getDirectoryHandle(name) {
    const path = join(this.path, name);
    try {
      if (!(await stat(path)).isDirectory()) throw new Error('Not a directory');
    } catch {
      throw new DOMException('Not found', 'NotFoundError');
    }
    return new NodeDirectoryHandle(path);
  }

  async getFileHandle(name) {
    const path = join(this.path, name);
    try {
      if (!(await stat(path)).isFile()) throw new Error('Not a file');
    } catch {
      throw new DOMException('Not found', 'NotFoundError');
    }
    return new NodeFileHandle(path);
  }
}

const provider = new BrowserDirectoryProvider(new NodeDirectoryHandle(repositoryRoot));
const catalog = await discoverWorkspace(provider);
assert.equal(catalog.compatibility, 'supported', catalog.missingCapabilities.join(', '));
assert.equal(catalog.capabilities.main, 'bicep/infra/main.bicepparam');
assert.equal(
  catalog.capabilities.llmOnboarding,
  'bicep/infra/llm-backend-onboarding/main.bicepparam'
);

const mainSource = await provider.read(catalog.capabilities.main);
const main = documentFromText(catalog.capabilities.main, mainSource.text, mainSource);
assert.equal(main.params.length, 98);
for (const name of [
  'environmentName',
  'location',
  'apimSku',
  'apimSkuUnits',
  'aiFoundryInstances',
  'entraClientSecret',
]) {
  assert(main.params.some((parameter) => parameter.name === name), `missing main parameter ${name}`);
}
const mainMeta = catalog.files.find((file) => file.path === catalog.capabilities.main);
assert.equal(mainMeta.schema.available, true);
assert.equal(Object.keys(mainMeta.schema.parameters).length, 100);

const llmSource = await provider.read(catalog.capabilities.llmOnboarding);
const llm = documentFromText(catalog.capabilities.llmOnboarding, llmSource.text, llmSource);
assert.equal(llm.params.length, 8);
const llmBackends = llm.params.find((parameter) => parameter.name === 'llmBackendConfig').value;
assert.equal(llmBackends.length, 2);
assert.equal(llmBackends.flatMap((backend) => backend.supportedModels || []).length, 10);

const aliases = new Set(catalog.sourceAliases);
const contracts = catalog.files
  .map((file) => contractInfo(file, aliases))
  .filter(Boolean)
  .sort((left, right) => left.id.localeCompare(right.id));
assert.deepEqual(
  contracts.map((contract) => contract.id),
  [
    '__template',
    'contracts/acceptance-test',
    'contracts/billing-agent',
    'contracts/hr-chatagent',
    'contracts/op',
    'contracts/xyz',
  ]
);
const template = contracts.find((contract) => contract.id === '__template');
assert.equal(template.paramCount, 17);
assert.equal(template.hasPolicy, true);

const service = new WorkspaceService({
  contextProvider: () => ({
    projectId: 'real-checkout',
    environment: { id: 'real-checkout', label: 'Real checkout' },
    provider,
  }),
  request: async () => {
    throw new Error('Primary editor reads must not require a server content route.');
  },
  commitFiles: async () => {
    throw new Error('Primary editor contract tests are read-only.');
  },
});
const focus = await service.focus();
assert.deepEqual(
  focus.areas.map((area) => area.title),
  ['Azure Deployment', 'LLM Onboarding', 'Access Contracts']
);
const mainResponse = await service.deployment('bicep/infra/main.bicepparam');
assert.equal(mainResponse.params.length, 98);
assert.equal(
  mainResponse.outline.sections.reduce((count, section) => count + section.params.length, 0),
  98
);
for (const key of ['path', 'text', 'params', 'outline', 'meta', 'schema']) {
  assert.notEqual(mainResponse[key], undefined, `main response omitted ${key}`);
}
const modelResponse = await service.onboardedModels();
assert(modelResponse.models.length > 0, 'model catalogue response is empty');
const contractResponse = await service.contracts();
assert.equal(contractResponse.contracts.length, 6);
const templateResponse = await service.contract('__template');
assert.equal(templateResponse.param.params.length, 17);
assert.equal(templateResponse.policy.path, template.policyFile);
assert(templateResponse.policy.controls, 'policy controls were not parsed');
const paramViewSource = await readFile(
  fileURLToPath(new URL('../web/js/paramview.mjs', import.meta.url)),
  'utf8'
);
assert.match(paramViewSource, /param\.name === 'llmBackendConfig'/);
assert.match(paramViewSource, /renderLlmBackends\(param\.value/);

assert.equal(
  trace.some((entry) => entry.startsWith('entries:.azure') || entry.includes('/.azure')),
  false,
  'provider descended into .azure'
);
assert.equal(
  trace.some((entry) => /read:.*(?:^|\/)\.env(?:\.|$)/.test(entry)),
  false,
  'provider read an environment file'
);

console.log(
  `primary editors: main=${main.params.length}, llm=${llm.params.length}/${llmBackends.length}/10, contracts=${contracts.length}`
);
