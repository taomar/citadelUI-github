import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { EXECUTION_PROTOCOL_VERSION } from '../src/core/types.mjs';

const SOURCE_PAYLOAD_KEYS = Object.freeze([
  'cells',
  'notebook',
  'parameterZones',
  'protection',
  'protocolVersion',
  'sampleId',
]);
const SOURCE_NOTEBOOK_KEYS = Object.freeze(['bytes', 'fileName', 'sha256']);
const SOURCE_CELL_KEYS = Object.freeze([
  'bytes',
  'cellIndex',
  'cellType',
  'editable',
  'language',
  'protected',
  'sha256',
  'text',
]);
const VALIDATION_KEYS = Object.freeze([
  'artifact',
  'azureContacted',
  'checks',
  'detail',
  'executionContext',
  'liveEvidence',
  'mode',
  'networkContacted',
  'runId',
  'sampleId',
  'scenario',
  'source',
  'sourceEditable',
  'sourceExecuted',
  'state',
  'steps',
  'summary',
  'validation',
  'workspaceRemoved',
]);
const VALIDATION_SOURCE_KEYS = Object.freeze(['cells', 'notebook']);
const VALIDATION_SOURCE_CELL_KEYS = Object.freeze(['bytes', 'cellIndex', 'cellType', 'sha256']);
const ARTIFACT_KEYS = Object.freeze(['bytes', 'fileName', 'mediaType', 'retainedInWorkspace', 'sha256', 'text']);

const ownKeys = (value) => (value && typeof value === 'object' ? Object.keys(value).sort() : []);
const sorted = (values) => [...values].sort((left, right) => String(left).localeCompare(String(right)));
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const byteLength = (text) => Buffer.byteLength(text, 'utf8');

function sourceText(cell) {
  return Array.isArray(cell?.source) ? cell.source.join('') : String(cell?.source ?? '');
}

function languageFor(cell, notebook) {
  if (cell.cell_type !== 'code') return 'markdown';
  return notebook.metadata?.language_info?.name ?? notebook.metadata?.kernelspec?.language ?? 'python';
}

function issue(issues, condition, message) {
  if (!condition) issues.push(message);
}

function exactKeys(issues, value, expected, label) {
  issue(
    issues,
    JSON.stringify(ownKeys(value)) === JSON.stringify(sorted(expected)),
    `${label} keys must be exactly ${sorted(expected).join(', ')}`,
  );
}

export function expectedSourceContract({ sample, notebook, notebookMeta }) {
  if (!sample || !Array.isArray(sample.sourceCells)) throw new TypeError('A sample with sourceCells is required.');
  if (!Array.isArray(notebook?.cells)) throw new TypeError('A parsed notebook is required.');
  if (!notebookMeta?.fileName || !notebookMeta?.sha256 || !Number.isInteger(notebookMeta?.bytes)) {
    throw new TypeError('notebookMeta must include fileName, sha256 and bytes.');
  }

  return {
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    sampleId: sample.id,
    notebook: {
      fileName: notebookMeta.fileName,
      sha256: notebookMeta.sha256,
      bytes: notebookMeta.bytes,
    },
    cells: sample.sourceCells.map((cellIndex) => {
      const cell = notebook.cells[cellIndex];
      if (!cell) throw new RangeError(`${sample.id} cites missing notebook cell ${cellIndex}.`);
      const text = sourceText(cell);
      return {
        cellIndex,
        cellType: cell.cell_type,
        language: languageFor(cell, notebook),
        text,
        bytes: byteLength(text),
        sha256: sha256(text),
        editable: false,
        protected: true,
      };
    }),
  };
}

export function expectedParameterPaths(sample) {
  return sample.configurationEntries.map((entry) => entry.path);
}

export function expectedParameterFields(sample) {
  return sample.configurationEntries.map((entry) => ({
    path: entry.path,
    label: entry.label,
    secret: entry.secret === true,
    blockingWhenBlank: entry.blockingWhenBlank === true,
  }));
}

export function parameterZonePaths(parameterZones) {
  if (!Array.isArray(parameterZones)) return [];
  return parameterZones.flatMap((zone) =>
    Array.isArray(zone?.fields) ? zone.fields.map((field) => field?.path).filter(Boolean) : [],
  );
}

export function validateSourcePayload(payload, expected, declaredFields) {
  const issues = [];
  const expectedFields = new Map(declaredFields.map((field) => [field.path, field]));
  const declaredPaths = [...expectedFields.keys()];
  exactKeys(issues, payload, SOURCE_PAYLOAD_KEYS, 'source response');
  issue(issues, payload?.protocolVersion === expected.protocolVersion, 'source response has the wrong protocol version');
  issue(issues, payload?.sampleId === expected.sampleId, 'source response names the wrong sample');
  exactKeys(issues, payload?.notebook, SOURCE_NOTEBOOK_KEYS, 'source response notebook');
  issue(issues, payload?.protection?.editable === false, 'source response protection.editable must be false');
  issue(issues, Array.isArray(payload?.parameterZones), 'source response parameterZones must be an array');
  issue(issues, Array.isArray(payload?.cells), 'source response cells must be an array');
  issue(
    issues,
    isDeepStrictEqual(payload?.notebook, expected.notebook),
    'source response notebook metadata does not match the imported notebook',
  );

  const actualCells = payload?.cells ?? [];
  issue(issues, actualCells.length === expected.cells.length, 'source response cell count does not match the recipe');
  for (let index = 0; index < Math.min(actualCells.length, expected.cells.length); index += 1) {
    exactKeys(issues, actualCells[index], SOURCE_CELL_KEYS, `source response cell ${index}`);
    issue(
      issues,
      isDeepStrictEqual(actualCells[index], expected.cells[index]),
      `source response cell ${expected.cells[index].cellIndex} is not an exact protected copy`,
    );
  }

  for (const [zoneIndex, zone] of (payload?.parameterZones ?? []).entries()) {
    exactKeys(issues, zone, ['count', 'fields', 'id', 'title'], `parameter zone ${zoneIndex}`);
    issue(issues, typeof zone?.id === 'string' && zone.id.length > 0, `parameter zone ${zoneIndex} id must be a non-empty string`);
    issue(issues, typeof zone?.title === 'string' && zone.title.length > 0, `parameter zone ${zoneIndex} title must be a non-empty string`);
    issue(issues, Number.isInteger(zone?.count) && zone.count >= 0, `parameter zone ${zoneIndex} count must be a non-negative integer`);
    issue(issues, Array.isArray(zone?.fields), `parameter zone ${zoneIndex} fields must be an array`);
    issue(issues, zone?.count === zone?.fields?.length, `parameter zone ${zoneIndex} count does not match its fields`);
    for (const [fieldIndex, field] of (zone?.fields ?? []).entries()) {
      exactKeys(
        issues,
        field,
        ['blockingWhenBlank', 'label', 'path', 'secret'],
        `parameter zone ${zoneIndex} field ${fieldIndex}`,
      );
      issue(issues, typeof field?.path === 'string' && field.path.length > 0, `parameter zone ${zoneIndex} field ${fieldIndex} path is invalid`);
      issue(issues, typeof field?.label === 'string' && field.label.length > 0, `parameter zone ${zoneIndex} field ${fieldIndex} label is invalid`);
      issue(issues, typeof field?.secret === 'boolean', `parameter zone ${zoneIndex} field ${fieldIndex} secret must be boolean`);
      issue(
        issues,
        typeof field?.blockingWhenBlank === 'boolean',
        `parameter zone ${zoneIndex} field ${fieldIndex} blockingWhenBlank must be boolean`,
      );
      const expectedField = expectedFields.get(field?.path);
      issue(
        issues,
        Boolean(expectedField) && isDeepStrictEqual(field, expectedField),
        `parameter zone field ${field?.path ?? fieldIndex} does not match the catalogue declaration`,
      );
    }
  }

  const zonePaths = parameterZonePaths(payload?.parameterZones);
  issue(issues, new Set(zonePaths).size === zonePaths.length, 'parameter zones contain duplicate paths');
  issue(
    issues,
    JSON.stringify(sorted(zonePaths)) === JSON.stringify(sorted(declaredPaths)),
    'parameter zones must name exactly the recipe configuration paths',
  );
  return issues;
}

export function validateSourceDomSnapshot(snapshot, expectedCells) {
  const issues = [];
  issue(issues, Array.isArray(snapshot), 'source DOM snapshot must be an array');
  issue(issues, snapshot?.length === expectedCells.length, 'source DOM cell count does not match the source response');
  for (let index = 0; index < Math.min(snapshot?.length ?? 0, expectedCells.length); index += 1) {
    const actual = snapshot[index];
    const expected = expectedCells[index];
    issue(issues, actual.cellIndex === expected.cellIndex, `source DOM cell ${index} has the wrong cell index`);
    issue(issues, actual.text === expected.text, `source DOM cell ${expected.cellIndex} does not show exact source text`);
    issue(issues, actual.protected === 'true', `source DOM cell ${expected.cellIndex} is not marked protected`);
    issue(issues, actual.editable === 'false', `source DOM cell ${expected.cellIndex} is not marked non-editable`);
    issue(issues, actual.editableDescendants === 0, `source DOM cell ${expected.cellIndex} contains an editable descendant`);
  }
  return issues;
}

export function validateWritableControls(snapshot, declaredPaths, zonePaths) {
  const issues = [];
  const declared = new Set(declaredPaths);
  const zones = new Set(zonePaths);
  const writablePaths = [];
  for (const control of snapshot) {
    issue(issues, !control.inProtectedSource, `${control.label || control.tag} is writable inside protected source`);
    issue(issues, Boolean(control.path), `${control.label || control.tag} has no data-parameter-path owner`);
    if (!control.path) continue;
    writablePaths.push(control.path);
    issue(issues, declared.has(control.path), `${control.path} is not declared by the recipe`);
    issue(issues, zones.has(control.path), `${control.path} is not declared by the source parameter zones`);
    if (control.secret) {
      issue(issues, control.type === 'password', `${control.path} must use a password control`);
    }
  }
  issue(issues, new Set(writablePaths).size === writablePaths.length, 'a configuration path has multiple writable controls');
  issue(
    issues,
    JSON.stringify(sorted(writablePaths)) === JSON.stringify(sorted(declaredPaths)),
    'the writable controls must match the declared recipe configuration exactly',
  );
  return issues;
}

export function validateValidationPayload(payload, { sampleId, expectedSource }) {
  const issues = [];
  exactKeys(issues, payload, VALIDATION_KEYS, 'validation response');
  issue(issues, payload?.scenario === 'offline-python-source-validation', 'validation scenario is not offline-python-source-validation');
  issue(issues, payload?.sampleId === sampleId, 'validation response names the wrong sample');
  issue(issues, typeof payload?.runId === 'string' && payload.runId.length > 0, 'validation response has no run id');
  issue(issues, ['passed', 'failed', 'blocked', 'cancelled'].includes(payload?.state), 'validation response has an invalid state');
  issue(issues, typeof payload?.summary === 'string' && payload.summary.length > 0, 'validation response has no summary');
  issue(issues, typeof payload?.detail === 'string', 'validation response detail must be a string');
  issue(issues, payload?.mode === 'offline-local', 'validation mode must be offline-local');
  issue(issues, payload?.validation === 'python-compile-only', 'validation kind must be python-compile-only');
  for (const property of ['sourceEditable', 'sourceExecuted', 'azureContacted', 'networkContacted', 'liveEvidence']) {
    issue(issues, payload?.[property] === false, `validation ${property} must be false`);
  }
  issue(issues, payload?.workspaceRemoved === true, 'validation workspace must be removed');
  issue(issues, Array.isArray(payload?.steps), 'validation steps must be an array');
  issue(issues, Array.isArray(payload?.checks), 'validation checks must be an array');
  issue(issues, payload?.executionContext?.kind === 'offline-python', 'validation identity must be offline-python');
  issue(
    issues,
    payload?.executionContext?.executionCredential?.type === 'local-python-parser',
    'validation identity must be the local Python parser',
  );
  issue(
    issues,
    payload?.executionContext?.guarantees?.tokensExposed === false &&
      payload?.executionContext?.guarantees?.credentialsPersisted === false,
    'validation identity must preserve its no-token, no-persistence guarantees',
  );

  exactKeys(issues, payload?.source, VALIDATION_SOURCE_KEYS, 'validation source');
  issue(
    issues,
    isDeepStrictEqual(payload?.source?.notebook, expectedSource.notebook),
    'validation source notebook metadata does not match',
  );
  const sourceCells = payload?.source?.cells ?? [];
  issue(issues, sourceCells.length === expectedSource.cells.length, 'validation source cell count does not match');
  for (let index = 0; index < Math.min(sourceCells.length, expectedSource.cells.length); index += 1) {
    exactKeys(issues, sourceCells[index], VALIDATION_SOURCE_CELL_KEYS, `validation source cell ${index}`);
    const expected = expectedSource.cells[index];
    issue(
      issues,
      isDeepStrictEqual(sourceCells[index], {
          cellIndex: expected.cellIndex,
          cellType: expected.cellType,
          bytes: expected.bytes,
          sha256: expected.sha256,
        }),
      `validation source cell ${expected.cellIndex} metadata does not match`,
    );
  }

  if (payload?.artifact !== null) {
    exactKeys(issues, payload?.artifact, ARTIFACT_KEYS, 'validation artifact');
    issue(issues, payload?.artifact?.retainedInWorkspace === false, 'validation artifact must not be retained in the workspace');
    issue(issues, typeof payload?.artifact?.text === 'string', 'validation artifact text must be inline');
    issue(issues, payload?.artifact?.bytes === byteLength(payload?.artifact?.text ?? ''), 'validation artifact byte count is wrong');
    issue(issues, payload?.artifact?.sha256 === sha256(payload?.artifact?.text ?? ''), 'validation artifact hash is wrong');
  }
  return issues;
}
