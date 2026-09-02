import {
  contractInfo,
  discoverWorkspace,
  documentFromText,
  previewDocumentText,
  relativeAlias,
  resolveAlias,
} from '../../shared/citadel-core.mjs';
import { activeWorkspace, workspaceRegistry } from './workspace-context.mjs';
import { LocalTransactionCoordinator } from './mutation-coordinator.mjs';
import { createProvider } from './source-factory.mjs';
import {
  applyPolicyChanges,
  assertBalancedXml,
  CONTENT_SAFETY_CATEGORIES,
  CONTENT_SAFETY_OUTPUT_TYPES,
  POLICY_VARIABLES,
  readPolicyControls,
  SEMANTIC_CACHE_SPEC,
  THROTTLE_SPECS,
} from '../../shared/policy.mjs';

const TEMPLATE_ID = '__template';
const CONTRACT_POLICY_NAME = 'ai-product-policy.xml';
export const STALE_SOURCE_MESSAGE = 'File changed outside Citadel UI. Reload before saving.';

function assertLoadedHash(source, expectedHash) {
  if (typeof expectedHash !== 'string' || source.hash !== expectedHash) {
    throw new Error(STALE_SOURCE_MESSAGE);
  }
}

function values(document) {
  return new Map((document.params || []).map((parameter) => [parameter.name, parameter.value]));
}

function evaluate(value) {
  if (Array.isArray(value)) return value.map(evaluate);
  if (!value || typeof value !== 'object') return value;
  if (value.__expr === 'call') {
    if (value.callee === 'readEnvironmentVariable') return evaluate(value.args?.[1] ?? '');
    if (value.callee === 'int') return Number(evaluate(value.args?.[0]));
    if (value.callee === 'bool') return evaluate(value.args?.[0]) === true || evaluate(value.args?.[0]) === 'true';
    if (value.callee === 'string') return String(evaluate(value.args?.[0]) ?? '');
    return '';
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, evaluate(entry)]));
}

function completeness(value, required) {
  const missing = required.filter((field) => !String(value[field] || '').trim());
  return { ready: missing.length === 0, missing, missingLocal: missing };
}

function accessTargets(mainDocument, onboardingDocument) {
  const main = values(mainDocument);
  const onboarding = values(onboardingDocument);
  const resourceGroupName = String(evaluate(main.get('resourceGroupName')) || '');
  const subscriptionId = String(
    (mainDocument.subscription?.valid ? mainDocument.subscription.value : '') ||
    evaluate(main.get('subscriptionId')) ||
    ''
  );
  const apim = {
    subscriptionId,
    resourceGroupName,
    name: String(evaluate(main.get('apimServiceName')) || ''),
  };
  Object.assign(apim, completeness(apim, ['subscriptionId', 'resourceGroupName', 'name']));
  const keyVault = {
    subscriptionId,
    resourceGroupName,
    name: String(evaluate(main.get('keyVaultName')) || ''),
  };
  Object.assign(keyVault, completeness(keyVault, ['subscriptionId', 'resourceGroupName', 'name']));
  const backends = (evaluate(onboarding.get('llmBackendConfig')) || [])
    .filter((entry) => entry?.backendType === 'ai-foundry')
    .map((entry) => ({
      backendId: entry.backendId || '',
      endpoint: entry.endpoint || '',
      models: (entry.supportedModels || []).map((model) => model?.name).filter(Boolean),
    }));
  const foundries = (evaluate(main.get('aiFoundryInstances')) || []).map((instance, index) => {
    const target = {
      index,
      subscriptionId,
      resourceGroupName,
      accountName: String(instance?.name || ''),
      projectName: String(instance?.defaultProjectName || ''),
      location: String(instance?.location || ''),
      provenance: backends.filter((backend) =>
        instance?.name && backend.endpoint.toLowerCase().includes(String(instance.name).toLowerCase())
      ),
    };
    return {
      ...target,
      ...completeness(target, ['subscriptionId', 'resourceGroupName', 'accountName', 'projectName']),
    };
  });
  return {
    environment: mainDocument.subscription?.environmentName || null,
    environmentFile: mainDocument.subscription?.source || null,
    apim,
    keyVault,
    foundries,
    partialFoundries: backends
      .filter((backend) => !foundries.some((target) => target.provenance.includes(backend)))
      .map((backend) => ({ ...backend, ready: false, missing: ['matching aiFoundryInstances entry'] })),
  };
}

export function rewriteContractTemplate(text, usingPath) {
  let output = text.replace(
    /^(\s*using\s+)(['"])([^'"]+)\2/m,
    (_match, prefix, quote) => `${prefix}${quote}${usingPath}${quote}`
  );
  const comments = [...output.matchAll(/\/\/[^\r\n]*/g)].map((match) => [
    match.index,
    match.index + match[0].length,
  ]);
  const policy = /\bpolicyXml\s*:\s*(?:''|""|loadTextContent\((['"])[^'"]*\1\))/g;
  let match;
  while ((match = policy.exec(output))) {
    if (comments.some(([start, end]) => match.index >= start && match.index < end)) continue;
    const prefixLength = match[0].indexOf(':') + 1;
    output =
      output.slice(0, match.index + prefixLength) +
      ` loadTextContent('./${CONTRACT_POLICY_NAME}')` +
      output.slice(match.index + match[0].length);
    break;
  }
  return output;
}

export class WorkspaceService {
  constructor(options = {}) {
    this.request = options.request;
    this.contextProvider = options.contextProvider || activeWorkspace;
    this.registry = options.registry || workspaceRegistry;
    this.coordinator =
      options.coordinator ||
      new LocalTransactionCoordinator({
        request: options.request,
        commitFiles: options.commitFiles,
        contextProvider: () => this.context,
      });
    // Injected so the editor never constructs a source-specific provider itself.
    this.createProvider =
      options.createProvider ||
      ((environment) =>
        createProvider(environment, {
          getHandle: (id) => this.registry.getHandle(id),
        }));
    this.catalog = null;
  }

  get context() {
    return this.contextProvider();
  }

  get provider() {
    return this.context.provider;
  }

  commitFiles(files, options = {}) {
    return this.coordinator.commit(files, options);
  }

  reset() {
    this.catalog = null;
  }

  async health() {
    return {
      ok: true,
      repoRoot: null,
      environmentId: this.context.environment.id,
      schemaSource: 'selected-directory',
    };
  }

  async deployments(options = {}) {
    if (options.refresh) this.catalog = null;
    if (!this.catalog) {
      // Adopt the catalog the open path already produced for this exact
      // context, once. Opening scanned every parameter file and every template
      // to decide the workspace was usable at all; discarding that and doing it
      // again doubled the cost of opening a 170-file repository over the
      // network. The handoff is consumed rather than kept, so a later refresh —
      // after a save, an undo or an explicit reload — really does rescan.
      const handed = this.context.catalog || null;
      if (handed) this.context.catalog = null;
      this.catalog = handed || (await discoverWorkspace(this.provider));
    }
    return this.catalog;
  }

  async deployment(alias) {
    const catalog = await this.deployments();
    const meta = catalog.files.find((file) => file.path === alias);
    if (!meta) throw new Error(`Unknown source alias: ${alias}`);
    const source = await this.provider.read(alias);
    const document = documentFromText(alias, source.text, source);
    const result = { ...document, meta, schema: meta.schema };
    if (meta.capability === 'main') {
      const environmentName = String(
        evaluate(values(document).get('environmentName')) || ''
      ).trim();
      if (!environmentName) {
        result.subscription = {
          available: false,
          configured: false,
          environmentName: null,
          source: null,
          value: '',
          valid: false,
          hash: null,
          error: 'Set environmentName before reading the azd subscription.',
        };
      } else if (typeof this.provider.readSubscriptionId === 'function') {
        try {
          result.subscription = await this.provider.readSubscriptionId(environmentName);
        } catch (error) {
          result.subscription = {
            available: false,
            configured: false,
            environmentName,
            source: `.azure/${environmentName}/.env`,
            value: '',
            valid: false,
            hash: null,
            error: error.message,
          };
        }
      }
    }
    return result;
  }

  async saveSubscriptionId(environmentName, value, expectedHash) {
    if (typeof this.provider.writeSubscriptionId !== 'function') {
      throw new Error('Subscription environment editing is unavailable for this workspace.');
    }
    return this.provider.writeSubscriptionId(environmentName, value, expectedHash);
  }

  async focus() {
    const catalog = await this.deployments();
    const areas = [];
    if (catalog.capabilities.main) {
      areas.push({
        id: 'main',
        kind: 'param',
        title: 'Azure Deployment',
        subtitle: 'Core infrastructure parameters for the hub deployment',
        path: catalog.capabilities.main,
        blurb:
          'Names, networking, feature flags and SKUs for the AI Hub Gateway. readEnvironmentVariable expressions are edited only as Bicepparam syntax and fallbacks.',
      });
    }
    if (catalog.capabilities.llmOnboarding) {
      areas.push({
        id: 'llm-onboarding',
        kind: 'param',
        title: 'LLM Onboarding',
        subtitle: 'Register model backends behind the gateway',
        path: catalog.capabilities.llmOnboarding,
        blurb: 'Adds model providers and routing metadata to the selected Citadel repository.',
      });
    }
    if (catalog.capabilities.accessContracts.length) {
      areas.push({
        id: 'access-contracts',
        kind: 'contracts',
        title: 'Access Contracts',
        subtitle: 'Per-use-case products, subscriptions and policies',
        blurb: 'Each contract is a selected-repository parameter and policy pair.',
      });
    }
    return { areas };
  }

  async preview(alias, operations, expectedHash) {
    const source = await this.provider.read(alias);
    assertLoadedHash(source, expectedHash);
    const after = previewDocumentText(source.text, operations);
    return {
      path: alias,
      before: source.text,
      after,
      changed: source.text !== after,
      beforeHash: expectedHash,
    };
  }

  async save(alias, operations, expectedHash) {
    const source = await this.provider.read(alias);
    assertLoadedHash(source, expectedHash);
    const after = previewDocumentText(source.text, operations);
    if (after === source.text) return { path: alias, changed: false, archived: null };
    const result = await this.commitFiles([
      { alias, before: source.bytes, beforeHash: expectedHash, after: new TextEncoder().encode(after), changed: operations.map((operation) => operation.path?.[0]).filter(Boolean) },
    ], { action: 'parameter-edit' });
    this.catalog = null;
    return {
      path: alias,
      changed: true,
      archived: result.transactionId,
      hash: result.files[0].hash,
      // Anything the source could not confirm after the write landed. Never a
      // failure, so the caller reports it alongside a successful save.
      warnings: result.warnings || [],
      // Where the change went when the intended branch refused it.
      resolution: result.resolution || null,
    };
  }

  async onboardedModels() {
    const catalog = await this.deployments();
    if (!catalog.capabilities.llmOnboarding) return { models: [] };
    const document = await this.deployment(catalog.capabilities.llmOnboarding);
    const config = document.params.find((parameter) => parameter.name === 'llmBackendConfig')?.value || [];
    const seen = new Map();
    for (const entry of Array.isArray(config) ? config : []) {
      for (const model of entry?.supportedModels || []) {
        if (!model?.name) continue;
        const item = seen.get(model.name) || {
          name: model.name,
          backendType: entry.backendType || null,
          backends: [],
        };
        if (entry.backendId) item.backends.push(entry.backendId);
        seen.set(model.name, item);
      }
    }
    return { models: [...seen.values()].sort((left, right) => left.name.localeCompare(right.name)) };
  }

  async policyVariables() {
    return {
      variables: POLICY_VARIABLES,
      throttles: THROTTLE_SPECS,
      semanticCache: SEMANTIC_CACHE_SPEC,
      contentSafety: {
        categories: CONTENT_SAFETY_CATEGORIES,
        outputTypes: CONTENT_SAFETY_OUTPUT_TYPES,
      },
    };
  }

  async contracts() {
    const catalog = await this.deployments();
    const aliases = new Set(catalog.sourceAliases || catalog.files.map((file) => file.path));
    const contracts = catalog.files
      .map((file) => contractInfo(file, aliases))
      .filter(Boolean)
      .sort((left, right) => (left.isTemplate ? -1 : right.isTemplate ? 1 : left.id.localeCompare(right.id)));
    const template = contracts.find((contract) => contract.id === TEMPLATE_ID) || null;
    const root = template?.dir || contracts[0]?.dir.split('/').slice(0, -2).join('/') || '';
    return { root, parent: 'contracts', template, contracts, recoverable: [] };
  }

  async contract(id) {
    const listing = await this.contracts();
    const entry = listing.contracts.find((contract) => contract.id === id);
    if (!entry) throw new Error(`Unknown access contract: ${id}`);
    const param = await this.deployment(entry.paramFile);
    let policy = null;
    if (entry.hasPolicy) {
      const source = await this.provider.read(entry.policyFile);
      policy = {
        path: entry.policyFile,
        name: entry.policyFile.split('/').at(-1),
        text: source.text,
        hash: source.hash,
        mtimeMs: source.lastModified,
        controls: readPolicyControls(source.text),
      };
    }
    return { ...entry, param, policy };
  }

  async accessContractTargets() {
    const catalog = await this.deployments();
    if (!catalog.capabilities.main || !catalog.capabilities.llmOnboarding) {
      return { environment: null, environmentFile: null, apim: {}, keyVault: {}, foundries: [], partialFoundries: [] };
    }
    const [main, onboarding] = await Promise.all([
      this.deployment(catalog.capabilities.main),
      this.deployment(catalog.capabilities.llmOnboarding),
    ]);
    return accessTargets(main, onboarding);
  }

  async createContract({ name }) {
    const clean = String(name || '').trim().toLowerCase();
    if (!/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/.test(clean)) {
      throw new Error('Use lowercase letters, numbers and hyphens.');
    }
    const listing = await this.contracts();
    const template = listing.template;
    if (!template?.policyFile) throw new Error('The selected repository has no complete access-contract template pair.');
    const targetDir = `${template.dir}/contracts/${clean}`;
    const paramAlias = `${targetDir}/main.bicepparam`;
    const policyAlias = `${targetDir}/${CONTRACT_POLICY_NAME}`;
    const [paramSource, policySource] = await Promise.all([
      this.provider.read(template.paramFile),
      this.provider.read(template.policyFile),
    ]);
    const templateDocument = documentFromText(template.paramFile, paramSource.text, paramSource);
    const usingTarget = templateDocument.using
      ? resolveAlias(template.paramFile, templateDocument.using)
      : `${template.dir}/main.bicep`;
    const usingPath = relativeAlias(targetDir, usingTarget);
    const paramText = rewriteContractTemplate(paramSource.text, usingPath);
    const created = await this.commitFiles([
      { alias: paramAlias, before: null, beforeHash: null, after: new TextEncoder().encode(paramText), changed: ['using', 'policyXml'], create: true },
      { alias: policyAlias, before: null, beforeHash: null, after: policySource.bytes, changed: ['policyXml'], create: true },
    ], { action: 'contract-create' });
    this.catalog = null;
    return { id: `contracts/${clean}`, dir: targetDir, created: created.files.map((file) => file.alias), using: usingPath };
  }

  async previewPolicy(alias, changes, text = null, expectedHash) {
    const source = await this.provider.read(alias);
    assertLoadedHash(source, expectedHash);
    if (typeof text === 'string') {
      assertBalancedXml(text);
      return {
        path: alias,
        before: source.text,
        after: text,
        changed: text !== source.text,
        beforeHash: expectedHash,
      };
    }
    const after = applyPolicyChanges(source.text, changes || {});
    assertBalancedXml(after);
    return {
      path: alias,
      before: source.text,
      after,
      changed: after !== source.text,
      beforeHash: expectedHash,
      controls: readPolicyControls(after),
    };
  }

  async savePolicy(payload) {
    const preview = await this.previewPolicy(
      payload.path,
      payload.changes,
      payload.text,
      payload.expectedHash
    );
    if (!preview.changed) return { path: payload.path, changed: false, archived: null };
    const source = await this.provider.read(payload.path);
    assertLoadedHash(source, payload.expectedHash);
    const result = await this.commitFiles([
      { alias: payload.path, before: source.bytes, beforeHash: payload.expectedHash, after: new TextEncoder().encode(preview.after), changed: Object.keys(payload.changes || { raw: true }) },
    ], { action: 'policy-edit' });
    this.catalog = null;
    return { path: payload.path, changed: true, archived: result.transactionId };
  }

  async restoreContract() {
    throw new Error('Use History to restore a contract through a new verified transaction.');
  }

  async contextForEnvironment(environmentId) {
    const environments = await this.registry.listEnvironments(this.context.projectId);
    const environment = environments.find((item) => item.id === environmentId);
    if (!environment) throw new Error('Unknown target environment.');
    const handle = await this.registry.getHandle(environment.id);
    const provider = await this.createProvider(environment);
    await provider.assertWritable({ request: true });
    return { projectId: environment.projectId, environment, handle, provider };
  }

  async compareEnvironment(environmentId, alias) {
    const target = await this.contextForEnvironment(environmentId);
    const [sourceCatalog, targetCatalog] = await Promise.all([
      this.deployments(),
      discoverWorkspace(target.provider),
    ]);
    const sourceMeta = sourceCatalog.files.find((file) => file.path === alias);
    if (!sourceMeta) throw new Error(`Unknown source alias: ${alias}`);
    const targetMeta =
      targetCatalog.files.find(
        (file) =>
          sourceMeta.contract &&
          file.contract &&
          file.contract.id === sourceMeta.contract.id
      ) ||
      (sourceMeta.capability !== 'generic'
        ? targetCatalog.files.find((file) => file.capability === sourceMeta.capability)
        : null) ||
      targetCatalog.files.find((file) => file.path === alias);
    if (!targetMeta) {
      throw new Error('The target environment has no compatible parameter document.');
    }
    const [sourceFile, targetFile] = await Promise.all([
      this.provider.read(alias),
      target.provider.read(targetMeta.path),
    ]);
    const source = documentFromText(alias, sourceFile.text, sourceFile);
    source.schema = sourceMeta.schema || null;
    const destination = documentFromText(targetMeta.path, targetFile.text, targetFile);
    destination.bytes = targetFile.bytes;
    destination.schema = targetMeta.schema || null;
    const destinationMap = new Map(destination.params.map((parameter) => [parameter.name, parameter]));
    return {
      alias,
      targetAlias: targetMeta.path,
      target,
      source,
      destination,
      parameters: source.params.map((parameter) => {
        const current = destinationMap.get(parameter.name);
        const sourceType = source.schema?.parameters?.[parameter.name]?.type || parameter.kind;
        const targetType = destination.schema?.parameters?.[parameter.name]?.type || current?.kind;
        return {
          name: parameter.name,
          source: parameter.value,
          target: current?.value,
          status: !current
            ? 'missing'
            : targetType !== sourceType
              ? 'incompatible'
              : JSON.stringify(current.value) === JSON.stringify(parameter.value)
                ? 'identical'
                : 'different',
        };
      }),
    };
  }

  async copyParameters(environmentId, alias, names, expectedSourceHash, expectedTargetHash) {
    const comparison = await this.compareEnvironment(environmentId, alias);
    assertLoadedHash(comparison.source, expectedSourceHash);
    assertLoadedHash(comparison.destination, expectedTargetHash);
    const definitions = comparison.source.schema?.parameters || {};
    if (names.some((name) => !definitions[name] || definitions[name].secure)) {
      throw new Error('Secure or untyped parameters cannot be copied between environments.');
    }
    const selected = comparison.parameters.filter(
      (parameter) => names.includes(parameter.name) && parameter.status === 'different'
    );
    if (!selected.length) throw new Error('No compatible differences were selected.');
    const operations = selected.map((parameter) => ({
      op: 'set',
      path: [parameter.name],
      value: parameter.source,
    }));
    const after = previewDocumentText(comparison.destination.text, operations);
    const bytes = new TextEncoder().encode(after);
    return this.commitFiles([
      {
        alias: comparison.targetAlias,
        before: comparison.destination.bytes,
        beforeHash: expectedTargetHash,
        after: bytes,
        changed: selected.map((parameter) => parameter.name),
      },
    ], {
      action: 'environment-copy',
      context: comparison.target,
    });
  }

  async previewCopy(environmentId, alias, names, expectedSourceHash) {
    const comparison = await this.compareEnvironment(environmentId, alias);
    assertLoadedHash(comparison.source, expectedSourceHash);
    const definitions = comparison.source.schema?.parameters || {};
    if (names.some((name) => !definitions[name] || definitions[name].secure)) {
      throw new Error('Secure or untyped parameters cannot be copied between environments.');
    }
    const selected = comparison.parameters.filter(
      (parameter) => names.includes(parameter.name) && parameter.status === 'different'
    );
    const after = previewDocumentText(
      comparison.destination.text,
      selected.map((parameter) => ({ op: 'set', path: [parameter.name], value: parameter.source }))
    );
    return {
      before: comparison.destination.text,
      after,
      changed: after !== comparison.destination.text,
      selected: selected.map((parameter) => parameter.name),
      sourceHash: expectedSourceHash,
      targetHash: comparison.destination.hash,
      targetLabel: comparison.target.environment.label,
      targetAlias: comparison.targetAlias,
    };
  }

  async history() {
    return this.coordinator.history();
  }

  async inspectRecovery(transactionId) {
    return this.coordinator.inspect(transactionId);
  }

  async recoverTransaction(transactionId, action) {
    return this.coordinator.recover(transactionId, action);
  }

  async restoreTransaction(transactionId) {
    const result = await this.coordinator.revert(transactionId);
    this.catalog = null;
    return result;
  }
}
