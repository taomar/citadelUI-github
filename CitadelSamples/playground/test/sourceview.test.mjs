/**
 * Exact source extraction from the byte-pinned imported notebook.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOGUE } from '../src/catalogue/index.mjs';
import {
  notebookCellText,
  readSampleSource,
  sourceBytes,
  sourceSha256,
  SourceViewError,
} from '../src/server/sourceView.mjs';

const PLAYGROUND_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const NOTEBOOK_PATH = resolve(PLAYGROUND_ROOT, '..', CATALOGUE.sourceNotebook.fileName);

test('source extraction returns the exact cited cell text for all 19 recipes', async () => {
  const notebook = JSON.parse(await readFile(NOTEBOOK_PATH, 'utf8'));
  for (const sample of CATALOGUE.samples) {
    const source = await readSampleSource({ playgroundRoot: PLAYGROUND_ROOT, sample });
    assert.equal(source.sampleId, sample.id);
    assert.equal(source.notebook.sha256, CATALOGUE.sourceNotebook.sha256);
    assert.equal(source.protection.editable, false);
    assert.deepEqual(
      source.cells.map((cell) => cell.cellIndex),
      sample.sourceCells,
    );
    for (const cell of source.cells) {
      const expected = notebookCellText(notebook.cells[cell.cellIndex]);
      assert.equal(cell.text, expected, `${sample.id}/cell ${cell.cellIndex} text changed`);
      assert.equal(cell.bytes, sourceBytes(expected).length, `${sample.id}/cell ${cell.cellIndex} byte count`);
      assert.equal(cell.sha256, sourceSha256(expected), `${sample.id}/cell ${cell.cellIndex} source hash`);
      assert.equal(cell.editable, false);
      assert.equal(cell.protected, true);
    }
  }
});

test('source extraction exposes declared parameter zones without values', async () => {
  const sample = CATALOGUE.byId.get('weather-mcp-discovery');
  const source = await readSampleSource({ playgroundRoot: PLAYGROUND_ROOT, sample });
  const zones = new Map(source.parameterZones.map((zone) => [zone.id, zone]));
  assert.ok(zones.has('conditional'));
  assert.ok(zones.has('optional'));
  assert.ok(zones.has('generated'));
  assert.ok(zones.has('secret'));
  assert.equal(zones.get('secret').fields[0].path, 'gatewayAccess.apiKey');
  assert.equal(JSON.stringify(source.parameterZones).includes('api-key-value'), false);
});

test('source extraction fails closed when notebook bytes or shape drift', async () => {
  const sample = CATALOGUE.samples[0];
  await assert.rejects(
    () =>
      readSampleSource({
        playgroundRoot: PLAYGROUND_ROOT,
        sample,
        readFileImpl: async () => Buffer.from('{}', 'utf8'),
      }),
    (error) => error instanceof SourceViewError && error.code === 'source-integrity',
  );
});

test('source extraction turns file errors into a path-free failure', async () => {
  const privatePath = 'C:\\private-host\\CitadelSamples\\citadel-publish-contract-tests.ipynb';
  await assert.rejects(
    () =>
      readSampleSource({
        playgroundRoot: PLAYGROUND_ROOT,
        sample: CATALOGUE.samples[0],
        readFileImpl: async () => {
          throw new Error(`ENOENT: no such file or directory, open '${privatePath}'`);
        },
      }),
    (error) =>
      error instanceof SourceViewError &&
      error.code === 'source-unavailable' &&
      !error.message.includes('private-host'),
  );
});
