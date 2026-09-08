import { environmentSourceOf } from './registry.mjs';
import { migrationTargetAlias, migrationTemplateAlias } from './migration-donor.mjs';
import { llmMigrationPolicy, validateMigrationCandidate, validateMigrationFeatures } from './migration-validation.mjs';
import { buildMigrationPlan, decideMigration, decideMigrationModel, evaluateMigration, keepMigrationRemaining, migrationNameReports, migrationRows, migrationTargetProjection } from '../../shared/parameter-migration.mjs';
import { MigrationError, MIGRATION_LIMITS, migrationMessage, readArmParameters, readBicepParameters, safeLabel } from '../../shared/migration-input.mjs';
import { sha256, sourceExtension } from '../../shared/source-scope.mjs';
import { MAIN_PATH, LLM_PATH, contractRootOf, isContractAlias } from '../../shared/source-plan.mjs';
import { excludedMigrationSource as excludedSource } from '../../shared/migration-source-scope.mjs';
import { documentFromText, primaryCapabilities } from '../../shared/citadel-core.mjs';
import { deploymentPresentation, sectionNavTitle } from './paramview.mjs';
import { MigrationSnapshots } from './migration-snapshot.mjs';
import { SNAPSHOT_LIMITS } from '../../shared/migration-snapshot.mjs';

export const MIGRATION_AREAS = Object.freeze([
  { id: 'deployment', label: 'Deployments' },
  { id: 'llm-onboarding', label: 'LLM Onboarding' },
  { id: 'access-contracts', label: 'Access Contracts' },
]);

function targetArea(alias) {
  if (alias === MAIN_PATH) return { area: 'deployment', kind: 'Deployment' };
  if (alias === LLM_PATH) return { area: 'llm-onboarding', kind: 'LLM Onboarding' };
  const root = contractRootOf(alias);
  if (root) {
    if (!isContractAlias(alias) || alias.slice(0, alias.lastIndexOf('/')) === root) return null;
    return {
      area: 'access-contracts',
      kind: 'Access Contracts - existing instance',
    };
  }
  return null;
}

const SOURCE_SIGNATURES = [
  { area: 'deployment', names: primaryCapabilities.mainSignature, minimum: primaryCapabilities.mainMinimumParameters },
  { area: 'llm-onboarding', names: primaryCapabilities.llmSignature, minimum: primaryCapabilities.llmSignature.length },
  { area: 'access-contracts', names: primaryCapabilities.accessSignature, minimum: primaryCapabilities.accessMinimumParameters },
];
const LEGACY_DEPLOYMENT_PATH = 'bicep/infra/resources.bicepparam';

function sourcePathArea(alias, using) {
  const path = alias.toLowerCase().replace(/\.json$/, '.bicepparam');
  const known = targetArea(path);
  if (known) return known.area;
  // An older checkout may be nested inside the folder the operator selected.
  if (path.endsWith(`/${MAIN_PATH}`)) return 'deployment';
  if (path.endsWith(`/${LLM_PATH}`)) return 'llm-onboarding';
  // This recognized old layout can predate names in today's capability signature.
  if (path === LEGACY_DEPLOYMENT_PATH || path.endsWith(`/${LEGACY_DEPLOYMENT_PATH}`)) return 'deployment';
  const template = migrationTemplateAlias(alias, using)?.toLowerCase();
  const root = contractRootOf(template);
  if (root && template === `${root}/main.bicep`) return 'access-contracts';
  return null;
}

function signatureAreas(parameters) {
  const names = new Set(parameters.map((parameter) => parameter.name.toLowerCase()));
  return SOURCE_SIGNATURES.filter((signature) => parameters.length >= signature.minimum &&
    signature.names.every((name) => names.has(name.toLowerCase()))).map((signature) => signature.area);
}

function configurationName(alias, area) {
  const leaf = alias.split('/').at(-1).replace(/\.(?:bicepparam|json)$/i, '');
  if (area === 'access-contracts') {
    const root = contractRootOf(alias.toLowerCase());
    const relative = root ? alias.slice(root.length + 1).split('/') : [];
    if (relative.length > 1) return relative.slice(0, -1).join(' / ');
    return `Access contract: ${leaf}`;
  }
  if (area === 'llm-onboarding') return leaf.toLowerCase() === 'main' ? 'LLM backend onboarding' : `LLM onboarding: ${leaf}`;
  return leaf.toLowerCase() === 'main' ? 'Main deployment' : `Deployment: ${leaf}`;
}

function parameterSections(target, model) {
  const doc = documentFromText(target.alias, target.text);
  // Share editor grouping, but never hide migration choices behind feature flags.
  const sections = deploymentPresentation(doc, { pendingFor: () => false, paramValue: () => undefined });
  const remaining = new Map(model.rows.filter((row) => !row.removed).map((row) => [row.name.toLowerCase(), row]));
  const take = (names) => names.flatMap((name) => {
    const key = name.toLowerCase();
    const row = remaining.get(key);
    if (!row) return [];
    remaining.delete(key);
    return [row.id];
  });
  const result = sections.flatMap((section, index) => {
    const groups = (section.groups?.length ? section.groups : [{ label: null, params: section.params }])
      .map((group) => ({ label: group.label ? safeLabel(group.label) : null, rowIds: take(group.params) }))
      .filter((group) => group.rowIds.length);
    const rest = take(section.params);
    if (rest.length) groups.push({ label: null, rowIds: rest });
    const label = safeLabel(sectionNavTitle(section.title));
    return groups.length ? [{
      id: `target-section-${index}`, title: label, label, groups,
    }] : [];
  });
  if (remaining.size) result.push({
    id: 'other-parameters', title: 'Other parameters', label: 'Other',
    groups: [{ label: null, rowIds: [...remaining.values()].map((row) => row.id) }],
  });
  return result;
}

const identities = new WeakMap();
function identity(object) {
  if (!identities.has(object)) identities.set(object, globalThis.crypto.randomUUID());
  return identities.get(object);
}

function contextKey(context) {
  const source = environmentSourceOf(context.environment);
  return JSON.stringify({
    project: context.projectId,
    environment: context.environment.id,
    label: context.environment.label,
    source,
    provider: identity(context.provider),
    root: context.provider.root ? identity(context.provider.root) : null,
  });
}

function fingerprint(file) {
  return file ? { hash: file.hash, size: file.size, version: file.version || file.hash } : null;
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function remoteIdentity(snapshot) {
  return {
    repositoryId: snapshot.repositoryId ?? snapshot.repository?.id ?? snapshot.repository?.repositoryId ?? null,
    fullName: snapshot.fullName ?? snapshot.repository?.fullName ?? null,
    branch: snapshot.branch ?? snapshot.workingBranch ?? null,
    head: snapshot.head,
  };
}

/** Discovery is migration-specific; it does not widen normal editor discovery. */
export async function discoverMigrationTargets(provider) {
  const entries = await provider.entries();
  const targets = [];
  for (const entry of entries) {
    let alias;
    try { alias = migrationTargetAlias(entry.alias); } catch { continue; }
    if (sourceExtension(alias) !== '.bicepparam') continue;
    const area = targetArea(alias);
    if (!area) continue;
    let template = null;
    let state = 'unresolved';
    let parameterNames = [];
    try {
      const source = await provider.read(alias);
      if (source.size > MIGRATION_LIMITS.bytes) throw new MigrationError('limit');
      const parsed = readBicepParameters(source.text, { target: true });
      parameterNames = parsed.parameters.map((parameter) => parameter.name);
      template = migrationTemplateAlias(alias, parsed.using);
      state = template && entries.some((file) => file.alias === template) ? 'available' : 'unresolved';
    } catch {
      // A malformed file is visible, without disclosing its contents in errors.
    }
    targets.push({ alias, label: safeLabel(alias), name: configurationName(alias, area.area), ...area, template, state, parameterNames });
  }
  return targets.sort((left, right) => left.alias.localeCompare(right.alias));
}

/**
 * One ephemeral wizard, one captured current destination, one explicit target.
 * All mutable bytes/decisions are private. Only sanitized projections leave.
 */
export class MigrationSession {
  #context;
  #key;
  #getContext;
  #registry;
  #pending;
  #coordinator;
  #features;
  #generation = 0;
  #closed = false;
  #plan = null;
  #review = null;
  #applyPromise = null;
  #snapshots;

  constructor({ contextProvider, registry, coordinator, pendingEdits = () => false, validateFeatures = validateMigrationFeatures, projectLabel = 'Project', snapshotRequest }) {
    this.#getContext = contextProvider;
    this.#context = contextProvider();
    this.#key = contextKey(this.#context);
    this.#registry = registry;
    this.#pending = pendingEdits;
    this.#coordinator = coordinator;
    this.#features = validateFeatures;
    this.#snapshots = new MigrationSnapshots({ registry, request: snapshotRequest });
    const source = environmentSourceOf(this.#context.environment);
    const remote = this.#context.provider.remote === true;
    if (!['local', 'github'].includes(source.kind) || remote !== (source.kind === 'github')) {
      throw new MigrationError('identity');
    }
    this.destination = Object.freeze({
      project: safeLabel(projectLabel),
      projectId: this.#context.projectId,
      workspace: safeLabel(this.#context.environment.label),
      workspaceId: this.#context.environment.id,
      providerId: identity(this.#context.provider),
      kind: source.kind,
      remote,
      folder: remote ? null : safeLabel(this.#context.provider.root?.name || source.folderName),
      location: safeLabel(remote ? source.fullName : source.localPath || source.folderName),
      repositoryId: remote ? source.repositoryId : null,
      branch: remote ? safeLabel(source.workingBranch) : null,
      localBranchNote: remote ? null : 'Currently checked-out files only; local branch selection is not available.',
    });
  }

  assertContext() {
    if (this.#closed) throw new MigrationError('closed');
    let current;
    try { current = this.#getContext(); }
    catch { this.invalidate(); throw new MigrationError('stale'); }
    if (current !== this.#context || contextKey(current) !== this.#key) {
      this.invalidate();
      throw new MigrationError('stale');
    }
  }

  forkReview() {
    this.assertContext();
    if (this.#applyPromise) throw new MigrationError('review');
    return new MigrationSession({
      contextProvider: () => { this.assertContext(); return this.#getContext(); },
      registry: this.#registry,
      coordinator: this.#coordinator,
      pendingEdits: this.#pending,
      validateFeatures: this.#features,
      projectLabel: this.destination.project,
      snapshotRequest: this.#snapshots.request,
    });
  }

  preparedSources() { this.assertContext(); return this.#snapshots.list(); }
  deletePreparedSource(id) { this.assertContext(); return this.#snapshots.delete(id); }
  openPreparedSource(id) { this.assertContext(); return this.#snapshots.open(id, this.#context); }

  async prepareSource(donor, { onProgress = () => {} } = {}) {
    this.assertContext();
    const prepared = await this.#snapshots.capture(donor, {
      destination: this.#context,
      discover: (reader, options) => this.inventory(reader, options),
      onProgress,
    });
    this.assertContext();
    return prepared;
  }

  async #assertEditor(alias) {
    this.assertContext();
    if (this.#pending()) throw new MigrationError('pending');
    if (alias && await this.#registry?.getDraft(this.#context.environment.id, alias)) throw new MigrationError('pending');
    this.assertContext();
  }

  #assertGeneration(generation) {
    this.assertContext();
    if (generation !== this.#generation) throw new MigrationError('stale');
  }

  invalidate() {
    this.#generation += 1;
    this.#plan = null;
    this.#review = null;
  }

  close() {
    if (this.#applyPromise) return false;
    this.invalidate();
    this.#closed = true;
    return true;
  }

  async #remoteSnapshot() {
    if (!this.destination.remote) return null;
    const snapshot = remoteIdentity(await this.#context.provider.tree({ refresh: true }));
    this.assertContext();
    const source = environmentSourceOf(this.#context.environment);
    if (!snapshot.head ||
        (snapshot.branch && snapshot.branch !== source.workingBranch) ||
        (snapshot.fullName && snapshot.fullName.toLowerCase() !== source.fullName.toLowerCase()) ||
        (snapshot.repositoryId !== null && String(snapshot.repositoryId) !== String(source.repositoryId))) {
      throw new MigrationError('stale');
    }
    return { ...snapshot, branch: snapshot.branch || source.workingBranch, repositoryId: snapshot.repositoryId ?? source.repositoryId };
  }

  async #readTarget(alias, optional = false) {
    try {
      migrationTargetAlias(alias);
      const file = await this.#context.provider.read(alias);
      const bytes = file.bytes || new TextEncoder().encode(file.text);
      if (file.size > MIGRATION_LIMITS.bytes || bytes.byteLength > MIGRATION_LIMITS.bytes) throw new MigrationError('limit');
      const hash = await sha256(bytes);
      if (file.hash !== hash) throw new MigrationError('stale');
      const handle = this.destination.remote ? null : await this.#context.provider.fileHandle(alias, { create: false });
      return {
        alias, bytes, hash, handle,
        size: bytes.byteLength, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        version: file.version || hash,
        bom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
      };
    } catch (error) {
      if (optional && error?.name === 'NotFoundError') return null;
      if (error instanceof MigrationError) throw error;
      if (error?.code === 'SOURCE_TOO_LARGE') throw new MigrationError('limit');
      throw new MigrationError('target-unavailable');
    }
  }

  async targets() {
    const generation = this.#generation;
    await this.#assertEditor();
    await this.#remoteSnapshot();
    const targets = await discoverMigrationTargets(this.#context.provider);
    this.#assertGeneration(generation);
    return targets;
  }

  async inventory(donor, { onProgress = () => {}, maxBytes = donor.snapshot ? SNAPSHOT_LIMITS.snapshotBytes : MIGRATION_LIMITS.totalBytes } = {}) {
    const generation = this.#generation;
    await this.#assertEditor();
    const entries = await donor.entries();
    const candidates = entries.filter((entry) => ['bicepparam', 'json'].includes(entry.format) && !excludedSource(entry.alias));
    // Discovery now reads source values, so prove separation before the first read.
    await donor.assertDistinct(this.#context, candidates.map((entry) => entry.id));
    this.#assertGeneration(generation);
    const items = [];
    const unassigned = [];
    const otherFiles = [];
    const issues = [];
    let ignored = entries.filter((entry) => ['bicepparam', 'json'].includes(entry.format)).length - candidates.length;
    let bytes = 0;
    let completed = 0;
    for (const entry of candidates) {
      if (entry.format === 'json' && typeof donor.inspectJsonCandidate === 'function') {
        const inspection = await donor.inspectJsonCandidate(entry.id);
        this.#assertGeneration(generation);
        if (inspection.kind !== 'parameters') {
          if (inspection.kind === 'invalid') {
            issues.push({ file: safeLabel(entry.alias), reason: migrationMessage(new MigrationError(inspection.code)) });
          } else {
            ignored += 1;
          }
          completed += 1;
          onProgress({ completed, total: candidates.length });
          this.#assertGeneration(generation);
          continue;
        }
      }
      const source = await donor.read(entry.id);
      bytes += source.size;
      if (bytes > maxBytes) throw new MigrationError('limit');
      this.#assertGeneration(generation);
      let parsed;
      try {
        parsed = entry.format === 'json' ? readArmParameters(source.text) : readBicepParameters(source.text);
      } catch (error) {
        if (!(error instanceof MigrationError) || !['format', 'envelope', 'json-duplicate'].includes(error.code)) throw error;
        issues.push({ file: safeLabel(entry.alias), reason: migrationMessage(error) });
      }
      if (parsed) {
        const pathArea = sourcePathArea(entry.alias, parsed.using);
        const signatures = signatureAreas(parsed.parameters);
        // Access signatures also describe reusable templates. An instance needs
        // its contract layout or a reference to the known contract template.
        const area = pathArea || (signatures.length === 1 && signatures[0] !== 'access-contracts' ? signatures[0] : null);
        if (!parsed.parameters.length) {
          issues.push({ file: safeLabel(entry.alias), reason: 'No parameter assignments were found.' });
        } else if (signatures.length > 1 || pathArea && signatures.length && !signatures.includes(pathArea)) {
          issues.push({ file: safeLabel(entry.alias), reason: 'The configuration area is ambiguous. Check the source path and parameter declarations.' });
        } else if (area) {
          items.push({
            ...entry, area, name: configurationName(entry.alias, area),
            parameters: parsed.parameters.length,
            dynamic: parsed.parameters.filter((parameter) => parameter.status === 'dynamic').length,
          });
        } else if (donor.kind === 'local-files') {
          // A loose selected file has no repository path. Its area is an explicit
          // operator choice, never guessed from a common name such as "main".
          unassigned.push({ ...entry, name: safeLabel(entry.alias), parameters: parsed.parameters.length,
            names: parsed.parameters.map((parameter) => parameter.name) });
        } else {
          otherFiles.push({ ...entry, name: safeLabel(entry.alias), parameters: parsed.parameters.length,
            names: parsed.parameters.map((parameter) => parameter.name) });
        }
      }
      completed += 1;
      onProgress({ completed, total: candidates.length });
      this.#assertGeneration(generation);
    }
    const captured = donor.acquisitionFacts?.();
    return {
      items, unassigned, otherFiles,
      issues: [...issues, ...(captured?.issues || [])],
      ignored: ignored + (captured?.ignored || 0),
    };
  }

  async plan({ donor, sourceIds, targetAlias }) {
    if (this.#applyPromise) throw new MigrationError('review');
    this.invalidate();
    const generation = this.#generation;
    await this.#assertEditor(targetAlias);
    if (!donor || !sourceIds?.length || sourceIds.length > MIGRATION_LIMITS.files || new Set(sourceIds).size !== sourceIds.length) {
      throw new MigrationError('scope');
    }
    targetAlias = migrationTargetAlias(targetAlias);
    if (sourceExtension(targetAlias) !== '.bicepparam' || !targetArea(targetAlias)) throw new MigrationError('scope');
    const remote = await this.#remoteSnapshot();
    const entries = await this.#context.provider.entries();
    if (!entries.some((entry) => entry.alias === targetAlias)) throw new MigrationError('scope');
    const donorEntries = await donor.entries();
    const donorRevision = donor.provenance?.() || null;
    if (sourceIds.some((id) => !donorEntries.some((entry) => entry.id === id && ['bicepparam', 'json'].includes(entry.format)))) {
      throw new MigrationError('scope');
    }
    // Prove roots/selections are distinct BEFORE reading donor contents.
    await donor.assertDistinct(this.#context, sourceIds, [targetAlias]);
    const target = await this.#readTarget(targetAlias);
    const parsed = readBicepParameters(target.text, { target: true });
    const schemaAlias = migrationTemplateAlias(targetAlias, parsed.using);
    const template = schemaAlias ? await this.#readTarget(schemaAlias, true) : null;
    const sources = [];
    const inputFingerprints = [];
    let size = target.size + (template?.size || 0);
    for (const id of sourceIds) {
      const source = await donor.read(id);
      const format = donorEntries.find((entry) => entry.id === id).format;
      const parameters = format === 'json' ? readArmParameters(source.text) : readBicepParameters(source.text);
      const donorTemplate = await donor.template(source, parameters.using);
      size += source.size + (donorTemplate.source?.size || 0);
      if (size > MIGRATION_LIMITS.totalBytes) throw new MigrationError('limit');
      sources.push({ id, alias: source.alias, text: source.text, format, schemaText: donorTemplate.source?.text ?? null });
      inputFingerprints.push({
        id, alias: source.alias, handle: source.handle, fingerprint: fingerprint(source),
        template: {
          id: donorTemplate.id, alias: donorTemplate.alias,
          handle: donorTemplate.source?.handle || null,
          fingerprint: fingerprint(donorTemplate.source),
          using: parameters.using,
        },
      });
    }
    const sourceHandles = [...new Set([
      ...sourceIds, ...inputFingerprints.filter((entry) => entry.template.fingerprint).map((entry) => entry.template.id).filter(Boolean),
    ])];
    await donor.assertDistinct(this.#context, sourceHandles, [targetAlias, schemaAlias]);
    this.#assertGeneration(generation);
    const model = buildMigrationPlan({
      target: { alias: targetAlias, text: target.text, schemaText: template?.text ?? null },
      donors: sources,
      validateCandidate: validateMigrationCandidate,
      llmPolicy: llmMigrationPolicy,
    });
    this.#plan = {
      generation, model, donor, sourceIds: [...sourceIds], sourceHandles,
      inputs: inputFingerprints, target, template, schemaAlias, remote, donorRevision,
      sections: parameterSections(target, model),
    };
    // Recheck at the end as well: a long read must not publish an already stale
    // review when the folder/file/template changed during planning.
    await this.#assertFresh();
    return this.view();
  }

  #requirePlan() {
    this.assertContext();
    if (!this.#plan) throw new MigrationError('review');
    return this.#plan;
  }

  view() {
    const plan = this.#requirePlan();
    return {
      destination: this.destination,
      donor: { id: plan.donor.id, kind: plan.donor.kind, label: plan.donor.label, revision: plan.donorRevision ? { ...plan.donorRevision } : null },
      target: { alias: plan.target.alias, ...targetArea(plan.target.alias), template: plan.schemaAlias, resolved: Boolean(plan.template) },
      pairs: this.#pairReports(plan),
      rows: migrationRows(plan.model),
      sections: structuredClone(plan.sections),
    };
  }

  targetProjection() { return migrationTargetProjection(this.#requirePlan().model); }

  decide(rowId, decision) {
    if (this.#applyPromise) throw new MigrationError('review');
    decideMigration(this.#requirePlan().model, rowId, decision);
    this.#review = null;
    return this.view();
  }

  decideModel(rowId, decision) {
    if (this.#applyPromise) throw new MigrationError('review');
    decideMigrationModel(this.#requirePlan().model, rowId, decision);
    this.#review = null;
    return this.view();
  }

  keepRemaining() {
    if (this.#applyPromise) throw new MigrationError('review');
    const plan = this.#requirePlan();
    keepMigrationRemaining(plan.model);
    this.#review = null;
    return this.view();
  }

  discardChanges() {
    if (this.#applyPromise) throw new MigrationError('review');
    const plan = this.#requirePlan();
    for (const row of plan.model.rows) if (!row.removed) decideMigration(plan.model, row.id, { kind: 'keep' });
    this.#review = null;
    return this.view();
  }

  async #assertFresh() {
    const plan = this.#requirePlan();
    try {
      await this.#assertEditor(plan.target.alias);
      await plan.donor.assertFresh?.(plan.donorRevision);
      const remote = await this.#remoteSnapshot();
      if (!equal(remote, plan.remote)) throw new MigrationError('stale');
      const target = await this.#readTarget(plan.target.alias);
      const template = plan.schemaAlias ? await this.#readTarget(plan.schemaAlias, true) : null;
      if (!equal(fingerprint(target), fingerprint(plan.target)) ||
          !equal(fingerprint(template), fingerprint(plan.template))) throw new MigrationError('stale');
      if (!this.destination.remote) {
        if (!await plan.target.handle.isSameEntry(target.handle) ||
            (template && !await plan.template.handle.isSameEntry(template.handle))) throw new MigrationError('stale');
      }
      await plan.donor.entries();
      await plan.donor.assertDistinct(this.#context, plan.sourceHandles, [plan.target.alias, plan.schemaAlias]);
      for (const input of plan.inputs) {
        await plan.donor.assertSameFile(input.id, input.handle);
        const source = await plan.donor.read(input.id);
        const donorTemplate = await plan.donor.template(source, input.template.using);
        if (!equal(fingerprint(source), input.fingerprint) ||
            donorTemplate.id !== input.template.id ||
            !equal(fingerprint(donorTemplate.source), input.template.fingerprint)) throw new MigrationError('stale');
        if (input.template.handle) await plan.donor.assertSameFile(input.template.id, input.template.handle);
      }
      this.#assertGeneration(plan.generation);
    } catch (error) {
      if (plan.donor.snapshot) {
        // A target/network failure revokes this preview's authority, not the
        // immutable old source or the operator's recorded choices.
        this.#review = null;
        if (error instanceof MigrationError && (error.code.startsWith('snapshot-') ||
            ['pending', 'closed'].includes(error.code))) throw error;
        throw new MigrationError(error.code === 'stale' ? 'target-stale' : 'target-unavailable');
      }
      // Uncaptured readers retain their original short-lived safety contract.
      this.invalidate();
      if (error instanceof MigrationError && (['pending', 'closed'].includes(error.code) ||
          error.code.startsWith('public-') || error.code.startsWith('private-'))) throw error;
      throw new MigrationError('stale');
    }
  }

  #pairReports(plan) {
    return structuredClone(migrationNameReports(plan.model).map((pair) => ({
      ...pair,
      area: targetArea(plan.target.alias).kind,
      source: {
        ...pair.source, kind: plan.donor.kind,
        label: safeLabel(plan.donorRevision?.repository || plan.donor.label),
        revision: plan.donorRevision,
      },
      target: {
        ...this.destination, file: safeLabel(plan.target.alias),
        template: plan.schemaAlias ? safeLabel(plan.schemaAlias) : null, revision: plan.remote,
      },
    })));
  }

  #report(plan, evaluation) {
    return structuredClone({
      format: 'citadel-parameter-migration-report',
      version: 1,
      writeStatus: 'preview-only',
      certification: 'NOT deployment-ready. Name/type matching and bounded current constraints are not legacy semantic compatibility.',
      destination: { ...this.destination, target: safeLabel(plan.target.alias), template: plan.schemaAlias ? safeLabel(plan.schemaAlias) : null, revision: plan.remote },
      donor: { id: plan.donor.id, kind: plan.donor.kind, label: safeLabel(plan.donorRevision?.repository || plan.donor.label), readOnly: true, revision: plan.donorRevision },
      binding: {
        target: fingerprint(plan.target),
        template: fingerprint(plan.template),
        sources: plan.inputs.map((input) => ({
          fileId: input.id, file: safeLabel(input.alias), ...input.fingerprint,
          template: input.template.alias ? { file: safeLabel(input.template.alias), ...input.template.fingerprint } : null,
        })),
      },
      summary: { ...evaluation.summary, proposedEdits: evaluation.summary.copied, copied: 0 },
      classification: evaluation.classification,
      pairs: this.#pairReports(plan),
      rows: evaluation.rows,
      blockers: evaluation.blockers,
      unresolved: evaluation.unresolved,
      unverified: evaluation.unverified,
      localApplyEligible: !this.destination.remote && evaluation.canApply,
      limits: [
        'Sample-based parsing/mapping checks do not establish legacy semantic equivalence or validate transformations.',
        'No renames, resource-output handoffs, defaults evaluation, scripts, branch switching, or deployment are performed.',
        'Bare arrays/objects have only outer-type, decorator, and available current Citadel checks; nested semantics require review.',
        'Draft export omits comments and sensitive/dynamic values. Local apply preserves the untouched destination bytes.',
      ],
    });
  }

  async preview() {
    await this.#assertFresh();
    const plan = this.#requirePlan();
    const evaluation = evaluateMigration(plan.model, this.#features);
    const id = globalThis.crypto.randomUUID();
    this.#review = { id, evaluation, generation: plan.generation };
    return {
      id, report: this.#report(plan, evaluation),
      before: evaluation.beforeProjection, after: evaluation.afterProjection,
      canApply: evaluation.canApply && !this.destination.remote,
      changed: evaluation.changed,
    };
  }

  async previewSelected() {
    this.keepRemaining();
    return this.preview();
  }

  #requireReview(id) {
    const plan = this.#requirePlan();
    if (!id || this.#review?.id !== id || this.#review.generation !== plan.generation) throw new MigrationError('review');
    return { plan, evaluation: this.#review.evaluation };
  }

  async export(id, kind) {
    this.#requireReview(id);
    await this.#assertFresh();
    const { plan, evaluation } = this.#requireReview(id);
    if (!['report', 'draft'].includes(kind)) throw new MigrationError('scope');
    return {
      name: kind === 'report' ? 'citadel-migration-report.json' : 'citadel-migration-draft.bicepparam',
      type: kind === 'report' ? 'application/json' : 'text/plain',
      text: kind === 'report' ? JSON.stringify(this.#report(plan, evaluation), null, 2) : evaluation.draft,
    };
  }

  apply(id, { reviewed = false } = {}) {
    // Set the lock synchronously. Repeated clicks share one operation/receipt.
    if (this.#applyPromise) return this.#applyPromise;
    this.#applyPromise = this.#apply(id, reviewed).finally(() => { this.#applyPromise = null; });
    return this.#applyPromise;
  }

  async #apply(id, reviewed) {
    if (this.destination.remote || this.#context.provider.remote === true ||
        environmentSourceOf(this.#context.environment).kind !== 'local') throw new MigrationError('remote');
    if (!reviewed) throw new MigrationError('review');
    this.#requireReview(id);
    await this.#assertFresh();
    const { plan, evaluation } = this.#requireReview(id);
    if (!evaluation.canApply) throw new MigrationError('blocked');
    const beforeWrite = () => this.#assertFresh();
    try {
      const result = await this.#coordinator.commit([{
        alias: plan.target.alias,
        before: plan.target.bytes, beforeHash: plan.target.hash,
        after: new TextEncoder().encode(`${plan.target.bom ? '\uFEFF' : ''}${evaluation.after}`),
        changed: evaluation.operations.map((operation) => operation.path?.[0] || operation.name),
      }], {
        action: 'parameter-migration',
        context: this.#context,
        validateBeforeWrite: beforeWrite,
      });
      this.invalidate();
      return {
        transactionId: result.transactionId,
        destination: this.destination,
        target: plan.target.alias,
        copied: evaluation.summary.copied,
        changes: evaluation.summary.changeCount,
      };
    } catch (error) {
      this.invalidate();
      if (error instanceof MigrationError) throw error;
      throw new MigrationError('apply-failed');
    }
  }
}
