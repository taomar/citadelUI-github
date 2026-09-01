import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

import { contractInfo, discoverWorkspace, documentFromText } from '../shared/citadel-core.mjs';
import { BrowserDirectoryProvider } from '../web/js/directory-provider.mjs';
import { previewDocument } from '../web/js/preview.mjs';
import { classifyValidation, validateDocument } from '../web/js/validation.mjs';
import { WorkspaceService } from '../web/js/workspace-service.mjs';

const FIXTURES = [
  {
    label: 'Development',
    root: 'C:\\Users\\taomar\\Downloads\\citadelui_repos\\dev\\ai-hub-gateway-solution-accelerator',
  },
  {
    label: 'Production',
    root: 'C:\\Users\\taomar\\Downloads\\citadelui_repos\\prod\\ai-hub-gateway-solution-accelerator',
  },
];

class ReadOnlyFileHandle {
  kind = 'file';

  constructor(path, fixtureRoot, trace) {
    this.path = path;
    this.fixtureRoot = fixtureRoot;
    this.trace = trace;
    this.name = basename(path);
  }

  async getFile() {
    this.trace.push(`read:${relative(this.fixtureRoot, this.path).replaceAll('\\', '/')}`);
    const [bytes, info] = await Promise.all([readFile(this.path), stat(this.path)]);
    return {
      size: bytes.length,
      lastModified: info.mtimeMs,
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  }
}

class ReadOnlyDirectoryHandle {
  kind = 'directory';

  constructor(path, fixtureRoot, trace) {
    this.path = path;
    this.fixtureRoot = fixtureRoot;
    this.trace = trace;
    this.name = basename(path);
  }

  async queryPermission() {
    return 'granted';
  }

  async *entries() {
    const alias = relative(this.fixtureRoot, this.path).replaceAll('\\', '/') || '.';
    this.trace.push(`entries:${alias}`);
    for (const entry of await readdir(this.path, { withFileTypes: true })) {
      const path = join(this.path, entry.name);
      if (entry.isDirectory()) {
        yield [entry.name, new ReadOnlyDirectoryHandle(path, this.fixtureRoot, this.trace)];
      } else if (entry.isFile()) {
        yield [entry.name, new ReadOnlyFileHandle(path, this.fixtureRoot, this.trace)];
      }
    }
  }

  async getDirectoryHandle(name) {
    const path = join(this.path, name);
    try {
      if (!(await stat(path)).isDirectory()) throw new Error('Not a directory');
    } catch {
      throw new DOMException('Not found', 'NotFoundError');
    }
    return new ReadOnlyDirectoryHandle(path, this.fixtureRoot, this.trace);
  }

  async getFileHandle(name) {
    const path = join(this.path, name);
    try {
      if (!(await stat(path)).isFile()) throw new Error('Not a file');
    } catch {
      throw new DOMException('Not found', 'NotFoundError');
    }
    return new ReadOnlyFileHandle(path, this.fixtureRoot, this.trace);
  }
}

for (const fixture of FIXTURES) {
  const trace = [];
  const provider = new BrowserDirectoryProvider(
    new ReadOnlyDirectoryHandle(fixture.root, fixture.root, trace)
  );
  const catalog = await discoverWorkspace(provider);
  assert.equal(
    catalog.compatibility,
    'supported',
    `${fixture.label}: ${catalog.missingCapabilities.join(', ')}`
  );
  const mainSource = await provider.read(catalog.capabilities.main);
  const main = documentFromText(catalog.capabilities.main, mainSource.text, mainSource);
  assert.equal(main.params.length, 97, `${fixture.label} Main`);
  const llmSource = await provider.read(catalog.capabilities.llmOnboarding);
  const llm = documentFromText(catalog.capabilities.llmOnboarding, llmSource.text, llmSource);
  const backends = llm.params.find((parameter) => parameter.name === 'llmBackendConfig').value;
  assert.equal(llm.params.length, 8, `${fixture.label} LLM params`);
  assert.equal(backends.length, 2, `${fixture.label} LLM backends`);
  assert.equal(
    backends.flatMap((backend) => backend.supportedModels || []).length,
    10,
    `${fixture.label} LLM models`
  );
  const aliases = new Set(catalog.sourceAliases);
  const contracts = catalog.files.map((file) => contractInfo(file, aliases)).filter(Boolean);
  const template = contracts.find((contract) => contract.id === '__template');
  assert(template, `${fixture.label}: access-contract template is missing`);
  for (const contract of contracts) {
    assert.equal(contract.paramCount, 17, `${fixture.label}: ${contract.id} parameter count`);
    assert.equal(contract.hasPolicy, true, `${fixture.label}: ${contract.id} policy pair`);
  }
  const service = new WorkspaceService({
    contextProvider: () => ({
      projectId: 'fixture-project',
      environment: { id: fixture.label.toLowerCase(), label: fixture.label },
      provider,
    }),
    request: async () => {
      throw new Error('Read-only primary editor checks must not call the container.');
    },
  });
  assert.deepEqual(
    (await service.focus()).areas.map((area) => area.title),
    ['Azure Deployment', 'LLM Onboarding', 'Access Contracts']
  );
  const mainResponse = await service.deployment('bicep/infra/main.bicepparam');
  assert.equal(
    mainResponse.outline.sections.reduce((count, section) => count + section.params.length, 0),
    97
  );
  const llmResponse = await service.deployment(
    'bicep/infra/llm-backend-onboarding/main.bicepparam'
  );
  const baselineValidation = validateDocument(llmResponse);
  assert(
    baselineValidation.some(
      (finding) => finding.param === 'apim' && finding.severity === 'warning'
    ),
    `${fixture.label}: placeholder APIM coordinates were not reported as a warning`
  );
  const editedLlm = previewDocument(llmResponse, [{
    op: 'set',
    path: ['configureCircuitBreaker'],
    value: !llmResponse.params.find(
      (parameter) => parameter.name === 'configureCircuitBreaker'
    ).value,
  }]);
  assert.equal(
    classifyValidation(
      validateDocument(editedLlm),
      baselineValidation,
      new Set(['configureCircuitBreaker'])
    ).filter((finding) => finding.severity === 'error').length,
    0,
    `${fixture.label}: unrelated LLM edit was blocked by baseline placeholders`
  );
  assert.equal(
    trace.some((entry) => entry.startsWith('entries:.azure') || entry.includes('/.azure')),
    false
  );
  assert.equal(trace.some((entry) => /read:.*(?:^|\/)\.env(?:\.|$)/.test(entry)), false);
  console.log(
    `${fixture.label}: main=97, llm=8/2/10, access=${contracts.length}, folder=${basename(fixture.root)}`
  );
}
