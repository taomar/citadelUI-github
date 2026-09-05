/**
 * Shared contract for the Signed Run Dossier renderers.
 *
 * The primary document is ordered context -> inputs -> review -> output. Source,
 * provenance, and diagnostics are inspectors, not workflow stages. Renderers may
 * add descendants, but these IDs and data attributes are integration seams.
 */

export const DOSSIER_STAGES = Object.freeze(['configure', 'review', 'run', 'result']);

export const DOSSIER_STAGE_LABELS = Object.freeze({
  configure: 'Configure',
  review: 'Review',
  run: 'Run',
  result: 'Result',
});

export const DOSSIER_IDS = Object.freeze({
  shell: 'dossier-shell',
  masthead: 'masthead',
  globalIdentity: 'global-identity',
  recipeDirectory: 'recipe-directory',
  recipeDrawer: 'recipe-drawer',
  dossier: 'run-dossier',
  context: 'dossier-context',
  inputs: 'dossier-inputs',
  review: 'dossier-review',
  output: 'dossier-output',
  ledger: 'run-ledger',
  sourceInspector: 'source-inspector',
  provenanceDrawer: 'provenance-drawer',
  diagnosticsDrawer: 'diagnostics-drawer',
  destructiveDialog: 'destructive-run-dialog',
  liveRegion: 'live',
});

export const DOSSIER_URL = Object.freeze({
  recipeParam: 'recipe',
  runParam: 'run',
  stageHashPrefix: '#stage=',
});

export const DOSSIER_OUTPUT_VIEWS = Object.freeze(['transcript', 'evidence', 'artifacts']);

export const DOSSIER_RENDER_OWNERS = Object.freeze({
  shell: Object.freeze([
    DOSSIER_IDS.masthead,
    DOSSIER_IDS.globalIdentity,
    DOSSIER_IDS.recipeDirectory,
    DOSSIER_IDS.recipeDrawer,
  ]),
  configure: Object.freeze([
    DOSSIER_IDS.context,
    DOSSIER_IDS.inputs,
    DOSSIER_IDS.sourceInspector,
    DOSSIER_IDS.provenanceDrawer,
    DOSSIER_IDS.diagnosticsDrawer,
  ]),
  review: Object.freeze([
    DOSSIER_IDS.review,
    DOSSIER_IDS.ledger,
    DOSSIER_IDS.destructiveDialog,
  ]),
  output: Object.freeze([DOSSIER_IDS.output]),
});

const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export function normalizeDossierStage(value, fallback = DOSSIER_STAGES[0]) {
  const stage = String(value ?? '').trim().toLowerCase();
  return DOSSIER_STAGES.includes(stage) ? stage : fallback;
}

export function parseDossierUrl(
  href,
  { validRecipeIds, defaultRecipeId, defaultStage = DOSSIER_STAGES[0] } = {},
) {
  const url = new URL(href, 'http://localhost/');
  const recipes = validRecipeIds instanceof Set ? validRecipeIds : new Set(validRecipeIds ?? []);
  const requestedRecipe = url.searchParams.get(DOSSIER_URL.recipeParam) ?? '';
  const recipeId = recipes.has(requestedRecipe) ? requestedRecipe : defaultRecipeId;
  const hashValue = url.hash.startsWith(DOSSIER_URL.stageHashPrefix)
    ? url.hash.slice(DOSSIER_URL.stageHashPrefix.length)
    : '';
  const requestedRunId = url.searchParams.get(DOSSIER_URL.runParam) ?? '';

  return Object.freeze({
    recipeId,
    stage: normalizeDossierStage(hashValue, defaultStage),
    runId: RUN_ID_PATTERN.test(requestedRunId) ? requestedRunId : null,
  });
}

export function buildDossierUrl(href, { recipeId, stage, runId = null }) {
  const url = new URL(href, 'http://localhost/');
  url.searchParams.set(DOSSIER_URL.recipeParam, recipeId);
  if (runId && RUN_ID_PATTERN.test(runId)) url.searchParams.set(DOSSIER_URL.runParam, runId);
  else url.searchParams.delete(DOSSIER_URL.runParam);
  url.hash = `${DOSSIER_URL.stageHashPrefix}${normalizeDossierStage(stage)}`;
  return `${url.pathname}${url.search}${url.hash}`;
}

export function stageForRunState({ running = false, resultState = 'not-run' } = {}) {
  if (running) return 'run';
  return resultState && resultState !== 'not-run' ? 'result' : 'review';
}
