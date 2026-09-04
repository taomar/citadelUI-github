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
      { id: 'configure', label: 'Configure', count: configure.blockingCount },
      { id: 'request', label: 'Request' },
      { id: 'response', label: 'Response', state: running ? 'running' : (result?.state ?? 'not-run') },
    ],
    guide: buildGuideModel(sample),
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
    canRun: Boolean(
      configure.satisfied &&
        request.available &&
        (!request.acknowledgement.required || request.acknowledgement.satisfied) &&
        sampleCapability.ready,
    ),
    runBlockedReason: blockedReason,
  };
}
