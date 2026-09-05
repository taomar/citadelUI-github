/**
 * The generated configuration manifest.
 *
 * This is the artefact a user copies, downloads, archives, or hands to an
 * operator. It answers, for one sample: what it is, which notebook cells it
 * came from, what it needs before it can run, which of those values are still
 * missing, which are secrets, and what the run would generate.
 *
 * Two invariants hold structurally rather than by inspection:
 *
 *   1. A secret VALUE is never written. Secrets appear as an environment
 *      variable name and a `set`/`missing` state, nothing else.
 *   2. Filenames are deterministic and safe: derived from the sample id, which
 *      the catalogue already constrains to kebab-case.
 */

import { EXECUTION_PROTOCOL_VERSION, REQUIREMENT_GROUPS } from './types.mjs';
import { assertNoSecretValues, refToEnvVar } from './secrets.mjs';

/** Kebab-case, dot-free, traversal-free basename for one sample's exports. */
export function configurationFileNames(sampleId) {
  const safe = String(sampleId)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  const base = `citadel-${safe || 'sample'}`;
  return Object.freeze({ base, json: `${base}.config.json`, env: `${base}.env.example` });
}

/**
 * Build the configuration document.
 *
 * @param {object} options
 * @param {object} options.sample     decorated catalogue sample
 * @param {object} options.manifest   from `requirementsFor(sample, read)`
 * @param {object} [options.plan]     the generated plan, when one exists
 * @param {object} [options.capability] per-sample runtime capability
 * @param {object} [options.notebook]  `CATALOGUE.sourceNotebook`
 * @param {boolean} [options.acknowledgementRequired] acknowledgement for this exact configuration
 * @param {Record<string,string>} [options.secrets] live values, for the guard only
 */
export function buildConfigurationDocument({
  sample,
  manifest,
  plan = null,
  capability = null,
  notebook,
  acknowledgementRequired = Boolean(sample.risk.requiresAcknowledgement),
  secrets = {},
}) {
  const document = {
    documentVersion: 1,
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    generatedBy: 'citadel-publish-playground',
    sample: {
      id: sample.id,
      title: sample.title,
      group: sample.group,
      groupTitle: sample.groupTitle,
      summary: sample.summary,
      version: sample.version ?? 1,
    },
    source: {
      notebook: notebook?.fileName ?? '',
      sha256: notebook?.sha256 ?? '',
      cells: [...sample.sourceCells],
      note: sample.sourceNote ?? '',
    },
    requirements: {
      prerequisites: (sample.prerequisites ?? []).map((prerequisite) => ({
        id: prerequisite.id,
        title: prerequisite.title,
        detail: prerequisite.detail,
        howTo: prerequisite.howTo ?? '',
      })),
      runtime: {
        dependencies: [...(sample.runtime?.dependencies ?? [])],
        python: sample.runtime?.python
          ? {
              packages: [...(sample.runtime.python.packages ?? [])],
              modules: [...(sample.runtime.python.modules ?? [])],
              install: sample.runtime.python.install ?? '',
            }
          : null,
        accelerator: [...(sample.runtime?.accelerator ?? [])],
        note: sample.runtime?.note ?? '',
        capability: capability
          ? { state: capability.state, ready: capability.ready, reasons: [...(capability.reasons ?? [])] }
          : null,
      },
    },
    // Public input values, grouped by what the sample needs rather than by
    // where the value came from.
    inputs: groupInputs(manifest),
    // One placeholder per secret. Never a value.
    secrets: manifest.entries
      .filter((entry) => entry.secret)
      .map((entry) => ({
        path: entry.path,
        label: entry.label,
        environmentVariable: refToEnvVar(entry.path),
        required: entry.blockingWhenBlank,
        supplied: entry.supplied,
        reason: entry.reason,
      })),
    risk: {
      level: sample.risk.level,
      effect: sample.risk.effect,
      blastRadius: sample.risk.blastRadius,
      reversibility: sample.risk.reversibility,
      acknowledgementRequired,
      acknowledgementPrompt: sample.risk.acknowledgementPrompt ?? '',
    },
    missing: manifest.blocking.map((entry) => ({
      path: entry.path,
      label: entry.label,
      requirement: entry.requirement,
      why: entry.requirement === 'conditional' ? entry.condition : entry.reason,
    })),
    generates: plan ? describeGenerated(plan) : { available: false, reason: 'No plan yet: required values are missing.' },
  };
  // Second line of defence. The structure above cannot carry a secret value,
  // and this fails loudly if that ever stops being true.
  assertNoSecretValues(document, secrets, 'Configuration document');
  return document;
}

function groupInputs(manifest) {
  const groups = {};
  for (const group of REQUIREMENT_GROUPS) {
    if (group.id === 'secret') continue; // secrets are exported separately
    const entries = manifest.entries.filter((entry) => entry.requirement === group.id);
    if (entries.length === 0) continue;
    groups[group.id] = entries.map((entry) => ({
      path: entry.path,
      label: entry.label,
      type: entry.type,
      value: entry.supplied ? entry.preview : null,
      supplied: entry.supplied,
      reason: entry.reason,
      ...(entry.condition ? { condition: entry.condition, active: entry.conditionActive } : {}),
      ...(entry.fallback ? { fallback: entry.fallback } : {}),
      ...(entry.producedBy ? { producedBy: entry.producedBy } : {}),
    }));
  }
  return groups;
}

/** What a run of this plan would produce, without any credential material. */
function describeGenerated(plan) {
  return {
    available: true,
    planVersion: plan.planVersion,
    stepCount: plan.steps.length,
    stepTypes: [...plan.requiredStepTypes],
    artifacts: plan.steps
      .filter((step) => step.type === 'artifact')
      .map((step) => ({ id: step.id, path: step.artifact?.path ?? '', language: step.artifact?.language ?? '' })),
    commands: plan.steps
      .filter((step) => step.type === 'azure-cli')
      .map((step) => ({ id: step.id, executable: step.command?.executable ?? '', argumentCount: (step.command?.args ?? []).length })),
    requests: plan.steps
      .filter((step) => step.type === 'http')
      .map((step) => ({
        id: step.id,
        method: step.request?.method ?? 'GET',
        url: typeof step.request?.url === 'string' ? step.request.url : '',
        repeat: step.request?.repeat?.count ?? 1,
      })),
    libraries: plan.steps
      .filter((step) => step.type === 'library')
      .map((step) => ({ id: step.id, runtime: step.library?.runtime ?? '', packages: [...(step.library?.packages ?? [])] })),
    assertions: plan.steps.filter((step) => step.type === 'assertion').map((step) => ({ id: step.id, kind: step.assertion?.kind ?? '' })),
    secretReferences: [...plan.secretRefs],
  };
}

/** Stable, human-diffable JSON. */
export function serializeConfiguration(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * The `.env.example` companion: one line per secret the sample needs, with the
 * placeholder left empty. This file is safe to commit, which is the point.
 */
export function buildEnvExample(document) {
  const lines = [
    `# ${document.sample.title} — ${document.sample.id}`,
    '# Environment placeholders for every credential this sample needs.',
    '# Values are deliberately empty: this file is safe to commit.',
    `# Source notebook: ${document.source.notebook}`,
    '',
  ];
  if (document.secrets.length === 0) {
    lines.push('# This sample needs no credential.');
  }
  for (const secret of document.secrets) {
    lines.push(`# ${secret.label} — ${secret.required ? 'required' : 'optional'} for this sample.`);
    lines.push(`# ${secret.reason}`);
    lines.push(`${secret.environmentVariable}=`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
