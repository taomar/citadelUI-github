import { documentFromText, resolveAlias } from '../../shared/citadel-core.mjs';
import { literalBicep, readBicepParameters, scanBicep } from '../../shared/migration-input.mjs';
import { MAIN_PATH, LLM_PATH, isContractAlias } from '../../shared/source-plan.mjs';
import { normalizeAlias, isSkippedDirectory, sha256 } from '../../shared/source-scope.mjs';
import { EXPORT_AREAS, TERRAFORM_CONTRACT } from '../../shared/terraform-contract.mjs';
import { exportPathKey, projectTerraformExport } from '../../shared/terraform-export.mjs';
import { assertExportValue, exportSecret, EXPORT_LIMITS, exportFail, TerraformExportError } from '../../shared/terraform-literals.mjs';
import { createZip } from '../../shared/zip.mjs';
import { GitHubRepositoryProvider } from './github-provider.mjs';
import { environmentSourceOf } from './registry.mjs';

const encoder = new TextEncoder();
const stable = (value) => JSON.stringify(value, (_key, entry) => entry && !Array.isArray(entry) && typeof entry === 'object'
  ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry);
const contextIdentity = (context) => stable({
  project: context.projectId, environment: context.environment.id,
  source: environmentSourceOf(context.environment),
});
const remoteIdentity = (tree) => stable({
  head: tree.head, repositoryId: tree.repositoryId ?? tree.repository?.id,
  fullName: tree.fullName ?? tree.repository?.fullName, branch: tree.branch ?? tree.workingBranch,
});

function dependencyAlias(base, relative, extension) {
  if (typeof relative !== 'string' || !relative || /^[\\/]|^[a-z]:/i.test(relative)) {
    exportFail('scope', 'A source dependency must be a repository-relative path.');
  }
  const path = resolveAlias(base, relative);
  if (normalizeAlias(path) !== path || !path.endsWith(extension) || path.split('/').slice(0, -1).some(isSkippedDirectory)) {
    exportFail('scope', 'Source dependencies are limited to permitted Bicep templates and policy XML.');
  }
  return path;
}

function defaultPolicyPath(template, text, name) {
  const tokens = scanBicep(text);
  const found = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].depth !== 0 || tokens[index].text !== 'var' || tokens[index + 1]?.text !== name) continue;
    const part = tokens.slice(index, index + 7);
    const after = tokens[index + 7];
    const nextDeclaration = !after || (after.depth === 0 && after.first &&
      ['var', 'param', 'module', 'resource', 'output', 'func', 'type', 'targetScope', 'metadata', 'import', 'extension', 'assert', '@'].includes(after.text));
    if (part[2]?.text !== '=' || part[3]?.text !== 'loadTextContent' || part[4]?.text !== '(' || part[6]?.text !== ')' || !nextDeclaration) {
      exportFail('policy', 'The source default policy is not a static loadTextContent reference.');
    }
    const literal = literalBicep(part[5].text);
    if (literal.status !== 'literal' || typeof literal.value !== 'string') exportFail('policy', 'The source default policy path is not static.');
    found.push(dependencyAlias(template, literal.value, '.xml'));
  }
  if (found.length !== 1) exportFail('policy', 'The source template must declare one unambiguous default policy reference.');
  return found[0];
}

/** Only .bicepparam, its schema and actually used XML are read; no env bridge. */
export async function readTerraformSource(provider, path) {
  const dependencies = new Map();
  let total = 0;
  const read = async (alias) => {
    if (dependencies.has(alias)) return dependencies.get(alias);
    if (dependencies.size >= EXPORT_LIMITS.dependencies) exportFail('limit', 'Too many source dependencies for one export.');
    const file = await provider.read(alias);
    if (!(file.bytes instanceof Uint8Array)) exportFail('integrity', 'The source provider did not supply verifiable byte content.');
    const bytes = file.bytes;
    if (bytes.length > EXPORT_LIMITS.fileBytes || (total += bytes.length) > EXPORT_LIMITS.totalBytes) exportFail('limit', 'Selected source dependencies exceed the export limits.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const hash = await sha256(bytes);
    if (file.hash !== hash || file.size !== bytes.length) exportFail('integrity', 'A source dependency failed its byte/hash check. Reconnect and retry.');
    const result = { path: alias, text, hash, size: bytes.length };
    dependencies.set(alias, result);
    return result;
  };
  const parameter = await read(path);
  const parsed = readBicepParameters(parameter.text);
  if (!parsed.using) exportFail('schema', 'Saved-source export requires the selected Bicep template, not using none.');
  const template = await read(dependencyAlias(path, parsed.using, '.bicep'));
  const source = {
    path, text: parameter.text, hash: parameter.hash, template: template.path,
    templateText: template.text, policies: {},
  };
  if (isContractAlias(path)) {
    const assignment = parsed.parameters.find((entry) => entry.name === 'services');
    if (assignment) {
      let services;
      try {
        const doc = documentFromText(path, parameter.text);
        services = doc.parsed.params.find((entry) => entry.name === 'services')?.value;
      } catch (error) {
        if (!['ParseError', 'LexError'].includes(error.name)) throw error;
      }
      if (services?.kind === 'array') {
        for (const [index, service] of services.items.entries()) {
          const policy = service.properties?.find((entry) => entry.key === 'policyXml')?.value;
          if (policy?.kind === 'call' && policy.callee === 'loadTextContent') {
            if (policy.args.length !== 1 || policy.args[0].kind !== 'string' ||
                literalBicep(parameter.text.slice(policy.args[0].start, policy.args[0].end)).status !== 'literal') {
              exportFail('policy', 'policyXml must reference one static, repository-confined XML file.');
            }
            source.policies[exportPathKey(['services', index, 'policyXml'])] =
              await read(dependencyAlias(path, policy.args[0].value, '.xml'));
          }
          if (!policy || (policy.kind === 'string' && policy.value === '')) {
            const code = service.properties?.find((entry) => entry.key === 'code')?.value;
            const multi = code?.kind === 'string' && ['TOOL', 'AGENT', 'MULTI'].includes(code.value.toUpperCase());
            const property = multi ? 'defaultMultiPolicy' : 'defaultPolicy';
            source[property] = await read(defaultPolicyPath(template.path, template.text,
              multi ? 'defaultMultiProductPolicyXml' : 'defaultProductPolicyXml'));
          }
        }
      } else {
        // An explicitly supplied services literal still inherits the source's
        // default XML, so bind both locally declared defaults before review.
        source.defaultPolicy = await read(defaultPolicyPath(template.path, template.text, 'defaultProductPolicyXml'));
        source.defaultMultiPolicy = await read(defaultPolicyPath(template.path, template.text, 'defaultMultiProductPolicyXml'));
      }
    }
  }
  source.dependencies = [...dependencies.values()].map(({ path, hash, size }) => ({ path, hash, size }));
  return source;
}

/** Ephemeral export authority. It has no coordinator, save, registry-write or state API. */
export class TerraformExportSession {
  #context;
  #contextKey;
  #getContext;
  #provider;
  #originalProvider;
  #root;
  #registry;
  #pending;
  #records = new Map();
  #choices = new Map();
  #selection = new Map();
  #inventory = [];
  #review = null;
  #generation = 0;
  #flight = null;
  #closed = false;
  #remote = null;

  constructor({ contextProvider, registry, pendingEdits = () => false, activePath = null }) {
    this.#context = contextProvider();
    this.#getContext = contextProvider;
    this.#contextKey = contextIdentity(this.#context);
    this.#originalProvider = this.#context.provider;
    this.#root = this.#context.provider.root;
    // Do not reset or repin the normal editor's GitHub provider.
    this.#provider = this.#context.provider.remote ? new GitHubRepositoryProvider({
      request: this.#context.provider.request, environmentId: this.#context.provider.environmentId,
    }) : this.#context.provider;
    this.#registry = registry;
    this.#pending = pendingEdits;
    for (const area of EXPORT_AREAS) this.#selection.set(area.id, { included: true, path: area.path });
    if (activePath && isContractAlias(activePath)) this.#selection.get('access').path = activePath;
  }

  async #assertCurrent() {
    if (this.#closed) exportFail('closed', 'This export session has ended. Open Export to Terraform again.');
    if (this.#getContext() !== this.#context || contextIdentity(this.#context) !== this.#contextKey ||
        this.#context.provider !== this.#originalProvider || this.#context.provider.root !== this.#root) {
      this.#review = null;
      exportFail('context', 'The selected workspace or branch changed. Exit and start a new saved-source review.');
    }
    if (this.#pending() || (this.#registry && await this.#registry.countDrafts(this.#context.environment.id))) {
      this.#review = null;
      exportFail('pending', 'Save or discard existing editor drafts before export. Your parameter and policy edits have been kept.');
    }
  }

  #editable() {
    if (this.#flight) exportFail('busy', 'Export is in progress. Wait before changing the review.');
    if (this.#closed) exportFail('closed', 'This export session has ended.');
    this.#review = null;
    this.#generation++;
  }

  async initialize() {
    await this.#assertCurrent();
    if (this.#provider.remote) this.#remote = remoteIdentity(await this.#provider.tree({ refresh: true }));
    const entries = await this.#provider.entries();
    this.#inventory = entries.filter(({ alias }) => alias === MAIN_PATH || alias === LLM_PATH || isContractAlias(alias))
      .map(({ alias }) => ({ path: alias, area: alias === MAIN_PATH ? 'deployment' : alias === LLM_PATH ? 'llm' : 'access' }));
    for (const area of EXPORT_AREAS) {
      const selected = this.#selection.get(area.id);
      const available = this.#inventory.filter((entry) => entry.area === area.id);
      if (!available.some((entry) => entry.path === selected.path)) selected.path = available.length === 1 ? available[0].path : null;
    }
    await this.reload();
    return this.view();
  }

  async reload() {
    this.#editable();
    await this.#assertCurrent();
    if (this.#provider.remote) this.#remote = remoteIdentity(await this.#provider.tree({ refresh: true }));
    for (const [area, selection] of this.#selection) {
      if (!selection.included || !selection.path) continue;
      const key = `${area}:${selection.path}`;
      try {
        const source = await readTerraformSource(this.#provider, selection.path);
        const old = this.#records.get(key)?.source;
        if (old && old.hash !== source.hash) {
          const choices = this.#choices.get(key) || {};
          this.#choices.set(key, Object.fromEntries(Object.entries(choices).filter(([name]) => !name.startsWith('source:'))));
        }
        this.#records.set(key, { source });
      } catch (error) {
        // A source failure remains an explicit blocker for its selected area.
        this.#records.set(key, { error: error instanceof TerraformExportError ? error.message :
          'The saved source, template or policy could not be read. Reconnect or correct it, then reload saved source.' });
      }
    }
    return this.view();
  }

  async select(area, { included, path } = {}) {
    if (!this.#selection.has(area)) exportFail('area', 'Unknown export area.');
    this.#editable();
    const selection = this.#selection.get(area);
    if (included !== undefined) selection.included = Boolean(included);
    if (path !== undefined) {
      if (path !== null && !this.#inventory.some((entry) => entry.area === area && entry.path === path)) exportFail('source', 'Choose a listed source configuration.');
      selection.path = path;
    }
    if (selection.included && selection.path && !this.#records.has(`${area}:${selection.path}`)) await this.reload();
    return this.view();
  }

  setInput(area, key, value) {
    this.#editable();
    const selection = this.#selection.get(area);
    if (!selection?.path || typeof key !== 'string') exportFail('input', 'Select a source before entering export-only values.');
    const id = `${area}:${selection.path}`;
    const choices = { ...(this.#choices.get(id) || {}) };
    if (value === undefined) delete choices[key];
    else {
      assertExportValue(value);
      if (exportSecret(value)) exportFail('secret', 'Credential material is not allowed in export-only inputs.');
      choices[key] = structuredClone(value);
    }
    this.#choices.set(id, choices);
  }

  revise() {
    this.#editable();
  }

  view() {
    const areas = EXPORT_AREAS.map((area) => {
      const selection = this.#selection.get(area.id);
      const key = `${area.id}:${selection.path}`;
      const record = this.#records.get(key);
      const choices = this.#choices.get(key) || {};
      let projection = null;
      let error = record?.error || null;
      if (record?.source) {
        try { projection = projectTerraformExport(area.id, record.source, choices); }
        catch (problem) {
          error = problem instanceof TerraformExportError ? problem.message :
            'This source has unsupported syntax, data or shapes. Correct the source and reload; no files were generated.';
        }
      }
      return {
        ...area, ...selection, choices: structuredClone(choices), projection, error,
        configurations: this.#inventory.filter((entry) => entry.area === area.id).map((entry) => entry.path),
      };
    });
    const included = areas.filter((area) => area.included);
    const blockers = included.reduce((count, area) => count + (!area.path || area.error || !area.projection ? 1 : area.projection.blockers.length), 0);
    return {
      areas, included: included.length, blockers: included.length ? blockers : 1,
      ready: included.length > 0 && blockers === 0, contract: TERRAFORM_CONTRACT,
      review: this.#review ? {
        id: this.#review.id, zipHash: this.#review.zipHash, size: this.#review.bytes.length,
        dependencies: structuredClone(this.#review.dependencies),
        files: this.#review.files.map(({ path, text, hash }) => ({ path, text, hash })),
      } : null,
    };
  }

  async review() {
    this.#editable();
    const generation = this.#generation;
    await this.#assertCurrent();
    const view = this.view();
    if (!view.ready) exportFail('blocked', 'Resolve every included area blocker, or explicitly exclude that whole area. No partial settings export is available.');
    const files = [];
    const dependencies = new Map();
    let sourceBytes = 0;
    const chosen = [];
    for (const area of view.areas.filter((entry) => entry.included)) {
      const source = this.#records.get(`${area.id}:${area.path}`).source;
      for (const dependency of source.dependencies) {
        if (dependencies.has(dependency.path) && dependencies.get(dependency.path).hash !== dependency.hash) {
          exportFail('stale', 'Shared source dependencies changed between area reads. Reload saved source and review again.');
        }
        if (!dependencies.has(dependency.path)) sourceBytes += dependency.size;
        dependencies.set(dependency.path, dependency);
        if (dependencies.size > EXPORT_LIMITS.dependencies || sourceBytes > EXPORT_LIMITS.totalBytes) {
          exportFail('limit', 'Combined selected source dependencies exceed 64 files or 24 MiB. Narrow the selected areas.');
        }
      }
      const bytes = encoder.encode(area.projection.text);
      files.push({ path: area.projection.path, text: area.projection.text, bytes, hash: await sha256(bytes) });
      chosen.push({ area: area.id, path: area.path, choices: area.choices });
    }
    const bytes = createZip(files);
    const zipHash = await sha256(bytes);
    const approval = {
      contract: TERRAFORM_CONTRACT, workspace: this.#contextKey, remote: this.#remote,
      chosen, dependencies: [...dependencies.values()].sort((a, b) => a.path.localeCompare(b.path)),
      files: files.map(({ path, hash }) => ({ path, hash })), zipHash,
    };
    const id = await sha256(encoder.encode(stable(approval)));
    await this.#assertCurrent();
    if (this.#generation !== generation) exportFail('review', 'Export selections or inputs changed while building the review. Review again.');
    this.#review = { id, files, bytes, zipHash, dependencies: approval.dependencies, generation };
    return this.view().review;
  }

  approveAndExport(id, download) {
    if (this.#flight) return this.#flight;
    const reviewed = this.#review;
    if (!reviewed || id !== reviewed.id || reviewed.generation !== this.#generation) {
      return Promise.reject(new TerraformExportError('review', 'Create and inspect a fresh ZIP review before approving.'));
    }
    this.#flight = (async () => {
      await this.#assertCurrent();
      if (this.#provider.remote && remoteIdentity(await this.#provider.tree({ refresh: true })) !== this.#remote) {
        exportFail('stale', 'The source branch changed after review. Reload saved source and review again.');
      }
      for (const dependency of reviewed.dependencies) {
        const current = await this.#provider.read(dependency.path);
        if (!(current.bytes instanceof Uint8Array)) exportFail('integrity', 'The source provider did not supply verifiable byte content.');
        const bytes = current.bytes;
        if (bytes.length !== dependency.size || await sha256(bytes) !== dependency.hash) {
          exportFail('stale', 'A reviewed source, template or policy changed. Approval was revoked; reload saved source and review again.');
        }
      }
      await this.#assertCurrent();
      if (this.#review !== reviewed || await sha256(reviewed.bytes) !== reviewed.zipHash) exportFail('integrity', 'The reviewed archive changed. Create a new review.');
      await download({ name: 'citadel-terraform-export.zip', bytes: reviewed.bytes.slice(), hash: reviewed.zipHash });
      this.#review = null;
      return { files: reviewed.files.map((file) => file.path), hash: reviewed.zipHash };
    })().catch((error) => {
      this.#review = null;
      throw error;
    }).finally(() => { this.#flight = null; });
    return this.#flight;
  }

  close() {
    if (this.#flight) exportFail('busy', 'Wait for the export attempt before exiting.');
    this.#closed = true;
    this.#records.clear(); this.#choices.clear(); this.#review = null;
  }
}
