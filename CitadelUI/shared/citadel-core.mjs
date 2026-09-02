import { parseBicepParam, nodeToValue } from './bicepparam/parser.mjs';
import { applyEdits } from './bicepparam/edit.mjs';
import { buildOutline } from './doclayer.mjs';
// One definition of where Citadel's sources live. The interest policy and the
// discovery that honours it must agree by construction, not by coincidence.
import {
  CONTRACT_ROOT_MARKER,
  LLM_PATH,
  MAIN_PATH,
  citadelSourcePlan,
  contractRootOf,
  isContractAlias,
  planScope,
} from './source-plan.mjs';

const MAIN_SIGNATURE = new Set([
  'environmentName',
  'location',
  'resourceGroupName',
  'apimServiceName',
  'vnetName',
  'apimSku',
  'apimSkuUnits',
  'aiSearchInstances',
  'aiFoundryInstances',
  'entraTenantId',
  'entraClientId',
  'aiFoundryModelsConfig',
  'logicAppsSkuCapacityUnits',
  'apicSku',
  'enableAPICenter',
  'enableOpenAIRealtime',
  'redisSkuName',
]);
const MAIN_MINIMUM_PARAMETERS = 50;
const LLM_SIGNATURE = new Set([
  'apim',
  'apimManagedIdentity',
  'llmBackendConfig',
  'configureCircuitBreaker',
  'circuitBreakerDefaults',
  'configureSessionAffinity',
  'sessionAffinityDefaults',
  'modelAliases',
]);
const ACCESS_SIGNATURE = new Set([
  'apim',
  'useTargetAzureKeyVault',
  'keyVault',
  'useCase',
  'apiNameMapping',
  'services',
  'productTerms',
  'useTargetFoundry',
]);
const ACCESS_MINIMUM_PARAMETERS = 17;

function dirname(alias) {
  const parts = alias.split('/');
  parts.pop();
  return parts.join('/');
}

function basename(alias) {
  return alias.split('/').at(-1) || alias;
}

export function resolveAlias(baseAlias, relativeAlias) {
  const stack = dirname(baseAlias).split('/').filter(Boolean);
  for (const part of String(relativeAlias || '').replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!stack.length) throw new Error(`Reference escapes the selected directory: ${relativeAlias}`);
      stack.pop();
    } else {
      stack.push(part);
    }

  }
  return stack.join('/');
}

export function relativeAlias(fromDirectory, targetAlias) {
  const from = String(fromDirectory || '').split('/').filter(Boolean);
  const target = String(targetAlias || '').split('/').filter(Boolean);
  let common = 0;
  while (common < from.length && common < target.length && from[common] === target[common]) {
    common += 1;
  }
  return [...from.slice(common).map(() => '..'), ...target.slice(common)].join('/') || '.';
}

function collectCalls(node, callee, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (node.kind === 'call') {
    if (node.callee === callee) found.push(node);
    for (const argument of node.args || []) collectCalls(argument, callee, found);
  } else if (node.kind === 'array') {
    for (const item of node.items) collectCalls(item, callee, found);
  } else if (node.kind === 'object') {
    for (const property of node.properties) collectCalls(property.value, callee, found);
  }
  return found;
}

function expressionReferences(doc) {
  return doc.params.flatMap((parameter) =>
    collectCalls(parameter.value, 'readEnvironmentVariable').map((call) => ({
      name: call.args?.[0]?.kind === 'string' ? call.args[0].value : null,
      default:
        call.args?.[1] && call.args[1].kind !== 'call'
          ? nodeToValue(call.args[1])
          : null,
      parameter: parameter.name,
    }))
  );
}

/**
 * What a contract's *path* proves, without reading it.
 *
 * The subtree marker, the instance id and the default policy location are all
 * conventions of the layout, so they are knowable from the alias alone. This is
 * what lets a contract appear in the catalogue while its content stays
 * undownloaded until the user opens that area.
 */
function pathContract(alias) {
  const parts = alias.split('/');
  const rootIndex = parts.lastIndexOf(CONTRACT_ROOT_MARKER);
  if (rootIndex < 0) return null;
  const root = parts.slice(0, rootIndex + 1).join('/');
  const relative = parts.slice(rootIndex + 1, -1);
  if (!isContractAlias(alias)) return null;
  return {
    root,
    id: relative.join('/') || '__template',
    dir: dirname(alias),
    policyAlias: relative.length === 0 ? `${root}/policies/default-ai-product-policy.xml` : null,
    isTemplate: relative.length === 0,
  };
}

function contractMetadata(alias, doc) {
  const parts = alias.split('/');
  const rootIndex = parts.lastIndexOf(CONTRACT_ROOT_MARKER);
  if (rootIndex < 0) return null;
  const root = parts.slice(0, rootIndex + 1).join('/');
  const relative = parts.slice(rootIndex + 1, -1);
  if (!isContractAlias(alias)) return null;
  const id = relative.join('/') || '__template';
  const policyCall = doc.params
    .flatMap((parameter) => collectCalls(parameter.value, 'loadTextContent'))
    .find((call) => call.args?.[0]?.kind === 'string');
  return {
    root,
    id,
    dir: dirname(alias),
    policyAlias: policyCall
      ? resolveAlias(alias, policyCall.args[0].value)
      : relative.length === 0
        ? `${root}/policies/default-ai-product-policy.xml`
        : null,
    isTemplate: relative.length === 0,
  };
}

export function extractSchema(source) {
  const parameters = {};
  const stringLiterals = (text) =>
    [...text.matchAll(/'((?:\\'|[^'])*)'/g)].map((match) => match[1].replace(/\\'/g, "'"));
  const decoratorBody = (block, name) => {
    const start = block.lastIndexOf(`@${name}(`);
    if (start < 0) return null;
    let depth = 0;
    let quote = false;
    for (let index = start + name.length + 2; index < block.length; index += 1) {
      const character = block[index];
      if (character === "'" && block[index - 1] !== '\\') quote = !quote;
      if (quote) continue;
      if (character === '(') depth += 1;
      else if (character === ')') {
        if (depth === 0) return block.slice(start + name.length + 2, index);
        depth -= 1;
      }
    }
    return null;
  };
  const numberDecorator = (block, name) => {
    const body = decoratorBody(block, name);
    if (body === null) return undefined;
    const value = Number(body.trim());
    return Number.isFinite(value) ? value : undefined;
  };
  const allowedValues = (block) => {
    const body = decoratorBody(block, 'allowed');
    if (body === null) return null;
    const strings = stringLiterals(body);
    if (strings.length) return strings;
    return body
      .replace(/^\s*\[/, '')
      .replace(/\]\s*$/, '')
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((value) => (value === 'true' ? true : value === 'false' ? false : Number(value)));
  };
  const pattern =
    /((?:^[ \t]*@[\s\S]*?\r?\n)*)^[ \t]*param[ \t]+([A-Za-z_]\w*)[ \t]+([A-Za-z_]\w*)/gm;
  let match;
  while ((match = pattern.exec(source))) {
    const [, decorators, name, type] = match;
    const description = decoratorBody(decorators, 'description');
    parameters[name] = {
      name,
      type,
      secure: /@secure\s*\(/.test(decorators),
      description: description === null ? null : stringLiterals(description)[0] || null,
      allowedValues: allowedValues(decorators),
      minLength: numberDecorator(decorators, 'minLength'),
      maxLength: numberDecorator(decorators, 'maxLength'),
      minValue: numberDecorator(decorators, 'minValue'),
      maxValue: numberDecorator(decorators, 'maxValue'),
      metadata: {},
    };
  }
  return parameters;
}

export function documentFromText(alias, text, file = {}) {
  const doc = parseBicepParam(text);
  const outline = buildOutline(text, doc.params);
  return {
    path: alias,
    hash: file.hash || null,
    mtimeMs: file.lastModified || null,
    size: file.size ?? new TextEncoder().encode(text).byteLength,
    using: doc.using?.path || null,
    text,
    outline,
    params: doc.params.map((parameter) => ({
      name: parameter.name,
      kind: parameter.value.kind,
      value: nodeToValue(parameter.value),
      raw: text.slice(parameter.value.start, parameter.value.end),
      span: { start: parameter.value.start, end: parameter.value.end },
      doc: outline.paramDocs[parameter.name] || null,
    })),
    parsed: doc,
  };
}

export function previewDocumentText(text, operations) {
  const after = applyEdits(text, operations || []);
  parseBicepParam(after);
  return after;
}

function hasSignature(names, signature) {
  return [...signature].every((name) => names.has(name));
}

function capabilityKind(document) {
  const names = new Set(document.params.map((parameter) => parameter.name));
  if (
    document.path === MAIN_PATH &&
    document.params.length >= MAIN_MINIMUM_PARAMETERS &&
    hasSignature(names, MAIN_SIGNATURE)
  ) {
    return 'main';
  }
  if (
    document.path === LLM_PATH &&
    document.params.length === LLM_SIGNATURE.size &&
    hasSignature(names, LLM_SIGNATURE)
  ) {
    return 'llm-onboarding';
  }
  if (
    document.contract &&
    document.params.length >= ACCESS_MINIMUM_PARAMETERS &&
    hasSignature(names, ACCESS_SIGNATURE)
  ) {
    return 'access-contract';
  }
  return 'generic';
}

/**
 * How many source reads may be in flight at once during discovery.
 *
 * Measured against a real 170-file Citadel repository over GitHub: the
 * sequential loop this replaces took 38 seconds for 32 reads, because every one
 * of them paid a full round trip in series. Six is enough to hide that latency
 * without behaving like a crawler against one repository, and it is a parameter
 * rather than a constant so a slower or stricter deployment can lower it.
 */
export const DEFAULT_DISCOVERY_CONCURRENCY = 6;

/**
 * Run `work` over `items` with at most `limit` in flight.
 *
 * Results are written by index, never pushed, so the output order is the input
 * order regardless of which read finishes first. `Promise.all` over the whole
 * list would be simpler and would open 32 sockets against one repository; the
 * point of the bound is that it is a bound.
 */
async function mapWithLimit(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.max(1, Math.min(limit, items.length))).fill(null).map(async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Discover the Citadel workspace behind a provider.
 *
 * Three properties beyond the obvious one:
 *
 *   - Every distinct alias is read exactly once. Sixteen parameter files
 *     referenced ten templates and produced sixteen template reads; caching the
 *     read *promise* deduplicates concurrent readers as well as sequential ones.
 *   - A file that fails to parse or read produces a record rather than aborting
 *     the scan, and its failure cannot affect its neighbours, which is why each
 *     unit of work owns its own try/catch.
 *   - A provider whose reads cross a network is scoped to what Citadel's three
 *     editors actually need, and that decision is made *here*.
 *
 * ## Why the scope decision lives in this function
 *
 * It used to be an option every caller had to remember to pass, and the eight
 * call sites that open a workspace all forgot — so the policy existed and did
 * nothing. Worse, `WorkspaceService.deployments()` has no call site to fix: it
 * rescans after a save, and would have gone back to reading the whole
 * repository at the one moment the user is waiting.
 *
 * A read that costs a round trip is a fact about the *provider*, not about the
 * caller, so the provider states it (`remote`) and the one function that
 * performs the reads acts on it. There is nowhere left to forget.
 *
 * An explicit `options.scope` still wins, which is how the compatibility scan
 * narrows further to just the signature set.
 */
export async function discoverWorkspace(provider, options = {}) {
  const concurrency = options.concurrency ?? DEFAULT_DISCOVERY_CONCURRENCY;
  const onProgress = options.onProgress || null;
  const entries = await provider.entries();
  // When a scope is in force, only these aliases may be downloaded. Everything
  // else is described from its path. Citadel has three editors and knows where
  // their sources live; reading the rest of the repository to discover that is
  // work the product never needed.
  //
  // A local folder keeps the full scan: reading a directory already on the
  // machine costs nothing worth optimising, and narrowing it would change
  // behaviour the local edition has always had.
  const scope =
    options.scope instanceof Set
      ? options.scope
      : provider?.remote
        ? planScope(citadelSourcePlan(entries), options.purpose)
        : null;
  const aliases = new Set(entries.map((entry) => entry.alias));
  const candidates = entries.filter((item) => item.kind === 'bicepparam');
  const targets = scope ? candidates.filter((entry) => scope.has(entry.alias)) : candidates;
  const deferred = scope ? candidates.filter((entry) => !scope.has(entry.alias)) : [];
  // Keyed by alias and holding the in-flight promise, so two parameter files
  // that share a template wait on one read instead of issuing two.
  const reads = new Map();
  const readOnce = (alias) => {
    if (!reads.has(alias)) reads.set(alias, provider.read(alias));
    return reads.get(alias);
  };
  let completed = 0;
  const announce = () => {
    completed += 1;
    onProgress?.({ done: completed, total: targets.length });
  };

  const files = (
    await mapWithLimit(targets, concurrency, async (entry) => {
      try {
        const source = await readOnce(entry.alias);
        const document = documentFromText(entry.alias, source.text, source);
        const contract = contractMetadata(entry.alias, document.parsed);
        document.contract = contract;
        const references = expressionReferences(document.parsed);
        let template = null;
        let schema = { available: false, parameters: {}, error: 'No template resolved' };
        if (document.using) {
          template = resolveAlias(entry.alias, document.using);
          if (aliases.has(template)) {
            const templateSource = await readOnce(template);
            const parameters = extractSchema(templateSource.text);
            schema = {
              available: Object.keys(parameters).length > 0,
              parameters,
              error: Object.keys(parameters).length ? null : 'No Bicep parameter declarations found',
              source: 'selected-directory',
            };
          }
        }
        const item = {
          id: entry.alias,
          path: entry.alias,
          name: basename(entry.alias),
          unit: dirname(entry.alias) || '(root)',
          archetype: references.length ? 'expression-backed' : 'declarative',
          paramCount: document.params.length,
          expressionCount: references.length,
          envVarCount: 0,
          envVars: [],
          expressions: references,
          template,
          usingRaw: document.using,
          contract,
          bytes: source.size,
          hash: source.hash,
          parseError: null,
          capability: null,
          schema,
        };
        item.capability = capabilityKind({ ...document, contract });
        return item;
      } catch (error) {
        return {
          id: entry.alias,
          path: entry.alias,
          name: basename(entry.alias),
          unit: dirname(entry.alias) || '(root)',
          parseError: error.message,
          capability: 'generic',
        };
      } finally {
        announce();
      }
    })
  ).filter(Boolean);

  // Out-of-scope parameter files are still *listed*, so counts and navigation
  // are complete, but nothing about them was downloaded. They carry what their
  // path proves and say plainly that they were not read.
  for (const entry of deferred) {
    const contract = contractRootOf(entry.alias) ? pathContract(entry.alias) : null;
    files.push({
      id: entry.alias,
      path: entry.alias,
      name: basename(entry.alias),
      unit: dirname(entry.alias) || '(root)',
      archetype: 'declarative',
      paramCount: null,
      expressionCount: null,
      envVarCount: 0,
      envVars: [],
      expressions: [],
      template: null,
      usingRaw: null,
      contract,
      bytes: null,
      hash: null,
      parseError: null,
      // Derived from the path, which is what makes a contract a contract.
      capability: contract ? 'access-contract' : 'generic',
      schema: { available: false, parameters: {}, error: 'Not loaded yet' },
      deferred: true,
    });
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  const unitMap = new Map();
  for (const file of files) {
    if (!unitMap.has(file.unit)) unitMap.set(file.unit, []);
    unitMap.get(file.unit).push(file);
  }
  const capabilities = {
    main: files.find((file) => file.capability === 'main')?.path || null,
    llmOnboarding: files.find((file) => file.capability === 'llm-onboarding')?.path || null,
    accessContracts: files.filter((file) => file.capability === 'access-contract').map((file) => file.path),
  };
  const templateContract = files.find(
    (file) => file.capability === 'access-contract' && file.contract?.isTemplate
  );
  const accessContractReady = Boolean(
    templateContract?.contract?.policyAlias && aliases.has(templateContract.contract.policyAlias)
  );
  const missingCapabilities = [
    !capabilities.main ? MAIN_PATH : null,
    !capabilities.llmOnboarding ? LLM_PATH : null,
    !accessContractReady ? `${CONTRACT_ROOT_MARKER} template and default policy` : null,
  ].filter(Boolean);
  const signature = files
    .filter((file) => !file.parseError)
    .map((file) => `${file.path}:${file.hash}:${file.capability}`)
    .join('|');
  return {
    repoRoot: null,
    files,
    sourceAliases: [...aliases].sort(),
    units: [...unitMap].map(([unit, grouped]) => ({ unit, files: grouped, contracts: [] })),
    capabilities,
    compatibility: missingCapabilities.length === 0 ? 'supported' : files.length ? 'degraded' : 'read-only',
    missingCapabilities,
    fingerprintSource: signature,
  };
}

export const primaryCapabilities = Object.freeze({
  mainPath: MAIN_PATH,
  llmPath: LLM_PATH,
  mainSignature: [...MAIN_SIGNATURE],
  mainMinimumParameters: MAIN_MINIMUM_PARAMETERS,
  llmSignature: [...LLM_SIGNATURE],
  accessSignature: [...ACCESS_SIGNATURE],
  accessMinimumParameters: ACCESS_MINIMUM_PARAMETERS,
});

export function contractInfo(file, aliases) {
  const contract = file.contract;
  if (!contract) return null;
  const name =
    contract.id === '__template'
      ? 'Template'
      : contract.id
          .split('/')
          .at(-1)
          .split(/[-_]/)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(' ');
  return {
    id: contract.id,
    name,
    dir: contract.dir,
    paramFile: file.path,
    policyFile: contract.policyAlias,
    hasPolicy: Boolean(contract.policyAlias && aliases.has(contract.policyAlias)),
    paramCount: file.paramCount,
    isTemplate: contract.isTemplate,
    modifiedMs: null,
    error: file.parseError,
  };
}
