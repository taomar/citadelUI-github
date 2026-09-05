/**
 * Catalogue completeness, identity, coverage and provenance.
 *
 * These are the tests that keep the catalogue honest about what it contains
 * and where each recipe came from.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { CATALOGUE, SAMPLES, citedCodeCells, profilesFor } from '../src/catalogue/index.mjs';
import { FOUNDRY_ROLE_DEFINITIONS } from '../src/core/foundryRoles.mjs';
import { FIELD_CLASSIFICATIONS, GROUP_IDS, RISK_LEVELS, SOURCE_NOTEBOOK } from '../src/core/types.mjs';

const NOTEBOOK_URL = new URL('../../citadel-publish-contract-tests.ipynb', import.meta.url);
const PROVENANCE_URL = new URL('../provenance.json', import.meta.url);

test('the catalogue holds exactly 19 recipes', () => {
  assert.equal(SAMPLES.length, 19);
  assert.equal(SAMPLES.length, CATALOGUE.expectedSampleCount);
});

test('every recipe id is unique and kebab-case', () => {
  const ids = SAMPLES.map((sample) => sample.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate sample id');
  for (const id of ids) {
    assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `sample id "${id}" is not kebab-case`);
  }
});

test('every recipe belongs to a declared group and every group is used', () => {
  const used = new Set();
  for (const sample of SAMPLES) {
    assert.ok(GROUP_IDS.includes(sample.group), `${sample.id} has unknown group ${sample.group}`);
    used.add(sample.group);
  }
  assert.deepEqual([...used].sort(), [...GROUP_IDS].sort(), 'a declared group has no recipes');
});

test('the group distribution matches the plan', () => {
  const counts = Object.fromEntries(GROUP_IDS.map((id) => [id, 0]));
  for (const sample of SAMPLES) counts[sample.group] += 1;
  assert.deepEqual(counts, {
    discover: 2,
    prepare: 3,
    'publish-grant': 3,
    exercise: 6,
    observe: 2,
    policy: 2,
    lifecycle: 1,
  });
});

test('the imported notebook is unchanged', async () => {
  const bytes = await readFile(fileURLToPath(NOTEBOOK_URL));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha256, SOURCE_NOTEBOOK.sha256, 'the source notebook has been modified');
  assert.equal(bytes.length, 66241);
});

test('the notebook still has the shape the catalogue assumes', async () => {
  const notebook = JSON.parse(await readFile(fileURLToPath(NOTEBOOK_URL), 'utf-8'));
  assert.equal(notebook.cells.length, SOURCE_NOTEBOOK.cellCount);
  const markdown = notebook.cells.filter((cell) => cell.cell_type === 'markdown');
  const code = notebook.cells.filter((cell) => cell.cell_type === 'code');
  assert.equal(markdown.length, SOURCE_NOTEBOOK.markdownCellCount);
  assert.equal(code.length, SOURCE_NOTEBOOK.codeCellCount);
  const codeIndexes = notebook.cells
    .map((cell, index) => (cell.cell_type === 'code' ? index : null))
    .filter((index) => index !== null);
  assert.deepEqual(codeIndexes, [...SOURCE_NOTEBOOK.codeCellIndexes]);
  const outputs = notebook.cells.reduce((sum, cell) => sum + (cell.outputs?.length ?? 0), 0);
  assert.equal(outputs, 0, 'the notebook should carry no saved outputs');
  const attachments = notebook.cells.reduce(
    (sum, cell) => sum + Object.keys(cell.attachments ?? {}).length,
    0,
  );
  assert.equal(attachments, 0);
});

test('every code cell is either a recipe source or a documented non-recipe cell', () => {
  const cited = new Set(citedCodeCells());
  const excused = new Set(CATALOGUE.nonRecipeCodeCells.map((entry) => entry.cell));
  for (const cell of SOURCE_NOTEBOOK.codeCellIndexes) {
    assert.ok(
      cited.has(cell) || excused.has(cell),
      `code cell ${cell} is neither cited by a recipe nor documented as a non-recipe cell`,
    );
  }
  for (const entry of CATALOGUE.nonRecipeCodeCells) {
    assert.ok(entry.reason.length > 40, `non-recipe cell ${entry.cell} needs a real reason`);
    assert.ok(!cited.has(entry.cell), `cell ${entry.cell} is documented as excluded but is also cited`);
  }
});

test('every recipe cites at least one code cell that exists in the notebook', () => {
  for (const sample of SAMPLES) {
    assert.ok(Array.isArray(sample.sourceCells) && sample.sourceCells.length > 0, `${sample.id} cites no cells`);
    const codeCells = sample.sourceCells.filter((cell) => SOURCE_NOTEBOOK.codeCellIndexes.includes(cell));
    assert.ok(codeCells.length > 0, `${sample.id} cites no code cell`);
    for (const cell of sample.sourceCells) {
      assert.ok(cell >= 0 && cell < SOURCE_NOTEBOOK.cellCount, `${sample.id} cites out-of-range cell ${cell}`);
    }
  }
});

test('provenance.json matches the catalogue and the notebook on disk', async () => {
  const provenance = JSON.parse(await readFile(fileURLToPath(PROVENANCE_URL), 'utf-8'));
  const bytes = await readFile(fileURLToPath(NOTEBOOK_URL));
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  assert.equal(provenance.importedFile.sha256, sha256);
  assert.equal(provenance.importedFile.bytes, bytes.length);
  assert.equal(provenance.importedFile.modified, false);
  assert.equal(provenance.sampleCount, SAMPLES.length);
  assert.equal(provenance.notebook.cellCount, SOURCE_NOTEBOOK.cellCount);
  assert.deepEqual(provenance.notebook.codeCellIndexes, [...SOURCE_NOTEBOOK.codeCellIndexes]);

  assert.ok(provenance.upstream.repository);
  assert.ok(provenance.upstream.path);
  assert.ok(provenance.upstream.ref);
  assert.match(provenance.upstream.commit, /^[0-9a-f]{40}$/);
  assert.match(provenance.upstream.gitBlobSha1, /^[0-9a-f]{40}$/);
  assert.ok(provenance.importedAt);

  const mapped = new Map(provenance.sampleToCellMap.map((entry) => [entry.id, entry]));
  assert.equal(mapped.size, SAMPLES.length);
  for (const sample of SAMPLES) {
    const entry = mapped.get(sample.id);
    assert.ok(entry, `provenance has no entry for ${sample.id}`);
    assert.equal(entry.group, sample.group);
    assert.deepEqual(entry.cells, [...sample.sourceCells], `cell map mismatch for ${sample.id}`);
    const codeCells = sample.sourceCells.filter((cell) => SOURCE_NOTEBOOK.codeCellIndexes.includes(cell));
    assert.deepEqual(entry.codeCells, codeCells, `code-cell map mismatch for ${sample.id}`);
  }

  assert.deepEqual(
    provenance.nonRecipeCodeCells.map((entry) => entry.cell).sort(),
    CATALOGUE.nonRecipeCodeCells.map((entry) => entry.cell).sort(),
  );
  assert.deepEqual(
    provenance.excludedScenarios.map((entry) => entry.id).sort(),
    CATALOGUE.excludedScenarios.map((entry) => entry.id).sort(),
  );
});

test('the absent image sample is stated explicitly, not merely missing', () => {
  const image = CATALOGUE.excludedScenarios.find((entry) => entry.id === 'image-generation');
  assert.ok(image, 'the catalogue must state that there is no image sample');
  assert.match(image.reason, /no image or multimodal sample/i);
  const ids = SAMPLES.map((sample) => `${sample.id} ${sample.title}`.toLowerCase()).join(' ');
  for (const forbidden of ['image', 'multimodal', 'dall', 'vision']) {
    assert.ok(!ids.includes(forbidden), `an invented ${forbidden} recipe is present`);
  }
});

test('the five shared profiles exist with classified fields', () => {
  assert.deepEqual(
    CATALOGUE.profiles.map((profile) => profile.id),
    ['hub', 'gatewayAccess', 'foundry', 'keyVault', 'policy'],
  );
  for (const profile of CATALOGUE.profiles) {
    assert.ok(profile.title && profile.summary, `${profile.id} needs a title and a summary`);
    assert.ok(profile.fields.length > 0, `${profile.id} has no fields`);
    for (const field of profile.fields) {
      assert.ok(
        FIELD_CLASSIFICATIONS.includes(field.classification),
        `${profile.id}.${field.name} has classification ${field.classification}`,
      );
      assert.ok(field.label, `${profile.id}.${field.name} needs a label`);
      assert.ok(field.help, `${profile.id}.${field.name} needs help text`);
      assert.ok(field.howToObtain, `${profile.id}.${field.name} needs acquisition guidance`);
      assert.ok(field.notebookRef, `${profile.id}.${field.name} needs a notebook reference`);
      if (field.classification === 'conditional') {
        assert.ok(field.requiredWhen, `${profile.id}.${field.name} is conditional but has no requiredWhen`);
      }
      if (field.classification === 'derived') {
        assert.ok(field.derivedFrom, `${profile.id}.${field.name} is derived but does not say from what`);
      }
    }
  }
});

test('the Foundry role selector advertises only the two reviewed built-in definitions', () => {
  const roleField = CATALOGUE.profileById.get('foundry').fields.find((field) => field.name === 'role');
  assert.equal(roleField.type, 'enum');
  assert.equal(roleField.default, 'Foundry Agent Consumer');
  assert.deepEqual(
    roleField.options,
    [
      { value: 'Foundry Agent Consumer', label: 'Foundry Agent Consumer (least privilege)' },
      { value: 'Azure AI User', label: 'Foundry User (formerly Azure AI User; broader data-plane access)' },
    ],
  );
  assert.deepEqual(
    FOUNDRY_ROLE_DEFINITIONS.map((role) => ({
      selection: role.selection,
      roleDefinitionName: role.roleDefinitionName,
      acceptedRoleDefinitionNames: role.acceptedRoleDefinitionNames,
      roleDefinitionId: role.roleDefinitionId,
    })),
    [
      {
        selection: 'Foundry Agent Consumer',
        roleDefinitionName: 'Foundry Agent Consumer',
        acceptedRoleDefinitionNames: ['Foundry Agent Consumer'],
        roleDefinitionId: 'eed3b665-ab3a-47b6-8f48-c9382fb1dad6',
      },
      {
        selection: 'Azure AI User',
        roleDefinitionName: 'Foundry User',
        acceptedRoleDefinitionNames: ['Foundry User', 'Azure AI User'],
        roleDefinitionId: '53ca6127-db72-4b80-b1b0-d745d6d5456d',
      },
    ],
  );
});

test('every profile a recipe declares exists, and every profile is used somewhere', () => {
  const used = new Set();
  for (const sample of SAMPLES) {
    const profiles = profilesFor(sample);
    assert.ok(profiles.length > 0, `${sample.id} uses no profile`);
    for (const profile of profiles) used.add(profile.id);
  }
  for (const profile of CATALOGUE.profiles) {
    assert.ok(used.has(profile.id), `profile ${profile.id} is never used`);
  }
});

test('exactly one secret field exists and it is the gateway api-key', () => {
  assert.deepEqual([...CATALOGUE.secretFieldPaths], ['gatewayAccess.apiKey']);
});

test('every risk level is one of the declared four and acknowledgement follows from it', () => {
  for (const sample of SAMPLES) {
    assert.ok(RISK_LEVELS.includes(sample.risk.level), `${sample.id} has risk level ${sample.risk.level}`);
    assert.ok(sample.risk.effect, `${sample.id} does not describe its effect`);
    assert.ok(sample.risk.blastRadius, `${sample.id} does not describe its blast radius`);
    assert.ok(sample.risk.reversibility, `${sample.id} does not describe reversibility`);
    const expected =
      sample.risk.level !== 'read-only'
      || ['a2a-message-send', 'agent-framework-hr-question'].includes(sample.id);
    assert.equal(sample.risk.requiresAcknowledgement, expected, `${sample.id} acknowledgement flag is wrong`);
    if (expected) {
      assert.ok(sample.risk.acknowledgementPrompt, `${sample.id} needs an acknowledgement prompt`);
    }
  }
});

test('the risky recipes are exactly the ones expected', () => {
  const risky = SAMPLES.filter((sample) => sample.risk.requiresAcknowledgement).map((sample) => sample.id).sort();
  assert.deepEqual(risky, [
    'a2a-message-send',
    'access-contract-deploy',
    'agent-framework-hr-question',
    'agent-rate-limit-burst',
    'apim-foundry-grant',
    'cleanup',
    'foundry-enable-a2a',
    'publish-assets',
    'tool-rate-limit-burst',
    'weather-api-ensure',
  ]);
  assert.equal(SAMPLES.find((sample) => sample.id === 'cleanup').risk.level, 'destructive');
  for (const id of ['tool-rate-limit-burst', 'agent-rate-limit-burst']) {
    assert.equal(SAMPLES.find((sample) => sample.id === id).risk.level, 'load-generating');
  }
});

test('the cleanup residue is complete and actionable', () => {
  const ids = CATALOGUE.cleanupResidue.map((entry) => entry.id).sort();
  assert.deepEqual(ids, [
    'a2a-enablement',
    'contract-files',
    'deployment-history',
    'kv-secrets',
    'role-assignment',
    'telemetry',
    'weather-api',
  ]);
  for (const entry of CATALOGUE.cleanupResidue) {
    assert.ok(entry.item && entry.origin && entry.consequence && entry.removal, `${entry.id} is under-specified`);
  }
});
