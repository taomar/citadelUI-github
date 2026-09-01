import { parseBicepParam, nodeToValue } from './bicepparam/parser.mjs';
import { applyEdits } from './bicepparam/edit.mjs';
import { buildOutline } from './doclayer.mjs';

const CONTRACT_ROOT_MARKER = 'citadel-access-contracts';
const MAIN_PATH = 'bicep/infra/main.bicepparam';
const LLM_PATH = 'bicep/infra/llm-backend-onboarding/main.bicepparam';
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

function contractMetadata(alias, doc) {
  const parts = alias.split('/');
  const rootIndex = parts.lastIndexOf(CONTRACT_ROOT_MARKER);
  if (rootIndex < 0) return null;
  const root = parts.slice(0, rootIndex + 1).join('/');
  const relative = parts.slice(rootIndex + 1, -1);
  if (['modules', 'policies', 'base-contracts'].includes(relative[0])) return null;
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

export async function discoverWorkspace(provider) {
  const entries = await provider.entries();
  const aliases = new Set(entries.map((entry) => entry.alias));
  const files = [];
  for (const entry of entries.filter((item) => item.kind === 'bicepparam')) {
    try {
      const source = await provider.read(entry.alias);
      const document = documentFromText(entry.alias, source.text, source);
      const contract = contractMetadata(entry.alias, document.parsed);
      document.contract = contract;
      const references = expressionReferences(document.parsed);
      let template = null;
      let schema = { available: false, parameters: {}, error: 'No template resolved' };
      if (document.using) {
        template = resolveAlias(entry.alias, document.using);
        if (aliases.has(template)) {
          const templateSource = await provider.read(template);
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
      files.push(item);
    } catch (error) {
      files.push({
        id: entry.alias,
        path: entry.alias,
        name: basename(entry.alias),
        unit: dirname(entry.alias) || '(root)',
        parseError: error.message,
        capability: 'generic',
      });
    }
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
