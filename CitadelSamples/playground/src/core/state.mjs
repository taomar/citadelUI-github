/**
 * Playground state.
 *
 * Two stores, deliberately separate:
 *   `values`  — ordinary configuration, dotted paths, safe to serialise
 *   `secrets` — a Map that lives only in this module's closure
 *
 * `toPersistable()` exists so a future "remember my hub" feature cannot be
 * written by accident against the wrong object: it walks the catalogue and
 * drops every field classified as `secret`. Nothing in this application uses a
 * browser storage API, a cookie, or the URL to carry state; a test greps the
 * source tree for those APIs by name to keep it that way.
 */

import { coerceValue } from './validation.mjs';

function readPath(target, path) {
  return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), target);
}

function writePath(target, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let node = target;
  for (const key of keys) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key];
  }
  node[last] = value;
}

/**
 * @param {object} options
 * @param {object} options.catalogue  the loaded catalogue
 */
export function createPlaygroundState({ catalogue }) {
  const values = {};
  const secrets = new Map();
  const acknowledgements = new Map();
  const touched = new Set();
  const listeners = new Set();
  let selectedSampleId = catalogue.samples[0]?.id ?? null;
  let activeTab = 'code';
  let activeStage = 'configure';
  let directoryQuery = '';
  let hasUnsavedChanges = false;

  const secretPaths = new Set(catalogue.secretFieldPaths);

  // Seed sample defaults so the form opens with the notebook's own values.
  for (const [path, value] of Object.entries(catalogue.defaultValues)) {
    if (secretPaths.has(path)) continue;
    writePath(values, path, value);
  }

  function emit(reason) {
    for (const listener of listeners) listener(reason);
  }

  const state = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    get selectedSampleId() {
      return selectedSampleId;
    },

    get activeTab() {
      return activeTab;
    },

    get activeStage() {
      return activeStage;
    },

    get directoryQuery() {
      return directoryQuery;
    },

    get hasUnsavedChanges() {
      return hasUnsavedChanges;
    },

    selectSample(sampleId) {
      if (!catalogue.byId.has(sampleId) || sampleId === selectedSampleId) return;
      selectedSampleId = sampleId;
      activeTab = 'code';
      activeStage = 'configure';
      emit('selection');
    },

    setActiveTab(tab) {
      if (tab === activeTab) return;
      activeTab = tab;
      emit('tab');
    },

    setActiveStage(stage) {
      if (!['configure', 'review', 'run', 'result'].includes(stage) || stage === activeStage) return;
      activeStage = stage;
      emit('stage');
    },

    setDirectoryQuery(query) {
      const next = String(query ?? '');
      if (next === directoryQuery) return;
      directoryQuery = next;
      emit('query');
    },

    /** Read any dotted path, secrets included (used only by the validator). */
    read(path) {
      if (secretPaths.has(path)) return secrets.get(path) ?? '';
      return readPath(values, path);
    },

    /** Non-secret read, safe for previews and view models. */
    readPublic(path) {
      if (secretPaths.has(path)) return secrets.has(path) && secrets.get(path) !== '' ? '(set)' : '';
      return readPath(values, path);
    },

    hasSecret(path) {
      const value = secrets.get(path);
      return typeof value === 'string' && value.length > 0;
    },

    set(path, rawValue, field) {
      const value = field ? coerceValue(field, rawValue) : rawValue;
      touched.add(path);
      hasUnsavedChanges = true;
      if (secretPaths.has(path)) {
        if (typeof value === 'string' && value.length > 0) secrets.set(path, value);
        else secrets.delete(path);
      } else {
        writePath(values, path, value);
      }
      // A configuration change invalidates every prior acknowledgement, so a
      // risky action can never inherit consent given for different inputs.
      if (acknowledgements.size > 0) acknowledgements.clear();
      emit('value');
    },

    markInputsHandled() {
      if (!hasUnsavedChanges) return;
      hasUnsavedChanges = false;
      emit('handled');
    },

    /**
     * Whether the user has interacted with a field.
     *
     * An untouched, empty, required field is "needed", not "wrong": painting
     * every one of them red the moment the page loads reports a mistake the
     * user has not made yet.
     */
    isTouched(path) {
      return touched.has(path);
    },

    markTouched(path) {
      if (touched.has(path)) return;
      touched.add(path);
      emit('touched');
    },

    /** Live secret map for the redaction guards. Never leaves the process. */
    secretValues() {
      return Object.fromEntries(secrets.entries());
    },

    isAcknowledged(sampleId) {
      return acknowledgements.get(sampleId) === true;
    },

    setAcknowledged(sampleId, acknowledged) {
      if (acknowledged) acknowledgements.set(sampleId, true);
      else acknowledgements.delete(sampleId);
      emit('acknowledgement');
    },

    /** Consume the acknowledgement so consent is per-run, not sticky. */
    consumeAcknowledgement(sampleId) {
      const had = acknowledgements.get(sampleId) === true;
      acknowledgements.delete(sampleId);
      if (had) emit('acknowledgement');
      return had;
    },

    /**
     * Serialisable snapshot with every secret removed. Provided for a future
     * feature; the shipped app does not write it anywhere.
     */
    toPersistable() {
      const clone = JSON.parse(JSON.stringify(values));
      for (const path of secretPaths) {
        const keys = path.split('.');
        const last = keys.pop();
        const node = keys.reduce((current, key) => (current == null ? undefined : current[key]), clone);
        if (node && typeof node === 'object') delete node[last];
      }
      return clone;
    },
  };

  return state;
}
