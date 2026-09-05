/** Browser URL adapter for safe dossier navigation state. */

import {
  DOSSIER_STAGES,
  DOSSIER_URL,
  buildDossierUrl,
  normalizeDossierStage,
  parseDossierUrl,
} from './render/dossier-contract.mjs';

const HISTORY_INDEX_KEY = '__citadelDossierIndex';
const UNSAVED_MESSAGE = 'You have unsaved inputs. Leave this recipe stage without saving them?';
const UNSAFE_QUERY_SUFFIXES = Object.freeze([
  'apikey',
  'accesstoken',
  'bearertoken',
  'clientsecret',
  'credential',
  'password',
  'privatekey',
  'refreshtoken',
  'secret',
  'subscriptionkey',
  'token',
]);

function sameState(left, right) {
  return Boolean(
    left
      && right
      && left.recipeId === right.recipeId
      && left.stage === right.stage
      && left.runId === right.runId,
  );
}

function locationPath(href) {
  const url = new URL(href, 'http://localhost/');
  return `${url.pathname}${url.search}${url.hash}`;
}

function keepSafeQuery(path, baseHref, safeQueryKeys) {
  const url = new URL(path, baseHref);
  for (const key of [...url.searchParams.keys()]) {
    if (!safeQueryKeys.has(key)) url.searchParams.delete(key);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function unsafeQueryKey(key) {
  const compact = String(key).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return UNSAFE_QUERY_SUFFIXES.some((suffix) => compact.endsWith(suffix));
}

function historyIndex(state, fallback) {
  const value = state?.[HISTORY_INDEX_KEY];
  return Number.isSafeInteger(value) ? value : fallback;
}

export function createDossierUrlController({
  windowRef = globalThis.window,
  validRecipeIds,
  defaultRecipeId,
  defaultStage = DOSSIER_STAGES[0],
  preserveQueryParams = [],
  hasUnsavedInputs = () => false,
  confirmNavigation,
  onStateChange = () => {},
} = {}) {
  if (!windowRef?.location || !windowRef?.history) {
    throw new TypeError('A browser-like window with location and history is required.');
  }

  const recipes = validRecipeIds instanceof Set
    ? new Set(validRecipeIds)
    : new Set(validRecipeIds ?? []);
  if (recipes.size === 0) throw new TypeError('At least one valid recipe id is required.');
  const safeDefaultRecipeId = recipes.has(defaultRecipeId)
    ? defaultRecipeId
    : recipes.values().next().value;
  const safeDefaultStage = normalizeDossierStage(defaultStage);
  const parseOptions = {
    validRecipeIds: recipes,
    defaultRecipeId: safeDefaultRecipeId,
    defaultStage: safeDefaultStage,
  };
  const preservedKeys = preserveQueryParams == null
    ? []
    : typeof preserveQueryParams === 'string'
      ? [preserveQueryParams]
      : [...preserveQueryParams];
  const safeQueryKeys = new Set([
    DOSSIER_URL.recipeParam,
    DOSSIER_URL.runParam,
    ...preservedKeys
      .map(String)
      .filter((key) => !unsafeQueryKey(key)),
  ]);
  const browserHistory = windowRef.history;
  const askToLeave = confirmNavigation
    ?? ((message) => (typeof windowRef.confirm === 'function' ? windowRef.confirm(message) : true));

  let initialized = false;
  let currentState = null;
  let currentPath = '';
  let currentIndex = 0;
  let restoringToPath = '';

  function parseHref(href) {
    try {
      return parseDossierUrl(href, parseOptions);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return Object.freeze({
        recipeId: safeDefaultRecipeId,
        stage: safeDefaultStage,
        runId: null,
      });
    }
  }

  function buildPath(href, state) {
    try {
      return keepSafeQuery(buildDossierUrl(href, state), href, safeQueryKeys);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return keepSafeQuery(
        buildDossierUrl(windowRef.location.href, state),
        windowRef.location.href,
        safeQueryKeys,
      );
    }
  }

  function resolveInput(input) {
    if (typeof input === 'string' || input instanceof URL) {
      const href = String(input);
      const state = parseHref(href);
      return { state, path: buildPath(href, state) };
    }

    const candidate = {
      recipeId: input?.recipeId,
      stage: input?.stage,
      runId: input?.runId,
    };
    const href = buildDossierUrl(windowRef.location.href, candidate);
    const state = parseHref(href);
    return { state, path: buildPath(windowRef.location.href, state) };
  }

  function notify(state, source) {
    onStateChange(state, Object.freeze({ source }));
  }

  function navigationAllowed(nextState, source) {
    if (!currentState || sameState(currentState, nextState)) return true;
    if (currentState.recipeId === nextState.recipeId) return true;
    if (!hasUnsavedInputs(Object.freeze({ from: currentState, to: nextState, source }))) return true;
    return askToLeave(UNSAVED_MESSAGE, Object.freeze({
      from: currentState,
      to: nextState,
      source,
    })) !== false;
  }

  function accept({ state, path }, source, index = currentIndex) {
    currentState = state;
    currentPath = path;
    currentIndex = index;
    notify(state, source);
    return state;
  }

  function replaceBrowserEntry(path, index = currentIndex) {
    browserHistory.replaceState({ [HISTORY_INDEX_KEY]: index }, '', path);
  }

  function handleExternalNavigation(source, event = {}) {
    const actualPath = locationPath(windowRef.location.href);
    if (restoringToPath) {
      if (actualPath === restoringToPath) restoringToPath = '';
      return;
    }

    const next = resolveInput(windowRef.location.href);
    if (sameState(currentState, next.state) && currentPath === next.path) return;

    const targetIndex = historyIndex(event.state ?? browserHistory.state, currentIndex);
    if (!navigationAllowed(next.state, source)) {
      const delta = currentIndex - targetIndex;
      if (source === 'popstate' && delta !== 0 && typeof browserHistory.go === 'function') {
        restoringToPath = currentPath;
        browserHistory.go(delta);
      } else {
        replaceBrowserEntry(currentPath, currentIndex);
      }
      return;
    }

    if (actualPath !== next.path) replaceBrowserEntry(next.path, targetIndex);
    accept(next, source, targetIndex);
  }

  function handlePopState(event) {
    handleExternalNavigation('popstate', event);
  }

  function handleHashChange(event) {
    handleExternalNavigation('hashchange', event);
  }

  function handleBeforeUnload(event) {
    if (!hasUnsavedInputs(Object.freeze({
      from: currentState,
      to: null,
      source: 'beforeunload',
    }))) return;
    event.preventDefault();
    event.returnValue = '';
  }

  function initialize() {
    if (initialized) return currentState;
    initialized = true;
    const initial = resolveInput(windowRef.location.href);
    currentIndex = historyIndex(browserHistory.state, 0);
    replaceBrowserEntry(initial.path, currentIndex);
    windowRef.addEventListener('popstate', handlePopState);
    windowRef.addEventListener('hashchange', handleHashChange);
    windowRef.addEventListener('beforeunload', handleBeforeUnload);
    return accept(initial, 'initialize', currentIndex);
  }

  function apply(input, { source = 'apply', prompt = true } = {}) {
    if (!initialized) initialize();
    const next = resolveInput(input);
    if (prompt && !navigationAllowed(next.state, source)) return false;
    replaceBrowserEntry(next.path, currentIndex);
    accept(next, source, currentIndex);
    return true;
  }

  function push(input, { source = 'push' } = {}) {
    if (!initialized) initialize();
    const next = resolveInput(input);
    if (!navigationAllowed(next.state, source)) return false;
    if (sameState(currentState, next.state) && currentPath === next.path) return true;
    currentIndex += 1;
    browserHistory.pushState({ [HISTORY_INDEX_KEY]: currentIndex }, '', next.path);
    accept(next, source, currentIndex);
    return true;
  }

  function destroy() {
    if (!initialized) return;
    windowRef.removeEventListener('popstate', handlePopState);
    windowRef.removeEventListener('hashchange', handleHashChange);
    windowRef.removeEventListener('beforeunload', handleBeforeUnload);
    initialized = false;
  }

  return Object.freeze({
    initialize,
    apply,
    push,
    destroy,
    getState: () => currentState,
  });
}
