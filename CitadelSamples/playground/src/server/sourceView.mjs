/**
 * Exact protected-source extraction from the imported notebook.
 *
 * The source text is the byte-for-byte UTF-8 encoding of `cell.source.join('')`.
 * It is never trimmed, formatted, rewritten, or accepted from a caller.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { EXECUTION_PROTOCOL_VERSION, SOURCE_NOTEBOOK } from '../core/types.mjs';

export class SourceViewError extends Error {
  constructor(message, code = 'source-unavailable') {
    super(message);
    this.name = 'SourceViewError';
    this.code = code;
  }
}

export function notebookCellText(cell) {
  if (Array.isArray(cell?.source)) return cell.source.join('');
  return typeof cell?.source === 'string' ? cell.source : '';
}

export function sourceBytes(text) {
  return Buffer.from(text, 'utf8');
}

export function sourceSha256(text) {
  return createHash('sha256').update(sourceBytes(text)).digest('hex');
}

export async function readSampleSource({
  playgroundRoot,
  sample,
  notebook = SOURCE_NOTEBOOK,
  readFileImpl = readFile,
}) {
  if (!sample || !Array.isArray(sample.sourceCells)) {
    throw new SourceViewError('The selected catalogue sample has no source-cell mapping.', 'source-map');
  }
  const notebookPath = resolve(playgroundRoot, '..', notebook.fileName);
  let bytes;
  try {
    bytes = await readFileImpl(notebookPath);
  } catch {
    throw new SourceViewError('The imported notebook could not be read.', 'source-unavailable');
  }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const notebookSha256 = createHash('sha256').update(buffer).digest('hex');
  if (notebookSha256 !== notebook.sha256) {
    throw new SourceViewError(
      'The imported notebook no longer matches its recorded SHA-256. Protected source will not be shown or validated.',
      'source-integrity',
    );
  }

  let document;
  try {
    document = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new SourceViewError('The imported notebook is not valid JSON.', 'source-format');
  }
  if (!Array.isArray(document.cells) || document.cells.length !== notebook.cellCount) {
    throw new SourceViewError('The imported notebook cell count does not match its recorded provenance.', 'source-shape');
  }

  const cells = sample.sourceCells.map((cellIndex) => {
    const cell = document.cells[cellIndex];
    if (!cell || !['markdown', 'code'].includes(cell.cell_type)) {
      throw new SourceViewError(`Notebook cell ${cellIndex} is missing or has an unsupported type.`, 'source-cell');
    }
    const text = notebookCellText(cell);
    const exactBytes = sourceBytes(text);
    return Object.freeze({
      cellIndex,
      cellType: cell.cell_type,
      language: cell.cell_type === 'code' ? 'python' : 'markdown',
      text,
      bytes: exactBytes.length,
      sha256: createHash('sha256').update(exactBytes).digest('hex'),
      editable: false,
      protected: true,
    });
  });

  return Object.freeze({
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    sampleId: sample.id,
    notebook: Object.freeze({
      fileName: notebook.fileName,
      sha256: notebookSha256,
      bytes: buffer.length,
    }),
    protection: Object.freeze({
      editable: false,
      source: 'imported-notebook',
      statement: 'This is exact cited notebook source. It is visible but cannot be edited or supplied by the browser.',
    }),
    parameterZones: parameterZones(sample),
    cells: Object.freeze(cells),
  });
}

function parameterZones(sample) {
  const zones = new Map();
  for (const entry of sample.configurationEntries) {
    const zone = zones.get(entry.requirement) ?? {
      id: entry.requirement,
      title: requirementTitle(entry.requirement),
      fields: [],
    };
    zone.fields.push(
      Object.freeze({
        path: entry.path,
        label: entry.label,
        secret: entry.secret === true,
        blockingWhenBlank: entry.blockingWhenBlank !== false,
      }),
    );
    zones.set(entry.requirement, zone);
  }
  return Object.freeze(
    [...zones.values()].map((zone) =>
      Object.freeze({
        ...zone,
        count: zone.fields.length,
        fields: Object.freeze(zone.fields),
      }),
    ),
  );
}

function requirementTitle(requirement) {
  return (
    {
      mandatory: 'Mandatory',
      conditional: 'Conditional',
      optional: 'Optional / defaulted',
      generated: 'Generated / override',
      secret: 'Secrets',
    }[requirement] ?? requirement
  );
}
