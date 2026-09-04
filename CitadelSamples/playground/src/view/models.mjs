/**
 * Pure view models.
 *
 * The renderers in `web/js/render/` take these objects and produce DOM. Keeping
 * the decisions here — which group is expanded, which chip a risk gets, whether
 * a result is a pass — means they can be tested in Node without a DOM, and it
 * keeps the renderers to element creation.
 */

import {
  CATALOGUE,
  acknowledgementFor,
  buildSamplePlan,
  fieldByPath,
  profilesFor,
  requirementsFor,
  validateSample,
} from '../catalogue/index.mjs';
import { previewPlan, previewSteps } from '../core/preview.mjs';
import { errorsOf, warningsOf } from '../core/validation.mjs';
import { buildConfigurationDocument, buildEnvExample, configurationFileNames, serializeConfiguration } from '../core/configuration.mjs';
import { describeSampleCapability } from '../core/capability.mjs';
import { EXECUTION_PROTOCOL_VERSION } from '../core/types.mjs';

const RISK_TONE = Object.freeze({
  'read-only': { tone: 'neutral', label: 'Read-only' },
  'state-changing': { tone: 'warning', label: 'State-changing' },
  'load-generating': { tone: 'warning', label: 'Load-generating' },
  destructive: { tone: 'danger', label: 'Destructive' },
});

const STATE_TONE = Object.freeze({
  'not-run': { tone: 'neutral', label: 'Not run' },
  generated: { tone: 'brand', label: 'Generated' },
  blocked: { tone: 'warning', label: 'Blocked' },
  running: { tone: 'brand', label: 'Running' },
  completed: { tone: 'success', label: 'Completed' },
  failed: { tone: 'danger', label: 'Failed' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
  inconclusive: { tone: 'warning', label: 'Inconclusive' },
});

export function riskBadge(level) {
  return RISK_TONE[level] ?? { tone: 'neutral', label: level ?? 'unknown' };
}

export function stateBadge(state) {
  return STATE_TONE[state] ?? { tone: 'neutral', label: state ?? 'unknown' };
}

export function buildExecutionEnvironmentModel(capability) {
  if (!capability?.canExecute) {
    return {
      mode: 'preview',
      label: 'Preview only',
      evidenceMode: 'offline-validation',
      evidenceLabel: 'Offline validation',
      liveCapable: false,
      detail: 'Plans and protected source can be inspected, but no live Azure operation can run.',
    };
  }

  if (capability.kind === 'relay') {
    return {
      mode: 'hosted-relay',
      label: 'Hosted relay',
      evidenceMode: 'live-capable',
      evidenceLabel: 'Live-capable',
      liveCapable: true,
      detail: 'An approved hosted relay can execute this plan and return live evidence.',
    };
  }
  return {
    mode: 'local-machine',
    label: 'Local machine',
    evidenceMode: 'live-capable',
    evidenceLabel: 'Live-capable',
    liveCapable: true,
    detail: 'The local executor can run this plan from this machine and return live evidence.',
  };
}

function buildResultEnvironmentModel(result, capability) {
  switch (result?.meta?.evidenceClass) {
    case 'offline':
      return {
        mode: 'offline-local',
        label: 'Offline local validation',
        evidenceMode: 'offline-validation',
        evidenceLabel: 'No live evidence',
        liveCapable: false,
        detail: 'This result validates protected local source only. It did not contact Azure or produce live evidence.',
      };
    case 'local-live-capable':
      return buildExecutionEnvironmentModel({ kind: 'local', canExecute: true });
    case 'hosted-relay':
      return buildExecutionEnvironmentModel({ kind: 'relay', canExecute: true });
    case 'preview':
      return buildExecutionEnvironmentModel({ kind: 'unavailable', canExecute: false });
    default:
      return buildExecutionEnvironmentModel(capability);
  }
}

function sourceError(sampleId, message) {
  return {
    sampleId,
    state: 'error',
    protected: true,
    editable: false,
    message,
    notebook: null,
    protection: null,
    parameterZones: [],
    cells: [],
  };
}

/**
 * The protected source contract. Source text is retained byte-for-byte and is
 * never converted into an editable field.
 */
export function buildSourceModel({ sample, sourceState = {} }) {
  const state = sourceState.status ?? 'loading';
  if (state === 'loading' || state === 'idle') {
    return {
      sampleId: sample.id,
      state: 'loading',
      protected: true,
      editable: false,
      message: 'Loading the protected notebook cells cited by this recipe…',
      notebook: null,
      protection: null,
      parameterZones: [],
      cells: [],
    };
  }
  if (state === 'error') {
    return sourceError(sample.id, sourceState.message || 'The protected source could not be loaded.');
  }

  const payload = sourceState.payload;
  const declaredFields = new Map(sample.configurationEntries.map((entry) => [entry.path, entry]));
  const validNotebook =
    payload?.notebook &&
    typeof payload.notebook.fileName === 'string' &&
    payload.notebook.fileName.length > 0 &&
    typeof payload.notebook.sha256 === 'string' &&
    payload.notebook.sha256 === CATALOGUE.sourceNotebook.sha256 &&
    Number.isSafeInteger(payload.notebook.bytes) &&
    payload.notebook.bytes >= 0;
  const validProtection =
    payload?.protection &&
    payload.protection.editable === false &&
    payload.protection.source === 'imported-notebook' &&
    typeof payload.protection.statement === 'string' &&
    payload.protection.statement.length > 0;
  const validCells =
    Array.isArray(payload?.cells) &&
    payload.cells.length > 0 &&
    payload.cells.every(
      (cell) =>
        Number.isSafeInteger(cell?.cellIndex) &&
        sample.sourceCells.includes(cell.cellIndex) &&
        typeof cell.cellType === 'string' &&
        typeof cell.language === 'string' &&
        typeof cell.text === 'string' &&
        Number.isSafeInteger(cell.bytes) &&
        cell.bytes === new TextEncoder().encode(cell.text).byteLength &&
        typeof cell.sha256 === 'string' &&
        /^[a-f0-9]{64}$/i.test(cell.sha256) &&
        cell.editable === false &&
        cell.protected === true,
    );
  const validZones =
    Array.isArray(payload?.parameterZones) &&
    payload.parameterZones.every(
      (zone) =>
        typeof zone?.id === 'string' &&
        typeof zone.title === 'string' &&
        Number.isSafeInteger(zone.count) &&
        Array.isArray(zone.fields) &&
        zone.count === zone.fields.length &&
        zone.fields.every(
          (field) => {
            const declared = declaredFields.get(field?.path);
            return (
              Boolean(declared) &&
              typeof field.label === 'string' &&
              typeof field.secret === 'boolean' &&
              field.secret === Boolean(declared.secret) &&
              typeof field.blockingWhenBlank === 'boolean'
            );
          },
        ),
    );

  if (
    payload?.protocolVersion !== EXECUTION_PROTOCOL_VERSION ||
    payload?.sampleId !== sample.id ||
    !validNotebook ||
    !validProtection ||
    !validCells ||
    !validZones
  ) {
    return sourceError(sample.id, 'The server returned a protected-source response that did not match this recipe.');
  }

  return {
    sampleId: sample.id,
    state: 'ready',
    protected: true,
    editable: false,
    message: '',
    notebook: { ...payload.notebook },
    protection: { ...payload.protection },
    parameterZones: payload.parameterZones.map((zone) => ({
      id: zone.id,
      title: zone.title,
      count: zone.count,
      fields: zone.fields.map((field) => ({ ...field })),
    })),
    cells: payload.cells.map((cell) => ({
      cellIndex: cell.cellIndex,
      cellType: cell.cellType,
      language: cell.language,
      text: cell.text,
      bytes: cell.bytes,
      sha256: cell.sha256,
      editable: false,
      protected: true,
      lineCount: cell.text === '' ? 0 : (cell.text.match(/\n/g)?.length ?? 0) + 1,
    })),
  };
}

export function buildSourceValidationModel(validationState = {}) {
  const status = validationState.status ?? 'not-run';
  const base = {
    available: validationState.available !== false,
    mode: 'offline-local',
    validationMode: 'python-compile-only',
    evidenceLabel: 'Offline validation',
    sourceExecuted: false,
    azureContacted: false,
    networkContacted: false,
    liveEvidence: false,
    checks: [],
    steps: [],
  };
  if (!base.available) {
    return {
      ...base,
      state: 'blocked',
      badge: validationBadge('blocked'),
      summary: 'Start the loopback execute server to compile protected Python cells offline.',
    };
  }
  if (status === 'loading') {
    return { ...base, state: 'running', badge: validationBadge('running'), summary: 'Compiling protected Python cells without executing them…' };
  }
  if (status === 'error') {
    return {
      ...base,
      state: 'failed',
      badge: validationBadge('failed'),
      summary: validationState.message || 'Offline validation could not be completed.',
    };
  }
  if (status !== 'ready') {
    return {
      ...base,
      state: 'not-run',
      badge: validationBadge('not-run'),
      summary: 'Not run. Offline validation compiles protected Python cells; it does not execute source or contact Azure.',
    };
  }

  const result = validationState.result;
  const safeBoundary =
    result?.mode === base.mode &&
    result.validation === base.validationMode &&
    result.sourceExecuted === false &&
    result.azureContacted === false &&
    result.networkContacted === false &&
    result.liveEvidence === false;
  if (!safeBoundary) {
    return {
      ...base,
      state: 'failed',
      badge: validationBadge('failed'),
      summary: 'The validation response did not preserve the offline compile-only boundary.',
    };
  }

  const checkPassed = (check) => check?.passed === true || check?.status === 'passed';
  const state = result.state ?? (result.checks?.every(checkPassed) ? 'passed' : 'failed');
  return {
    ...base,
    state,
    badge: validationBadge(state),
    summary: result.summary ?? 'Offline compile validation finished.',
    checks: (result.checks ?? []).map((check) => ({
      id: String(check.id ?? ''),
      label: String(check.label ?? check.title ?? check.id ?? 'Check'),
      passed: checkPassed(check),
      detail: String(check.detail ?? ''),
    })),
    steps: (result.steps ?? []).map((step) => ({
      id: String(step.id ?? ''),
      title: String(step.title ?? step.id ?? 'Validation step'),
      state: String(step.state ?? (step.passed === false ? 'failed' : 'completed')),
      detail: String(step.detail ?? ''),
    })),
    workspaceRemoved: result.workspaceRemoved === true,
  };
}

function validationBadge(state) {
  if (state === 'passed') return { tone: 'success', label: 'Passed offline' };
  if (state === 'failed') return { tone: 'danger', label: 'Failed offline' };
  if (state === 'blocked') return { tone: 'warning', label: 'Blocked' };
  if (state === 'cancelled') return { tone: 'neutral', label: 'Cancelled' };
  return stateBadge(state);
}

function matchesQuery(sample, query) {
  if (!query) return true;
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    sample.id,
    sample.title,
    sample.shortTitle,
    sample.summary,
    sample.groupTitle,
    sample.risk.level,
    `cell ${sample.sourceCells.join(' cell ')}`,
  ]
    .join(' ')
    .toLowerCase();
  return needle
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

/**
 * The left-hand recipe directory: groups with their matching samples, plus a
 * flat list for the mobile `<select>`.
 */
export function buildDirectoryModel({ query = '', selectedSampleId = null } = {}) {
  const groups = CATALOGUE.groups
    .map((group) => {
      const samples = CATALOGUE.samples
        .filter((sample) => sample.group === group.id && matchesQuery(sample, query))
        .map((sample) => ({
          id: sample.id,
          title: sample.shortTitle ?? sample.title,
          fullTitle: sample.title,
          summary: sample.summary,
          risk: riskBadge(sample.risk.level),
          riskLevel: sample.risk.level,
          cells: sample.sourceCells.filter((cell) => CATALOGUE.sourceNotebook.codeCellIndexes.includes(cell)),
          selected: sample.id === selectedSampleId,
        }));
      return { id: group.id, title: group.title, summary: group.summary, samples, count: samples.length };
    })
    .filter((group) => group.count > 0);

  const total = groups.reduce((sum, group) => sum + group.count, 0);
  return {
    query,
    groups,
    total,
    catalogueTotal: CATALOGUE.samples.length,
    empty: total === 0,
    flat: groups.flatMap((group) => group.samples.map((sample) => ({ ...sample, groupTitle: group.title }))),
  };
}

/** Readiness of one requirement group for one sample. */
function groupReadiness(group) {
  return {
    id: group.id,
    title: group.title,
    count: group.count,
    supplied: group.suppliedCount,
    blocking: group.blockingCount,
  };
}

/** The right-hand readiness and provenance rail. */
export function buildContextModel({ sample, read, hasSecret, capability, sampleCapability = null, executionState = 'not-run' }) {
  const validation = validateSample(sample, read);
  const manifest = requirementsFor(sample, read, { hasSecret });
  const ownIssues = validation.issues.filter((issue) => issue.path.startsWith(sample.fieldPathPrefix));
  const ownErrors = errorsOf(ownIssues);

  return {
    sampleId: sample.id,
    readiness: {
      ready: manifest.satisfied && validation.satisfied,
      groups: manifest.groups.map(groupReadiness),
      blocking: manifest.blocking.map((entry) => ({ path: entry.path, label: entry.label, requirement: entry.requirement })),
      ownErrorCount: ownErrors.length,
      totalErrorCount: errorsOf(validation.issues).length,
      totalWarningCount: warningsOf(validation.issues).length,
    },
    prerequisites: (sample.prerequisites ?? []).map((prerequisite) => ({
      id: prerequisite.id,
      title: prerequisite.title,
      detail: prerequisite.detail,
      howTo: prerequisite.howTo,
      links: prerequisite.links ?? [],
    })),
    risk: { ...sample.risk, badge: riskBadge(sample.risk.level) },
    provenance: {
      notebook: CATALOGUE.sourceNotebook.fileName,
      sha256: CATALOGUE.sourceNotebook.sha256,
      cells: sample.sourceCells,
      codeCells: sample.sourceCells.filter((cell) => CATALOGUE.sourceNotebook.codeCellIndexes.includes(cell)),
      note: sample.sourceNote,
    },
    runtime: sampleCapability
      ? {
          ...sampleCapability,
          badge:
            sampleCapability.state === 'ready'
              ? { tone: 'success', label: 'Local execution ready' }
              : sampleCapability.state === 'partial'
                ? { tone: 'warning', label: 'Missing runtime' }
                : { tone: 'neutral', label: 'Preview only' },
          note: sample.runtime?.note ?? '',
        }
      : null,
    capability: {
      ...capability,
      badge: capability?.canExecute
        ? { tone: 'success', label: 'Attached' }
        : { tone: 'warning', label: 'Not attached' },
    },
    execution: stateBadge(executionState),
  };
}

/** The Guide tab. */
export function buildGuideModel(sample) {
  return {
    id: sample.id,
    title: sample.title,
    summary: sample.summary,
    purpose: sample.purpose,
    explanation: sample.explanation ?? [],
    flow: (sample.flow ?? []).map((entry, index) => ({ index: index + 1, text: entry })),
    prerequisites: (sample.prerequisites ?? []).map((prerequisite) => ({
      ...prerequisite,
      links: prerequisite.links ?? [],
    })),
    risk: { ...sample.risk, badge: riskBadge(sample.risk.level) },
    deviations: sample.deviations ?? [],
    notes: sample.notes ?? [],
    source: { cells: sample.sourceCells, note: sample.sourceNote },
  };
}

/** Where a field lives, phrased for a reader rather than as a path. */
function ownerLabel(owner, sample) {
  if (owner.kind === 'profile') {
    return `${CATALOGUE.profileById.get(owner.id)?.title ?? owner.id} profile`;
  }
  if (owner.kind === 'self') return `${sample.shortTitle ?? sample.title} parameters`;
  const other = CATALOGUE.byId.get(owner.id);
  return `From ${other?.shortTitle ?? other?.title ?? owner.id}`;
}

/**
 * The Configure tab.
 *
 * Grouped by what the sample needs, not by where the value happens to live, and
 * filtered to exactly the fields this sample reads. A field a recipe does not
 * use is not rendered at all.
 */
export function buildConfigureModel({ sample, read, hasSecret, issues, isTouched = () => true, plan = null, capability = null }) {
  const validation = issues ?? validateSample(sample, read).issues;
  const manifest = requirementsFor(sample, read, { hasSecret });
  const issuesFor = (path) => validation.filter((issue) => issue.path === path);

  const toField = (entry) => {
    const field = fieldByPath(entry.path);
    const fieldIssues = issuesFor(entry.path);
    const isSecret = entry.secret;
    const rawValue = read(entry.path);
    // "Nothing supplied yet" for an ordinary field means empty. For a
    // confirmation checkbox it means the box is not yet ticked: `false` is not
    // blank, but it is equally "the user has not answered this".
    const unanswered = Object.prototype.hasOwnProperty.call(field, 'mustEqual')
      ? rawValue !== field.mustEqual
      : rawValue === undefined || rawValue === null || rawValue === '' || (Array.isArray(rawValue) && rawValue.length === 0);
    const touched = Boolean(isTouched(entry.path));
    const errors = fieldIssues.filter((issue) => issue.severity === 'error').map((issue) => issue.message);
    // An untouched, still-unanswered field states what it needs. A field the
    // user has edited, or one holding a value that does not validate, is an
    // error.
    const pending = !touched && unanswered && errors.length > 0;
    return {
      path: entry.path,
      name: field.name,
      label: field.label,
      type: field.type,
      classification: field.classification,
      requirement: entry.requirement,
      requirementReason: entry.reason,
      condition: entry.condition,
      conditionActive: entry.conditionActive,
      fallback: entry.fallback,
      producedBy: entry.producedBy,
      blocking: entry.blocking,
      owner: entry.owner,
      ownerLabel: ownerLabel(entry.owner, sample),
      width: field.width ?? 'id',
      help: field.help,
      howToObtain: field.howToObtain,
      links: field.links ?? [],
      notebookRef: field.notebookRef,
      derivedFrom: field.derivedFrom,
      options: field.options ?? [],
      placeholder: field.placeholder ?? '',
      min: field.min,
      max: field.max,
      mustEqual: field.mustEqual,
      secretNote: field.secretNote,
      // A secret's value never leaves the state module.
      value: isSecret ? '' : rawValue,
      secretSet: isSecret ? Boolean(hasSecret?.(entry.path)) : false,
      touched,
      pending,
      needed: pending ? errors : [],
      errors: pending ? [] : errors,
      warnings: fieldIssues.filter((issue) => issue.severity === 'warning').map((issue) => issue.message),
      conditional: entry.requirement === 'conditional',
    };
  };

  const groups = manifest.groups.map((group) => ({
    id: group.id,
    title: group.title,
    summary: group.summary,
    count: group.count,
    suppliedCount: group.suppliedCount,
    blockingCount: group.blockingCount,
    fields: group.entries.map(toField),
  }));

  const exportBundle = buildExportBundle({ sample, manifest, plan, capability, read, hasSecret });

  return {
    sampleId: sample.id,
    groups,
    counts: manifest.counts,
    blocking: manifest.blocking.map((entry) => ({ path: entry.path, label: entry.label, requirement: entry.requirement })),
    blockingCount: manifest.blocking.length,
    satisfied: manifest.satisfied,
    contractLine: contractLine(manifest),
    exports: exportBundle,
    errorCount: errorsOf(validation).length,
    warningCount: warningsOf(validation).length,
  };
}

/** One line that answers "what does this sample need?" before any scrolling. */
function contractLine(manifest) {
  const parts = [];
  for (const group of manifest.groups) {
    parts.push(`${group.count} ${group.title.toLowerCase()}`);
  }
  const missing = manifest.blocking.length;
  return `${parts.join(' · ')}${missing > 0 ? ` · ${missing} still missing` : ' · nothing missing'}`;
}

/** The copyable/downloadable configuration, built once per render. */
function buildExportBundle({ sample, manifest, plan, capability, read, hasSecret }) {
  const names = configurationFileNames(sample.id);
  const document = buildConfigurationDocument({
    sample,
    manifest,
    plan,
    capability,
    notebook: CATALOGUE.sourceNotebook,
    // The guard runs over the finished document; the values themselves are
    // never read into it.
    secrets: collectSecretValuesForGuard(sample, read, hasSecret),
  });
  return {
    fileNames: names,
    document,
    json: serializeConfiguration(document),
    env: buildEnvExample(document),
    secretCount: document.secrets.length,
  };
}

/**
 * The live secret values, used ONLY as the argument to `assertNoSecretValues`.
 * Nothing downstream of this call receives them.
 */
function collectSecretValuesForGuard(sample, read, hasSecret) {
  const values = {};
  for (const entry of sample.configurationEntries) {
    if (!entry.secret) continue;
    if (hasSecret?.(entry.path)) {
      const value = read(entry.path);
      if (typeof value === 'string' && value.length > 0) values[entry.path] = value;
    }
  }
  return values;
}

/** The Request tab. */
export function buildRequestModel({ sample, read, acknowledged = false, secrets = {} }) {
  const { plan, validation } = buildSamplePlan(sample, read);
  const acknowledgement = acknowledgementFor(sample, acknowledged);
  if (!plan) {
    return {
      sampleId: sample.id,
      available: false,
      reason: 'Complete the required inputs before a plan can be generated.',
      errors: errorsOf(validation.issues).map((issue) => ({ path: issue.path, message: issue.message })),
      acknowledgement,
    };
  }
  return {
    sampleId: sample.id,
    available: true,
    plan,
    steps: previewSteps(plan, { secrets }),
    fullText: previewPlan(plan, { secrets }),
    secretRefs: plan.secretRefs,
    requiredStepTypes: plan.requiredStepTypes,
    deviations: plan.deviations,
    notes: plan.notes,
    acknowledgement,
    errors: [],
  };
}

/** The Response tab. */
export function buildResponseModel({ sample, result, capability, running = false, runId = null }) {
  const state = running ? 'running' : (result?.state ?? 'not-run');
  const badge = stateBadge(state);
  const environment = buildResultEnvironmentModel(result, capability);
  const steps = (result?.steps ?? []).map((step) => ({
    ...step,
    badge: stateBadge(step.state === 'skipped' ? 'not-run' : step.state),
    evidenceLines: describeEvidence(step.evidence),
  }));
  return {
    sampleId: sample.id,
    state,
    badge,
    running,
    runId,
    isSuccessShaped: state === 'completed',
    summary:
      result?.summary ??
      (running
        ? 'Running. Each step reports as it finishes.'
        : capability?.canExecute
          ? 'Not run yet. Complete the configuration, acknowledge any risk, then run it.'
          : 'Not run. No execution runtime is attached, so nothing has been attempted.'),
    detail: result?.detail ?? capability?.reason ?? '',
    steps,
    artifacts: result?.meta?.artifacts ?? [],
    configurationUpdates: Object.entries(result?.configurationUpdates ?? {}).map(([path, value]) => ({
      path,
      label: fieldByPath(path)?.label ?? path,
      value: Array.isArray(value) ? value.join(', ') : String(value),
    })),
    // Presence only. A value is never rendered.
    secretUpdateCount: Object.keys(result?.secretUpdates ?? {}).length,
    expected: (sample.expectedResults ?? []).map((expected) => ({
      id: expected.id,
      title: expected.title,
      assertion: expected.assertion,
      evidence: expected.evidence,
      status: result?.assertions?.find((assertion) => assertion.id === expected.id)?.status ?? 'not-evaluated',
      statusText:
        result?.assertions?.find((assertion) => assertion.id === expected.id)?.detail ?? expected.whenNotRun ?? 'Not run.',
    })),
    assertions: (result?.assertions ?? []).map((assertion) => ({
      ...assertion,
      badge:
        assertion.status === 'passed'
          ? { tone: 'success', label: 'pass' }
          : assertion.status === 'failed'
            ? { tone: 'danger', label: 'fail' }
            : { tone: 'warning', label: 'inconclusive' },
    })),
    capability,
    environment,
  };
}

/** Flatten a step's evidence into readable lines. Never a credential. */
function describeEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return [];
  return Object.entries(evidence).map(([key, value]) => ({
    key,
    value:
      value === null || value === undefined
        ? '—'
        : typeof value === 'object'
          ? JSON.stringify(value).slice(0, 400)
          : String(value).slice(0, 400),
  }));
}

/** The complete workbench model for one selected sample. */
export function buildWorkbenchModel({
  sample,
  read,
  hasSecret,
  isTouched,
  secrets = {},
  activeTab = 'guide',
  acknowledged = false,
  result = null,
  running = false,
  runId = null,
  capability,
  runtimeProbe = {},
  sourceState = {},
  sourceValidationState = {},
}) {
  const validation = validateSample(sample, read);
  const request = buildRequestModel({ sample, read, acknowledged, secrets });
  const sampleCapability = describeSampleCapability(sample, runtimeProbe);
  const configure = buildConfigureModel({
    sample,
    read,
    hasSecret,
    isTouched,
    issues: validation.issues,
    plan: request.available ? request.plan : null,
    capability: sampleCapability,
  });

  // Run is blocked for exactly one reason at a time, and the reason is the
  // first thing the user can act on.
  const blockedReason = !configure.satisfied
    ? `${configure.blockingCount} required value${configure.blockingCount === 1 ? '' : 's'} still missing: ${configure.blocking
        .map((entry) => entry.label)
        .join(', ')}.`
    : !request.available
      ? 'The configuration does not validate yet.'
      : request.acknowledgement.required && !request.acknowledgement.satisfied
        ? 'Acknowledge the effect of this recipe first.'
        : !sampleCapability.ready
          ? sampleCapability.reasons[0]
          : '';

  return {
    sample: {
      id: sample.id,
      title: sample.title,
      shortTitle: sample.shortTitle ?? sample.title,
      summary: sample.summary,
      group: sample.group,
      groupTitle: sample.groupTitle,
      risk: { ...sample.risk, badge: riskBadge(sample.risk.level) },
      sourceCells: sample.sourceCells,
    },
    activeTab,
    tabs: [
      { id: 'guide', label: 'Guide' },
      { id: 'code', label: 'Code' },
      { id: 'configure', label: 'Configure', count: configure.blockingCount },
      { id: 'request', label: 'Review & approve' },
      { id: 'response', label: 'Output', state: running ? 'running' : (result?.state ?? 'not-run') },
    ],
    guide: buildGuideModel(sample),
    source: buildSourceModel({ sample, sourceState }),
    sourceValidation: buildSourceValidationModel(sourceValidationState),
    configure,
    request,
    response: buildResponseModel({ sample, result, capability, running, runId }),
    context: buildContextModel({
      sample,
      read,
      hasSecret,
      capability,
      sampleCapability,
      executionState: running ? 'running' : (result?.state ?? (request.available ? 'generated' : 'not-run')),
    }),
    runtime: sampleCapability,
    environment: buildExecutionEnvironmentModel(capability),
    canRun: Boolean(
      configure.satisfied &&
        request.available &&
        (!request.acknowledgement.required || request.acknowledgement.satisfied) &&
        sampleCapability.ready,
    ),
    runBlockedReason: blockedReason,
  };
}
