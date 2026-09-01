import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { TransactionStore } from '../server/transactions.mjs';
import { assertBalancedXml } from '../shared/policy.mjs';
import { createTransactionCommit } from '../web/js/transaction-client.mjs';
import { WorkspaceService } from '../web/js/workspace-service.mjs';

globalThis.crypto ||= webcrypto;

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = resolve(process.env.CITADEL_QA_SOURCE_ROOT || join(here, '..', '..'));
const SOURCE_EXTENSIONS = new Set(['.bicep', '.bicepparam', '.xml']);
const SKIP = new Set(['.git', '.azure', 'CitadelUI']);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function safePath(root, alias) {
  const path = resolve(root, ...String(alias).split('/'));
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Unsafe alias.');
  return path;
}

class IsolatedCopyProvider {
  constructor(root) {
    this.root = root;
  }

  async entries() {
    const found = [];
    const walk = async (directory, prefix = '') => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
        const alias = prefix ? `${prefix}/${entry.name}` : entry.name;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path, alias);
        else if (
          entry.isFile() &&
          SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase())
        ) {
          found.push({ alias, kind: entry.name.split('.').at(-1) });
        }
      }
    };
    await walk(this.root);
    return found.sort((left, right) => left.alias.localeCompare(right.alias));
  }

  async read(alias) {
    const path = safePath(this.root, alias);
    let bytes;
    let info;
    try {
      [bytes, info] = await Promise.all([readFile(path), stat(path)]);
    } catch (error) {
      if (error.code === 'ENOENT') throw new DOMException('Not found', 'NotFoundError');
      throw error;
    }
    return {
      alias,
      bytes: new Uint8Array(bytes),
      text: bytes.toString('utf8'),
      size: bytes.length,
      hash: digest(bytes),
      lastModified: info.mtimeMs,
    };
  }

  async write(alias, value, options = {}) {
    const path = safePath(this.root, alias);
    let current = null;
    try {
      current = await this.read(alias);
    } catch (error) {
      if (error.name !== 'NotFoundError') throw error;
    }
    assert.equal(current?.hash ?? null, options.expectedHash);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value);
    const verified = await this.read(alias);
    assert.equal(verified.hash, options.finalHash);
    return verified;
  }

  async missingDirectories(alias) {
    safePath(this.root, alias);
    const parts = alias.split('/');
    parts.pop();
    const missing = [];
    for (let index = 0; index < parts.length; index += 1) {
      try {
        const info = await stat(safePath(this.root, parts.slice(0, index + 1).join('/')));
        if (!info.isDirectory()) throw new Error('Source parent is not a directory.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        for (let missingIndex = index; missingIndex < parts.length; missingIndex += 1) {
          missing.push(parts.slice(0, missingIndex + 1).join('/'));
        }
        break;
      }
    }
    return missing;
  }

  async remove(alias, options = {}) {
    const current = await this.read(alias);
    assert.equal(current.hash, options.expectedHash);
    const path = safePath(this.root, alias);
    await rm(path);
    if (options.pruneEmptyTo) {
      const boundary = safePath(this.root, options.pruneEmptyTo);
      let directory = dirname(path);
      while (directory !== boundary && directory.startsWith(`${boundary}${sep}`)) {
        if ((await readdir(directory)).length) break;
        await rmdir(directory);
        directory = dirname(directory);
      }
    }
    for (const candidate of [...new Set(options.removeEmptyDirectories || [])].sort(
      (left, right) => right.split('/').length - left.split('/').length
    )) {
      if (!alias.startsWith(`${candidate}/`)) {
        throw new Error('Directory cleanup alias does not contain the removed source.');
      }
      try {
        await rmdir(safePath(this.root, candidate));
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
      }
    }
  }
}

async function manifest(root) {
  const rows = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        rows.push({
          path: relative(root, path).replaceAll('\\', '/'),
          size: bytes.length,
          hash: digest(bytes),
        });
      }
    }
  };
  await walk(root);
  return rows.sort((left, right) => left.path.localeCompare(right.path));
}

function storeRequest(store) {
  return async (path, options = {}) => {
    const route = path.split('?', 1)[0];
    const parts = route.split('/').filter(Boolean);
    const body =
      typeof options.body === 'string' && options.body
        ? JSON.parse(options.body)
        : options.body;
    const environmentId =
      options.headers?.['X-Citadel-Environment'] ||
      new URL(`http://isolated${path}`).searchParams.get('environmentId');
    if (route === '/api/transactions/prepare') return store.prepare(body);
    if (route === '/api/transactions') {
      return { transactions: await store.history(environmentId) };
    }
    const transactionId = parts[2];
    const action = parts[3];
    const transactionToken = options.headers?.['X-Citadel-Transaction'];
    const authorizationToken = options.headers?.['X-Citadel-Authorization'];
    if (parts.length === 3) {
      return { transaction: await store.getTransaction(environmentId, transactionId) };
    }
    if (action === 'backups' && options.method === 'PUT') {
      return store.uploadBackup(
        environmentId,
        transactionId,
        parts[4],
        transactionToken,
        options.headers['X-Citadel-Content-SHA256'],
        Buffer.from(body)
      );
    }
    if (action === 'backups') {
      const backup = options.headers?.['X-Citadel-Backup-Read']
        ? await store.getBackupForRestore(
            environmentId,
            transactionId,
            parts[4],
            options.headers['X-Citadel-Backup-Read']
          )
        : await store.getBackup(
            environmentId,
            transactionId,
            parts[4],
            transactionToken
          );
      return { bytes: new Uint8Array(backup.bytes), hash: backup.metadata.hash };
    }
    if (action === 'authorize') {
      return store.authorize(environmentId, transactionId, transactionToken);
    }
    if (action === 'committing') {
      return store.beginCommit(
        environmentId,
        transactionId,
        authorizationToken,
        body
      );
    }
    if (action === 'receipt') {
      return store.commitReceipt(
        environmentId,
        transactionId,
        authorizationToken,
        body
      );
    }
    if (action === 'fail') {
      return store.fail(environmentId, transactionId, transactionToken, body);
    }
    if (action === 'rollback') {
      return store.rollback(environmentId, transactionId, transactionToken, body);
    }
    if (action === 'restore-token') {
      return store.issueRestoreToken(environmentId, transactionId);
    }
    if (action === 'revert') return store.beginRevert(environmentId, transactionId);
    if (action === 'recover') return store.recover(environmentId, transactionId);
    throw new Error(`Unsupported isolated request: ${options.method || 'GET'} ${path}`);
  };
}

test('isolated source copy completes the three-contract save, reload, History, and undo lifecycle', async (t) => {
  await stat(SOURCE_ROOT);
  const root = await mkdtemp(join(tmpdir(), 'citadel-contract-lifecycle-'));
  const copyRoot = join(root, 'production-copy');
  const dataRoot = join(root, 'transaction-data');
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(SOURCE_ROOT, copyRoot, {
    recursive: true,
    filter(path) {
      const name = path.split(/[\\/]/).at(-1);
      return !SKIP.has(name) && name !== '.env' && !name.startsWith('.env.');
    },
  });
  const baseline = await manifest(copyRoot);
  const provider = new IsolatedCopyProvider(copyRoot);
  const store = new TransactionStore({ dataRoot });
  await store.initialize();
  const request = storeRequest(store);
  const context = {
    projectId: 'isolated-production-copy',
    environment: { id: 'isolated-prod', label: 'Isolated Production copy' },
    provider,
  };
  const commitFiles = createTransactionCommit(request);
  const workspace = new WorkspaceService({
    request,
    commitFiles: (files, options) =>
      commitFiles(files, { ...options, context }),
    contextProvider: () => context,
  });

  const names = ['qa-alpha', 'qa-beta', 'qa-gamma'];
  for (const name of names) await workspace.createContract({ name });
  const parameterTransactions = [];
  for (const [index, name] of names.entries()) {
    const contract = await workspace.contract(`contracts/${name}`);
    const suffix = index + 1;
    const saved = await workspace.save(
      contract.param.path,
      [
        {
          op: 'set',
          path: ['apim'],
          value: {
            subscriptionId: '11111111-1111-1111-1111-111111111111',
            resourceGroupName: `rg-qa-apim-${suffix}`,
            name: `apim-qa-${suffix}`,
          },
        },
        { op: 'set', path: ['useTargetAzureKeyVault'], value: true },
        {
          op: 'set',
          path: ['keyVault'],
          value: {
            subscriptionId: '11111111-1111-1111-1111-111111111111',
            resourceGroupName: `rg-qa-kv-${suffix}`,
            name: `kv-qa-${suffix}`,
          },
        },
        {
          op: 'set',
          path: ['useCase'],
          value: {
            businessUnit: 'Quality',
            useCaseName: `Contract${suffix}`,
            environment: 'QA',
          },
        },
        {
          op: 'set',
          path: ['apiNameMapping'],
          value: {
            LLM: ['universal-llm-api', 'azure-openai-api'],
            TOOL: ['qa-tool-api'],
          },
        },
        {
          op: 'set',
          path: ['services'],
          value: [
            {
              code: 'LLM',
              endpointSecretName: `QA_LLM_ENDPOINT_${suffix}`,
              apiKeySecretName: `QA_LLM_KEY_${suffix}`,
              policyXml: {
                __expr: 'call',
                raw: "loadTextContent('./ai-product-policy.xml')",
              },
            },
            {
              code: 'TOOL',
              endpointSecretName: `QA_TOOL_ENDPOINT_${suffix}`,
              apiKeySecretName: `QA_TOOL_KEY_${suffix}`,
              policyXml: '',
            },
          ],
        },
        { op: 'set', path: ['productTerms'], value: `qa-terms-${suffix}` },
        { op: 'set', path: ['useTargetFoundry'], value: true },
        {
          op: 'set',
          path: ['foundry'],
          value: {
            subscriptionId: '11111111-1111-1111-1111-111111111111',
            resourceGroupName: `rg-qa-foundry-${suffix}`,
            accountName: `foundry-qa-${suffix}`,
            projectName: `project-qa-${suffix}`,
          },
        },
        {
          op: 'set',
          path: ['foundryConfig', 'staticModels'],
          value: ['gpt-4.1', 'gpt-4o'],
        },
        { op: 'set', path: ['globalGatewayUrl'], value: `https://qa-${suffix}.example.test` },
        {
          op: 'set',
          path: ['additionalApimGateways'],
          value: [{
            subscriptionId: '22222222-2222-2222-2222-222222222222',
            resourceGroupName: `rg-qa-apim-secondary-${suffix}`,
            name: `apim-qa-secondary-${suffix}`,
          }],
        },
        {
          op: 'set',
          path: ['additionalKeyVaults'],
          value: [{
            subscriptionId: '22222222-2222-2222-2222-222222222222',
            resourceGroupName: `rg-qa-kv-secondary-${suffix}`,
            name: `kv-qa-secondary-${suffix}`,
            endpointSource: 'secondary:0',
          }],
        },
        {
          op: 'set',
          path: ['additionalFoundries'],
          value: [{
            subscriptionId: '22222222-2222-2222-2222-222222222222',
            resourceGroupName: `rg-qa-foundry-secondary-${suffix}`,
            accountName: `foundry-qa-secondary-${suffix}`,
            projectName: `project-qa-secondary-${suffix}`,
            endpointSource: 'global',
          }],
        },
      ],
      contract.param.hash
    );
    parameterTransactions.push(saved.archived);
    const reloaded = await workspace.contract(`contracts/${name}`);
    assert.equal(reloaded.param.params.find((entry) => entry.name === 'services').value.length, 2);
    assert.equal(
      reloaded.param.params
        .find((entry) => entry.name === 'services')
        .value[0].policyXml.raw,
      "loadTextContent('./ai-product-policy.xml')"
    );
  }

  let alpha = await workspace.contract('contracts/qa-alpha');
  assert.equal(alpha.hasPolicy, true);
  assert.match(
    alpha.param.text,
    /policyXml:\s*loadTextContent\('\.\/ai-product-policy\.xml'\)/
  );
  const guided = await workspace.savePolicy({
    path: alpha.policy.path,
    expectedHash: alpha.policy.hash,
    changes: {
      allowedModels: 'gpt-4.1,gpt-4o',
      responseHeaders: false,
      semanticCache: {
        enable: true,
        lookup: {
          'score-threshold': '0.19',
          'embeddings-backend-id': 'embeddings-isolated',
          'embeddings-backend-auth': 'system-assigned',
          'ignore-system-messages': 'false',
          'max-message-count': '12',
        },
        store: { duration: '600' },
        varyBy: { 0: '@(context.Request.IpAddress)' },
      },
      tokenLimits: {
        addModel: 'gpt-4o',
        perModel: {
          'gpt-4o': {
            'tokens-per-minute': '4500',
            'tokens-consumed-header-name': 'x-token-used',
          },
        },
        universal: {
          'tokens-per-minute': '9000',
          'remaining-tokens-header-name': 'x-token-remaining',
        },
      },
      rateLimit: {
        enable: true,
        attributes: {
          calls: '42',
          'renewal-period': '120',
          'counter-key': '@(context.Subscription.Id + ":rate")',
          'increment-condition': '@(context.Response.StatusCode >= 400)',
          'increment-count': '2',
          'retry-after-header-name': 'x-retry',
          'remaining-calls-header-name': 'x-rate-remaining',
          'total-calls-header-name': 'x-rate-total',
        },
      },
      rateLimits: {
        addModel: 'gpt-4o',
        perModel: {
          'gpt-4o': {
            calls: '21',
            'renewal-period': '30',
            'counter-key': '@(context.Subscription.Id + ":rate:model")',
          },
        },
      },
      callQuota: {
        enable: true,
        attributes: {
          calls: '42000',
          bandwidth: '2048',
          'renewal-period': '3600',
          'counter-key': '@(context.Subscription.Id + ":quota")',
          'first-period-start': '2026-01-01T00:00:00Z',
          'increment-condition': '@(context.Response.StatusCode < 400)',
          'increment-count': '3',
        },
      },
      quotaLimits: {
        addModel: 'gpt-4o',
        perModel: {
          'gpt-4o': {
            calls: '21000',
            'renewal-period': '7200',
            'counter-key': '@(context.Subscription.Id + ":quota:model")',
          },
        },
      },
      contentSafety: {
        enable: true,
        attributes: {
          'backend-id': 'qa-content-safety',
          'shield-prompt': 'false',
          'enforce-on-completions': 'true',
          'window-size': '1200',
          'window-overlap-size': '120',
        },
        categories: { Hate: '1', SelfHarm: '2', Sexual: '3', Violence: '4' },
        outputType: 'EightSeverityLevels',
        addBlocklist: 'qa-blocklist',
      },
      variables: {
        jwtRequired: true,
        jwtAudience: 'api://qa-contract',
        jwtIssuer: 'https://login.microsoftonline.com/qa/v2.0',
        jwtOpenIdConfigUrl:
          'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration',
        requiredRoles: 'Contract.Invoke,Contract.Admin',
        piiAnonymizationEnabled: true,
        piiBlockingEnabled: true,
        piiStateSavingEnabled: true,
        piiConfidenceThreshold: '0.82',
        piiDetectionLanguage: 'en',
        piiEntityCategoryExclusions: 'PersonType',
        alertOnThrottling: true,
        alertOnAuthFailure: true,
        alertOnContentSafety: true,
        alertOnPiiFailure: true,
      },
    },
  });
  alpha = await workspace.contract('contracts/qa-alpha');
  const controls = alpha.policy.controls;
  assert.equal(controls.semanticCache.lookup.attributes['max-message-count'].value, '12');
  assert.equal(controls.semanticCache.store.attributes.duration.value, '600');
  assert.equal(controls.rateLimits.perModel[0].attributes.calls.value, '21');
  assert.equal(controls.rateLimits.universal.attributes.calls.value, '42');
  assert.equal(controls.rateLimit.enabled, true);
  assert.equal(
    controls.rateLimits.universal.attributes['increment-condition'].value,
    '@(context.Response.StatusCode >= 400)'
  );
  assert.equal(controls.quotaLimits.perModel[0].attributes.calls.value, '21000');
  assert.equal(controls.quotaLimits.universal.attributes.calls.value, '42000');
  assert.deepEqual(controls.allowedModels.models, ['gpt-4.1', 'gpt-4o']);
  assert.equal(controls.contentSafety.attributes['backend-id'].value, 'qa-content-safety');
  assert.equal(controls.variables.jwtRequired.value, 'true');
  assert.equal(controls.variables.piiConfidenceThreshold.value, '0.82');
  assert.equal(controls.variables.alertOnContentSafety.value, 'true');
  assert.equal(controls.responseHeaders.value, false);
  assertBalancedXml(alpha.policy.text);

  const conditionPreview = await workspace.previewPolicy(
    alpha.policy.path,
    {
      rateLimits: {
        universal: {
          'increment-condition':
            '@(context.Response.StatusCode >= 400 && context.Response.Headers.GetValueOrDefault("x-result", "") == "billable")',
        },
      },
    },
    null,
    alpha.policy.hash
  );
  assert.equal(conditionPreview.controls.rateLimit.enabled, true);
  assert.equal(
    conditionPreview.controls.rateLimits.universal.attributes['increment-condition'].value,
    '@(context.Response.StatusCode >= 400 &amp;&amp; context.Response.Headers.GetValueOrDefault(&quot;x-result&quot;, &quot;&quot;) == &quot;billable&quot;)'
  );

  const rawText = alpha.policy.text.replace(
    '</inbound>',
    '        <include-fragment fragment-id="qa-contract-audit" />\n    </inbound>'
  );
  const raw = await workspace.savePolicy({
    path: alpha.policy.path,
    expectedHash: alpha.policy.hash,
    text: rawText,
  });
  alpha = await workspace.contract('contracts/qa-alpha');
  assert.ok(alpha.policy.controls.fragments.includes('qa-contract-audit'));
  assertBalancedXml(alpha.policy.text);

  await workspace.restoreTransaction(raw.archived);
  await workspace.restoreTransaction(guided.archived);
  for (const transactionId of [...parameterTransactions].reverse()) {
    await workspace.restoreTransaction(transactionId);
  }

  const history = (await workspace.history()).transactions;
  const creations = history.filter(
    (transaction) =>
      transaction.targetLabel === 'contract-create' &&
      transaction.status === 'committed'
  );
  assert.equal(creations.length, 3);
  for (const creation of creations) {
    await workspace.restoreTransaction(creation.transactionId);
  }
  assert.deepEqual(await manifest(copyRoot), baseline);

  const audit = (
    await readFile(join(dataRoot, 'environments', 'isolated-prod', 'audit.jsonl'), 'utf8')
  )
    .trim()
    .split('\n')
    .map(JSON.parse);
  for (let index = 1; index < audit.length; index += 1) {
    assert.equal(audit[index].sequence, audit[index - 1].sequence + 1);
    assert.equal(audit[index].previousHash, audit[index - 1].hash);
  }
  assert.equal(
    JSON.stringify(audit).includes('qa-contract-audit'),
    false
  );
});
