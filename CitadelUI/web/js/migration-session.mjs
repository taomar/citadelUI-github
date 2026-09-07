import { environmentSourceOf } from './registry.mjs';
import { migrationTargetAlias, migrationTemplateAlias } from './migration-donor.mjs';
import { validateMigrationCandidate, validateMigrationFeatures } from './migration-validation.mjs';
import { buildMigrationPlan, decideMigration, evaluateMigration, migrationNameReports, migrationRows } from '../../shared/parameter-migration.mjs';
import { MigrationError, MIGRATION_LIMITS, readArmParameters, readBicepParameters, safeLabel } from '../../shared/migration-input.mjs';
import { sha256, sourceExtension } from '../../shared/source-scope.mjs';
import { MAIN_PATH, LLM_PATH, contractRootOf, isContractAlias } from '../../shared/source-plan.mjs';

export const MIGRATION_AREAS = Object.freeze([
  { id: 'deployment', label: 'Deployment' },
  { id: 'apim-upgrade', label: 'APIM Upgrade' },
  { id: 'supporting-services', label: 'Supporting Services Upgrade' },
  { id: 'llm-onboarding', label: 'LLM Onboarding' },
  { id: 'access-contracts', label: 'Access Contracts' },
  { id: 'other', label: 'Other parameter files' },
]);

function targetArea(alias) {
  if (alias === MAIN_PATH) return { area: 'deployment', kind: 'Deployment' };
  if (alias === 'bicep/infra/apim-gateway-upgrade/main.bicepparam') return { area: 'apim-upgrade', kind: 'APIM Upgrade' };
  if (alias === 'bicep/infra/apim-gateway-upgrade/supporting-services.bicepparam') return { area: 'supporting-services', kind: 'Supporting Services Upgrade' };
  if (alias === LLM_PATH) return { area: 'llm-onboarding', kind: 'LLM Onboarding' };
  const root = contractRootOf(alias);
  if (root) {
    if (!isContractAlias(alias)) return null;
    return {
      area: 'access-contracts',
      kind: alias === `${root}/main.bicepparam` ? 'Access Contracts - root template' : 'Access Contracts - existing instance',
    };
  }
  return { area: 'other', kind: 'Other parameter file' };
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
    try {
      const source = await provider.read(alias);
      if (source.size > MIGRATION_LIMITS.bytes) throw new MigrationError('limit');
      const parsed = readBicepParameters(source.text, { target: true });
      template = migrationTemplateAlias(alias, parsed.using);
      state = template && entries.some((file) => file.alias === template) ? 'available' : 'unresolved';
    } catch {
      // A malformed file is visible, without disclosing its contents in errors.
    }
    targets.push({ alias, label: safeLabel(alias), ...area, template, state });
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

  constructor({ contextProvider, registry, coordinator, pendingEdits = () => false, validateFeatures = validateMigrationFeatures, projectLabel = 'Project' }) {
    this.#getContext = contextProvider;
    this.#context = contextProvider();
    this.#key = contextKey(this.#context);
    this.#registry = registry;
    this.#pending = pendingEdits;
    this.#coordinator = coordinator;
    this.#features = validateFeatures;
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
      throw new MigrationError('unavailable');
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
    });
    this.#plan = {
      generation, model, donor, sourceIds: [...sourceIds], sourceHandles,
      inputs: inputFingerprints, target, template, schemaAlias, remote, donorRevision,
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
    };
  }

  decide(rowId, decision) {
    if (this.#applyPromise) throw new MigrationError('review');
    decideMigration(this.#requirePlan().model, rowId, decision);
    this.#review = null;
    return this.view();
  }

  keepRemaining() {
    if (this.#applyPromise) throw new MigrationError('review');
    const plan = this.#requirePlan();
    for (const row of plan.model.rows) {
      if (!row.removed && !plan.model.decisions.has(row.id)) decideMigration(plan.model, row.id, { kind: 'keep' });
    }
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
      // Any failed freshness check consumes decisions and review tokens.
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
      };
    } catch (error) {
      this.invalidate();
      if (error instanceof MigrationError) throw error;
      throw new MigrationError('apply-failed');
    }
  }
}
