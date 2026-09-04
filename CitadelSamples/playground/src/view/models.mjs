/**
 * Pure view models.
 *
 * The renderers in `web/js/render/` take these objects and produce DOM. Keeping
 * the decisions here — which group is expanded, which chip a risk gets, whether
 * a result is a pass — means they can be tested in Node without a DOM, and it
 * keeps the renderers to element creation.
 */

import { CATALOGUE, acknowledgementFor, buildSamplePlan, profilesFor, validateSample } from '../catalogue/index.mjs';
import { previewPlan, previewSteps } from '../core/preview.mjs';
import { errorsOf, warningsOf } from '../core/validation.mjs';

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

/** Readiness of one profile for one sample. */
function profileReadiness(profile, read, issues) {
  const fields = profile.fields.map((field) => {
    const path = `${profile.id}.${field.name}`;
    const fieldIssues = issues.filter((issue) => issue.path === path);
    const value = read(path);
    const isSecret = field.classification === 'secret';
    const supplied = isSecret
      ? typeof value === 'string' && value.length > 0
      : !(value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0));
    return {
      path,
      name: field.name,
      label: field.label,
      classification: field.classification,
      supplied,
      errors: fieldIssues.filter((issue) => issue.severity === 'error').map((issue) => issue.message),
      warnings: fieldIssues.filter((issue) => issue.severity === 'warning').map((issue) => issue.message),
    };
  });
  const blocking = fields.filter((field) => field.errors.length > 0);
  return {
    id: profile.id,
    title: profile.title,
    summary: profile.summary,
    fields,
    ready: blocking.length === 0,
    blockingCount: blocking.length,
  };
}

/** The right-hand readiness and provenance rail. */
export function buildContextModel({ sample, read, capability, executionState = 'not-run' }) {
  const validation = validateSample(sample, read);
  const profiles = profilesFor(sample).map((profile) => profileReadiness(profile, read, validation.issues));
  const ownIssues = validation.issues.filter((issue) => issue.path.startsWith(sample.fieldPathPrefix));
  const ownErrors = errorsOf(ownIssues);

  return {
    sampleId: sample.id,
    readiness: {
      ready: validation.satisfied,
      profiles,
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

/** The Configure tab: profile sections plus the sample's own fields. */
export function buildConfigureModel({ sample, read, hasSecret, issues, isTouched = () => true }) {
  const validation = issues ?? validateSample(sample, read).issues;
  const issuesFor = (path) => validation.filter((issue) => issue.path === path);

  const toField = (field, path) => {
    const fieldIssues = issuesFor(path);
    const isSecret = field.classification === 'secret';
    const rawValue = read(path);
    // "Nothing supplied yet" for an ordinary field means empty. For a
    // confirmation checkbox it means the box is not yet ticked: `false` is not
    // blank, but it is equally "the user has not answered this".
    const unanswered = Object.prototype.hasOwnProperty.call(field, 'mustEqual')
      ? rawValue !== field.mustEqual
      : rawValue === undefined || rawValue === null || rawValue === '' ||
        (Array.isArray(rawValue) && rawValue.length === 0);
    const touched = Boolean(isTouched(path));
    const errors = fieldIssues.filter((issue) => issue.severity === 'error').map((issue) => issue.message);
    // An untouched, still-unanswered field states what it needs. A field the
    // user has edited, or one holding a value that does not validate, is an
    // error.
    const pending = !touched && unanswered && errors.length > 0;
    return {
      path,
      name: field.name,
      label: field.label,
      type: field.type,
      classification: field.classification,
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
      secretSet: isSecret ? Boolean(hasSecret?.(path)) : false,
      touched,
      pending,
      needed: pending ? errors : [],
      errors: pending ? [] : errors,
      warnings: fieldIssues.filter((issue) => issue.severity === 'warning').map((issue) => issue.message),
      conditional: Boolean(field.requiredWhen),
    };
  };

  return {
    sampleId: sample.id,
    profiles: profilesFor(sample).map((profile) => ({
      id: profile.id,
      title: profile.title,
      summary: profile.summary,
      sourceCells: profile.sourceCells,
      fields: profile.fields.map((field) => toField(field, `${profile.id}.${field.name}`)),
    })),
    own: {
      title: `${sample.shortTitle ?? sample.title} parameters`,
      fields: sample.fields.map((field) => toField(field, field.path)),
    },
    errorCount: errorsOf(validation).length,
    warningCount: warningsOf(validation).length,
  };
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
export function buildResponseModel({ sample, result, capability }) {
  const state = result?.state ?? 'not-run';
  const badge = stateBadge(state);
  return {
    sampleId: sample.id,
    state,
    badge,
    isSuccessShaped: state === 'completed',
    summary:
      result?.summary ??
      (capability?.canExecute
        ? 'Not run yet. Generate the plan, acknowledge any risk, then run it.'
        : 'Not run. No execution runtime is attached, so nothing has been attempted.'),
    detail: result?.detail ?? capability?.reason ?? '',
    steps: result?.steps ?? [],
    expected: (sample.expectedResults ?? []).map((expected) => ({
      id: expected.id,
      title: expected.title,
      assertion: expected.assertion,
      evidence: expected.evidence,
      status: result?.assertions?.find((assertion) => assertion.id === expected.id)?.status ?? 'not-evaluated',
      statusText:
        result?.assertions?.find((assertion) => assertion.id === expected.id)?.detail ?? expected.whenNotRun ?? 'Not run.',
    })),
    capability,
  };
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
  capability,
}) {
  const validation = validateSample(sample, read);
  const request = buildRequestModel({ sample, read, acknowledged, secrets });
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
      { id: 'configure', label: 'Configure', count: validation.issues.filter((i) => i.severity === 'error').length },
      { id: 'request', label: 'Request' },
      { id: 'response', label: 'Response', state: result?.state ?? 'not-run' },
    ],
    guide: buildGuideModel(sample),
    configure: buildConfigureModel({ sample, read, hasSecret, isTouched, issues: validation.issues }),
    request,
    response: buildResponseModel({ sample, result, capability }),
    context: buildContextModel({ sample, read, capability, executionState: result?.state ?? (request.available ? 'generated' : 'not-run') }),
    canRun: Boolean(request.available && (!request.acknowledgement.required || request.acknowledgement.satisfied)),
    runBlockedReason: !request.available
      ? 'Required inputs are missing.'
      : request.acknowledgement.required && !request.acknowledgement.satisfied
        ? 'Acknowledge the effect of this recipe first.'
        : capability?.canExecute
          ? ''
          : capability?.reason ?? 'No execution runtime is attached.',
  };
}
