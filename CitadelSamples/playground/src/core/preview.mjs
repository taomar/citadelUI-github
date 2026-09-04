/**
 * Copy-safe request preview.
 *
 * The Request tab shows the exact operation that would run. Because a plan
 * never holds a secret value, the preview is safe by construction: every
 * credential renders as an environment-variable placeholder. `previewPlan`
 * additionally runs `assertNoSecretValues` so a future regression fails loudly
 * instead of quietly copying a key to the clipboard.
 */

import { assertNoSecretValues, isSecretRef, secretPlaceholder } from './secrets.mjs';

function renderScalar(value) {
  if (isSecretRef(value)) return secretPlaceholder(value);
  if (value === null || value === undefined) return '';
  return String(value);
}

function renderJsonValue(value, indent = 0) {
  const pad = '  '.repeat(indent);
  if (isSecretRef(value)) return JSON.stringify(secretPlaceholder(value));
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item) => `${pad}  ${renderJsonValue(item, indent + 1)}`);
    return `[\n${items.join(',\n')}\n${pad}]`;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  const rendered = entries.map(([key, item]) => `${pad}  ${JSON.stringify(key)}: ${renderJsonValue(item, indent + 1)}`);
  return `{\n${rendered.join(',\n')}\n${pad}}`;
}

function previewHttpStep(step) {
  const request = step.request ?? {};
  const lines = [`${request.method ?? 'GET'} ${renderScalar(request.url)}`];
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    lines.push(`${name}: ${renderScalar(value)}`);
  }
  if (request.body !== undefined && request.body !== null) {
    lines.push('');
    lines.push(typeof request.body === 'string' ? request.body : renderJsonValue(request.body));
  }
  if (request.capture && Object.keys(request.capture).length > 0) {
    lines.push('');
    for (const [output, source] of Object.entries(request.capture)) {
      lines.push(`# capture ${output} <- ${source}`);
    }
  }
  return lines.join('\n');
}

function previewCliStep(step) {
  const command = step.command ?? {};
  const parts = [command.executable ?? 'az', ...(command.args ?? []).map(renderScalar)];
  const rendered = parts
    .map((part) => (/[\s"'<>|&]/.test(part) && !part.startsWith('"') ? JSON.stringify(part) : part))
    .join(' ');
  const lines = [rendered];
  if (command.note) lines.push(`# ${command.note}`);
  return lines.join('\n');
}

function previewArtifactStep(step) {
  const artifact = step.artifact ?? {};
  const lines = [`# file: ${artifact.path}`];
  if (artifact.language) lines.push(`# language: ${artifact.language}`);
  lines.push('');
  lines.push(renderScalar(artifact.content));
  return lines.join('\n');
}

function previewLibraryStep(step) {
  const library = step.library ?? {};
  const lines = [];
  if (library.runtime) lines.push(`# runtime: ${library.runtime}`);
  if (Array.isArray(library.packages) && library.packages.length > 0) {
    lines.push(`# packages: ${library.packages.join(' ')}`);
  }
  if (library.install) lines.push(`# install: ${library.install}`);
  lines.push('');
  lines.push(renderScalar(library.code));
  return lines.join('\n');
}

function previewAssertionStep(step) {
  const assertion = step.assertion ?? {};
  const lines = [`# assertion: ${assertion.kind ?? 'custom'}`];
  for (const expectation of assertion.expectations ?? []) {
    lines.push(`- ${expectation}`);
  }
  if (assertion.source) lines.push(`# evaluated over ${assertion.source}`);
  return lines.join('\n');
}

const RENDERERS = {
  http: previewHttpStep,
  'azure-cli': previewCliStep,
  artifact: previewArtifactStep,
  library: previewLibraryStep,
  assertion: previewAssertionStep,
};

/** Render one step as copy-safe text. */
export function previewStep(step) {
  const renderer = RENDERERS[step.type];
  return renderer ? renderer(step) : '';
}

/**
 * Render a full plan as copy-safe text, with a header naming the placeholders
 * the reader has to export before pasting it into a shell.
 */
export function previewPlan(plan, { secrets = {} } = {}) {
  const blocks = [];
  blocks.push(`# ${plan.title}`);
  blocks.push(`# sample: ${plan.sampleId}  |  notebook cells: ${plan.sourceCells.join(', ')}`);
  blocks.push(`# risk: ${plan.risk?.level ?? 'unknown'}`);
  if (plan.secretRefs.length > 0) {
    blocks.push('#');
    blocks.push('# Secrets are never written into this preview. Export these before running:');
    for (const ref of plan.secretRefs) {
      blocks.push(`#   ${secretPlaceholder(ref)}  ->  ${ref}`);
    }
  }
  for (const [index, planStep] of plan.steps.entries()) {
    blocks.push('');
    blocks.push(`# ---- step ${index + 1}/${plan.steps.length}: ${planStep.title} (${planStep.type}) ----`);
    const rendered = previewStep(planStep);
    if (rendered) blocks.push(rendered);
  }
  const text = blocks.join('\n');
  assertNoSecretValues(text, secrets, 'Request preview');
  return text;
}

/** Per-step preview records for the Request tab. */
export function previewSteps(plan, { secrets = {} } = {}) {
  return plan.steps.map((planStep, index) => {
    const text = previewStep(planStep);
    assertNoSecretValues(text, secrets, `Step preview ${planStep.id}`);
    return {
      index: index + 1,
      id: planStep.id,
      type: planStep.type,
      title: planStep.title,
      detail: planStep.detail,
      produces: planStep.produces,
      consumes: planStep.consumes,
      text,
    };
  });
}
