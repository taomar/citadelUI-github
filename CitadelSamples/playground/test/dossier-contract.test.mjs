import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DOSSIER_IDS,
  DOSSIER_RENDER_OWNERS,
  DOSSIER_STAGES,
  buildDossierUrl,
  normalizeDossierStage,
  parseDossierUrl,
  stageForRunState,
} from '../web/js/render/dossier-contract.mjs';

test('the dossier contract fixes the primary 4-stage journey', () => {
  assert.deepEqual(DOSSIER_STAGES, ['configure', 'review', 'run', 'result']);
  assert.equal(normalizeDossierStage('RESULT'), 'result');
  assert.equal(normalizeDossierStage('source'), 'configure');
});

test('recipe, safe run id, and stage round-trip through the URL', () => {
  const href = buildDossierUrl('https://example.test/playground?unrelated=kept', {
    recipeId: 'cleanup',
    stage: 'review',
    runId: 'run-0001',
  });
  assert.equal(href, '/playground?unrelated=kept&recipe=cleanup&run=run-0001#stage=review');
  assert.deepEqual(
    parseDossierUrl(`https://example.test${href}`, {
      validRecipeIds: new Set(['cleanup']),
      defaultRecipeId: 'cleanup',
    }),
    { recipeId: 'cleanup', stage: 'review', runId: 'run-0001' },
  );
});

test('invalid URL state fails closed to a known recipe and stage', () => {
  assert.deepEqual(
    parseDossierUrl('https://example.test/?recipe=unknown&run=%3Csecret%3E#stage=source', {
      validRecipeIds: ['prepare'],
      defaultRecipeId: 'prepare',
    }),
    { recipeId: 'prepare', stage: 'configure', runId: null },
  );
});

test('run state maps to the contextual dossier stage', () => {
  assert.equal(stageForRunState({ running: true }), 'run');
  assert.equal(stageForRunState({ resultState: 'failed' }), 'result');
  assert.equal(stageForRunState(), 'review');
});

test('renderer ownership contains every integration id exactly once', () => {
  const owned = Object.values(DOSSIER_RENDER_OWNERS).flat();
  assert.equal(new Set(owned).size, owned.length);
  for (const id of Object.values(DOSSIER_IDS)) {
    if ([DOSSIER_IDS.shell, DOSSIER_IDS.dossier, DOSSIER_IDS.liveRegion].includes(id)) continue;
    assert.ok(owned.includes(id), `${id} must have one renderer owner`);
  }
});
