import { sha256 } from '../source-scope.mjs';
import { configurationKey, configurationOf, unitDependencyAlias, unitForAlias, workspaceScope } from '../workspace-configuration.mjs';
import { initializeNativeParser, nativeError, parseNativeValues, NATIVE_PARSER_VERSION } from './parser.mjs';
import { assertNonsecretConfiguration, assertNonsecretValues, configurationReferences, parseNativeSchema, validateNativeValues } from './schema.mjs';

export const NATIVE_AREA_TITLES = Object.freeze({ deployment: 'Azure Deployment', llm: 'LLM Onboarding', access: 'Access Contracts' });
export const NATIVE_SOURCE_NOTICE = 'Selected native inputs, not effective runtime state. No Terraform, providers, scripts, state, cloud IDs or secret references are evaluated.';
export const NATIVE_WIRING_NOTICE = 'The pinned gateway has declared-but-unconsumed inputs and fixed module behavior (including backend circuit-breaker/model wiring). A referenced input is not proof that every nested setting affects deployed resources. Native editing does not promise Bicep parity.';
export const NATIVE_LOCAL_CREATION_NOTICE = 'Keep this folder untouched by other applications while Citadel creates the file. The browser cannot always distinguish simultaneous creation of the same path. Conflict checks and a writable-stream lock are not atomic create-if-absent.';
const SIGNATURES = {
  deployment: ['environment_name', 'location', 'apim_sku', 'ai_foundry_models'],
  llm: ['apim_name', 'llm_backend_config', 'managed_identity_client_id'],
  access: ['apim', 'use_case', 'services', 'api_name_mapping'],
};
const missing = (error) => error?.name === 'NotFoundError' || error?.code === 'SOURCE_NOT_FOUND';

export function decodeNativeBytes(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw nativeError('Native files must be valid UTF-8. No source bytes were changed.'); }
  if (text.startsWith('\uFEFF')) throw nativeError('UTF-8 BOM files are read-only in this editor. Preserve or remove the BOM in an external editor before attaching.');
  return text;
}

export async function readUnitSchema(provider, unit) {
  await initializeNativeParser();
  const prefix = unit.rootAlias ? `${unit.rootAlias}/` : '';
  const [variables, main] = await Promise.all([provider.read(`${prefix}variables.tf`), provider.read(`${prefix}main.tf`)]);
  const parameters = parseNativeSchema(variables.text, `${prefix}variables.tf`);
  const additional = parseNativeSchema(main.text, `${prefix}main.tf`);
  for (const [key, value] of Object.entries(additional)) {
    if (Object.hasOwn(parameters, key)) throw nativeError('A native variable is declared in more than one schema file.', null, 'NATIVE_DUPLICATE');
    Object.defineProperty(parameters, key, { value, enumerable: true, configurable: true, writable: true });
  }
  if (!SIGNATURES[unit.area].every((name) => Object.hasOwn(parameters, name))) {
    throw nativeError(`The selected ${NATIVE_AREA_TITLES[unit.area]} root does not declare the expected native schema. Choose the repository root that owns this value file.`, null, 'NATIVE_ROOT_SIGNATURE');
  }
  const refs = new Set(configurationReferences(main.text));
  for (const definition of Object.values(parameters)) {
    if (definition.sensitiveDefault) throw nativeError('The native schema contains a known-sensitive literal default. This source root is blocked, not backed up or displayed.', null, 'NATIVE_SENSITIVE_FILE');
    definition.consumed = refs.has(definition.name);
  }
  return { parameters, sources: [variables, main] };
}

export async function assertNativeFileSafe(text, unit, parameters) {
  await initializeNativeParser();
  const parsed = parseNativeValues(text, unit.syntax);
  assertNonsecretValues(parsed.value, parameters, text);
  return parsed;
}

export async function assertNativeDependencySafe(text, alias) {
  await initializeNativeParser();
  try {
    if (alias.endsWith('.tf')) assertNonsecretConfiguration(text);
    else if (alias.endsWith('.xml')) assertNonsecretValues({ policy: text });
  } catch (error) {
    if (error.code?.startsWith('NATIVE_')) error.message = `${alias}: ${error.message}`;
    throw error;
  }
}

function outlineFor(text, parsed, parameters) {
  const sections = [];
  let lastTitle = 'Native inputs', section = null, cursor = 0;
  for (const property of parsed.properties) {
    const comments = text.slice(cursor, property.start);
    const headings = [...comments.matchAll(/^\s*#\s*(?:\d+\.\s*)?([A-Z][A-Z /&:_()-]{3,})\s*$/gm)]
      .map((match) => match[1].trim()).filter((title) => !/^(Properties|Copy|This)\b/i.test(title));
    const title = headings.at(-1) || lastTitle;
    if (!section || title !== lastTitle) {
      section = { id: `native-${sections.length}`, title, params: [], blocks: [] };
      sections.push(section);
      lastTitle = title;
    }
    section.params.push(property.key);
    cursor = property.end;
  }
  const absent = Object.keys(parameters).filter((name) => !Object.hasOwn(parsed.value, name));
  if (absent.length) sections.push({ id: 'native-inherited', title: 'Not supplied in this file', params: absent, blocks: [{
    type: 'para', text: 'Schema defaults and required-but-absent inputs are shown separately. Opening or saving another field does not write defaults.',
  }] });
  return { sections, preamble: [], paramDocs: {} };
}

async function dependencyProof(provider, configuration, unit, sources, head) {
  const entries = await provider.entries();
  const dependencies = new Map(sources.map((item) => [item.alias, item]));
  const aliases = entries.filter((entry) => unitDependencyAlias(unit, entry.alias)).map((entry) => entry.alias).sort();
  if (aliases.length > 150) throw nativeError('Native dependency inventory exceeds 150 files.', null, 'NATIVE_LIMIT');
  let total = sources.reduce((sum, item) => sum + item.size, 0);
  for (const alias of aliases) {
    if (dependencies.has(alias)) continue;
    const dependency = await provider.read(alias);
    total += dependency.size;
    if (total > 4 * 1024 * 1024) throw nativeError('Native schema/module dependencies exceed 4 MiB.', null, 'NATIVE_LIMIT');
    // .tf dependencies are parsed for diagnostics, never executed.
    if (alias.endsWith('.tf')) configurationReferences(dependency.text);
    dependencies.set(alias, dependency);
  }
  const proof = {
    version: NATIVE_PARSER_VERSION, configuration: configurationKey(configuration), unitId: unit.id,
    valueAlias: unit.valueAlias, syntax: unit.syntax,
    dependencies: [...dependencies].map(([alias, item]) => ({ alias, hash: item.hash })).sort((a, b) => a.alias.localeCompare(b.alias)),
    head: head || await provider.workspaceHead?.() || null,
  };
  proof.hash = await sha256(new TextEncoder().encode(JSON.stringify(proof)));
  return proof;
}

export async function nativeDependencyProof(provider, configuration, unit) {
  const { sources } = await readUnitSchema(provider, unit);
  return dependencyProof(provider, configuration, unit, sources);
}

export async function nativeDocument(provider, configuration, unit, options = {}) {
  const { parameters, sources } = await readUnitSchema(provider, unit);
  let source;
  try { source = await provider.read(unit.valueAlias); }
  catch (error) {
    if (!missing(error) || !unit.allowCreate) {
      if (missing(error)) throw nativeError(`The selected value file is missing: ${unit.valueAlias}. Reattach with explicit creation or select an existing operator file; examples/defaults are never copied automatically.`, null, 'NATIVE_VALUE_MISSING');
      throw error;
    }
    const text = unit.syntax === 'json-tfvars' ? '{}\n' : '';
    source = { alias: unit.valueAlias, text, bytes: new TextEncoder().encode(text), hash: null, size: 0, absent: true, workspaceHead: await provider.workspaceHead?.() };
  }
  const parsed = await assertNativeFileSafe(source.text, unit, parameters);
  const proof = await dependencyProof(provider, configuration, unit, sources, source.workspaceHead);
  let nativePolicySource = null;
  if (unit.area === 'access') {
    const alias = `${unit.rootAlias}/policies/default-ai-product-policy.xml`;
    const dependency = proof.dependencies.find((entry) => entry.alias === alias);
    if (dependency) {
      const policy = await provider.read(alias);
      if (policy.hash !== dependency.hash) throw nativeError('The policy source changed while opening this native unit. Reopen it.', null, 'NATIVE_REVIEW_STALE');
      nativePolicySource = { path: alias, text: policy.text, hash: policy.hash };
    }
  }
  const params = [...parsed.properties.map((property) => ({ name: property.key, kind: property.node.kind,
    value: property.node.value, raw: source.text.slice(property.node.start, property.node.end),
    span: { start: property.node.start, end: property.node.end }, supplied: true })),
  ...Object.keys(parameters).filter((name) => !Object.hasOwn(parsed.value, name)).map((name) =>
    ({ name, kind: parameters[name].type, value: undefined, supplied: false }))];
  return {
    path: unit.valueAlias, format: 'terraform', unit, nativeIdentity: proof, schema: { available: true, parameters },
    nativeSchemas: sources.map(({ alias, text }) => ({ alias, text })),
    hash: source.hash, text: source.text, size: source.size, absent: Boolean(source.absent), source,
    params, outline: outlineFor(source.text, parsed, parameters), parsed, nativePolicySource,
    findings: validateNativeValues(parsed.value, parameters), nativeNotice: NATIVE_SOURCE_NOTICE,
    meta: { path: unit.valueAlias, name: unit.valueAlias.split('/').at(-1), unit,
      title: NATIVE_AREA_TITLES[unit.area], capability: { deployment: 'main', llm: 'llmOnboarding', access: 'accessContract' }[unit.area],
      schema: { available: true, parameters } },
    ...(options.noText ? { text: undefined, source: undefined, parsed: undefined, nativePolicySource: undefined } : {}),
  };
}

export async function discoverNativeWorkspace(provider, configuration) {
  const scope = workspaceScope(configuration);
  if (!scope.native) throw nativeError('A registered native Terraform descriptor is required.');
  const files = [];
  for (const unit of scope.configuration.units) {
    const doc = await nativeDocument(provider, scope.configuration, unit);
    files.push({ ...doc.meta, schema: doc.schema, nativeIdentity: doc.nativeIdentity, absent: doc.absent });
  }
  const capabilities = {
    main: files.find((file) => file.unit.area === 'deployment')?.path || null,
    llmOnboarding: files.find((file) => file.unit.area === 'llm')?.path || null,
    accessContracts: files.filter((file) => file.unit.area === 'access').map((file) => file.path),
  };
  return { format: 'terraform', files, capabilities, compatibility: 'supported', missingCapabilities: [],
    sourceAliases: (await provider.entries()).map((entry) => entry.alias),
    fingerprintSource: `${configurationKey(configuration)}\n${files.map((file) => `${file.path}:${file.nativeIdentity.hash}`).join('\n')}` };
}

export async function discoverConfiguredWorkspace(provider, environment = null, options = {}) {
  const configuration = environment ? configurationOf(environment) : provider.configuration;
  if (configuration?.format === 'terraform') return discoverNativeWorkspace(provider, configuration);
  return (await import('../citadel-core.mjs')).discoverWorkspace(provider, options);
}

export async function validateNativeReview(provider, configuration, unit, document, { includeValue = true } = {}) {
  const fresh = includeValue ? await nativeDocument(provider, configuration, unit) : {
    nativeIdentity: await dependencyProof(provider, configuration, unit, (await readUnitSchema(provider, unit)).sources),
  };
  if (fresh.nativeIdentity.hash !== document.nativeIdentity.hash ||
      includeValue && fresh.hash !== document.hash) {
    throw nativeError('The native file, schema/module/policy dependency or GitHub branch head changed after review. Your draft is preserved; reopen and review it against the new source.', null, 'NATIVE_REVIEW_STALE');
  }
  return fresh;
}

export async function nativeHistoryProof(provider, configuration, transaction) {
  if (transaction.nativeProof?.configuration !== configurationKey(configuration)) {
    throw nativeError('History belongs to different native bindings.', null, 'NATIVE_HISTORY_SCOPE');
  }
  const units = [];
  for (const file of transaction.files) {
    const unit = nativeUnit(configuration, file.alias);
    const { sources } = await readUnitSchema(provider, unit);
    const proof = await dependencyProof(provider, configuration, unit, sources);
    const previous = transaction.nativeProof.units.find((entry) => entry.unitId === unit.id && entry.valueAlias === file.alias);
    if (!previous || JSON.stringify(previous.dependencies) !== JSON.stringify(proof.dependencies)) {
      throw nativeError('The native schema, module or policy dependencies changed since this transaction. History is read-only until those exact reviewed dependencies are restored.', null, 'NATIVE_HISTORY_STALE');
    }
    units.push({ unitId: unit.id, valueAlias: file.alias, dependencies: proof.dependencies,
      schemas: sources.map(({ alias, text }) => ({ alias, text })) });
  }
  return { version: NATIVE_PARSER_VERSION, configuration: configurationKey(configuration), units };
}

export function nativeUnit(configuration, alias) {
  workspaceScope(configuration).write(alias);
  const unit = unitForAlias(configuration, alias);
  if (!unit) throw nativeError('No registered native unit owns this file.');
  return unit;
}
