import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { loadDialogModule, readText } from '../../_dom-stub.mjs';
import { h, mount } from '../../../web/js/dom.mjs';
import { createDocumentActions } from '../../../web/js/document-action.mjs';
import { createEditorDocumentSession } from '../../../web/js/editor-document-session.mjs';
import { WorkspaceViewState } from '../../../web/js/workspace-view-state.mjs';
import { pauseEditorForLoad } from '../../../web/js/editor-load.mjs';
import { guardedHandler } from '../../../web/js/single-flight.mjs';
import { createEnvironmentOperation } from '../../../web/js/settings-operation.mjs';
import { createEnvironmentForm, createGitHubConnectionSummary, createWorkspaceSettingsView } from '../../../web/js/workspace-settings-view.mjs';
import { environmentLocation, environmentSourceOf, isGitHubEnvironment } from '../../../web/js/registry.mjs';
import { historyEntry } from '../../../web/js/history-entry.mjs';
import { saveStatusLine } from '../../../web/js/save-resolution.mjs';
import { mutationComplete } from '../../../shared/mutation-outcome.mjs';
import { configurationOf } from '../../../shared/workspace-configuration.mjs';
import { previewDocument } from '../../../web/js/preview.mjs';
import * as edits from '../../../web/js/contract-edit-state.mjs';

const app = (await readFile(new URL('../../../web/js/app.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
export function appSection(start, end) {
  const first = app.indexOf(start), last = app.indexOf(end, first);
  assert(first >= 0 && last > first, `Missing production section ${start}`);
  return app.slice(first, last);
}

export function find(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children || []) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}

export function button(root, label) {
  return find(root, node => node.tagName === 'BUTTON' && readText(node) === label);
}

export async function activate(node, type = 'click') {
  assert(node, 'The actual production control must exist');
  assert(!node.disabled, 'The actual production control must be enabled');
  for (const handler of node.listeners.get(type) || []) {
    await handler({type, target:node, currentTarget:node, preventDefault() {}, stopPropagation() {}});
  }
}

export function input(node, value) {
  assert(node && !node.disabled);
  node.focus();
  node.value = value;
  node.dispatch('input', {currentTarget:node});
}

export async function shellHarness({context, api = {}, state:initial = {}, registry = {}} = {}) {
  const dom = await loadDialogModule();
  const adapt = node => {
    node.blur = () => {
      if (document.activeElement === node) document.activeElement = document.body;
      node.dispatch('blur');
    };
    if (node.tagName === 'INPUT') {
      node.validationMessage = '';
      node.setCustomValidity = message => { node.validationMessage = String(message); };
      node.reportValidity = () => {
        node.validityReported = true;
        return !node.validationMessage && !(node.hasAttribute('required') && !node.value);
      };
    }
    return node;
  };
  const createElement = document.createElement;
  document.createElement = tag => adapt(createElement(tag));
  const els = {workspace:dom.node('main'), sidebar:dom.node('nav'), contextRail:dom.node('aside'),
    tbActions:dom.node('header'), shell:dom.node('div'), editorLoading:dom.node('div')};
  Object.values(els).forEach(adapt);
  dom.root.append(...Object.values(els));
  els.editorLoading.hidden = true;
  els.shell.dataset.workspace = 'active';
  context ||= {projectId:'review-project', environment:{id:'review-active', projectId:'review-project', label:'Active',
    permission:'granted', compatibility:'supported', source:{kind:'local', folderName:'synthetic', localPath:'C:\\synthetic'}}};
  const calls = [], statuses = [], storedDrafts = new Map();
  const forbidden = name => () => { throw new Error(`Unexpected synthetic port: ${name}`); };
  const scope = {structuredClone, Map, Promise, h, mount, document:globalThis.document, Event:globalThis.Event,
    ...edits, previewDocument, configurationOf, createEditorDocumentSession, pauseEditorForLoad,
    guardedHandler, createEnvironmentOperation, createEnvironmentForm, createGitHubConnectionSummary, createWorkspaceSettingsView,
    environmentLocation, environmentSourceOf, isGitHubEnvironment, historyEntry, saveStatusLine, mutationComplete,
    els, editorTransition:null, documentGeneration:0, policyPreviewToken:0, pendingByDocument:new Map(),
    activeWorkspace:() => context, requestAnimationFrame:callback => callback(),
    showModal:dom.showDialog, closeModal:dom.closeDialog, dismissDialog:dom.dismissDialog,
    confirmDialog:dom.confirmDialog, promptDialog:dom.promptDialog, captureDialogStatus:dom.captureDialogStatus,
    writeContextNode:() => h('p', {}, `Synthetic target ${context.environment.id}`),
    reportClientError:error => calls.push(['error', error.code || error.message]),
    setStatus:(message, tone) => {
      scope.state.status = message ? {message, tone} : null;
      if (message) statuses.push({message, tone});
    },
    render:() => calls.push(['render', scope.state.tab]),
    refreshPolicyPreview:forbidden('refreshPolicyPreview'), renderContextRail:forbidden('renderContextRail'),
    pullRequestUrl:forbidden('pullRequestUrl'), openEnvironmentCompare:forbidden('openEnvironmentCompare'),
    switchEnvironment:forbidden('switchEnvironment'), addWorkspaceInApp:forbidden('addWorkspaceInApp'),
    syncRegistryMetadata:forbidden('syncRegistryMetadata'),
    githubSessions:{restore:async () => null},
    workspaceRegistry:{
      listProjects:async () => [{id:context.projectId, label:'Review project'}],
      listEnvironments:async () => [context.environment],
      countDrafts:async () => 0,
      removeDraft:async (id, alias) => { storedDrafts.delete(`${id}:${alias}`); calls.push(['removeDraft', id, alias]); },
      saveDraft:async (id, alias, hash, operations) => { storedDrafts.set(`${id}:${alias}`, structuredClone({hash,operations})); },
      ...registry,
    },
    api,
    selectContract:async id => { calls.push(['selectContract', id]); return true; },
    clearActiveWorkspace:() => calls.push(['clearActiveWorkspace']),
    setSetupContext:value => calls.push(['setSetupContext', value]),
    updateHeaderContext:() => calls.push(['updateHeaderContext']),
    init:async () => { calls.push(['init']); els.workspace.replaceChildren(h('h1', {}, 'Synthetic catalog')); },
    location:{reload:() => calls.push(['reload'])},
  };
  vm.createContext(scope);
  vm.runInContext(appSection('function createEditorState()', 'const viewStates ='), scope);
  const owner = Object.assign(scope.createEditorState(), {
    current:{path:'bicep/infra/main.bicepparam', hash:'synthetic-source-hash', format:'bicep',
      params:[{name:'value',value:'saved'}], schema:{parameters:{value:{type:'string'}}}},
    contracts:{root:'bicep/infra/citadel-access-contracts', parent:'contracts', contracts:[]},
  }, initial);
  scope.viewStates = new WorkspaceViewState(() => owner);
  scope.state = scope.viewStates.activate(context);
  scope.documentActions = createDocumentActions({views:scope.viewStates, currentOwner:() => scope.state, setStatus:scope.setStatus});
  const sections = [
    appSection('function formatTimestamp(', 'async function withStatus('),
    appSection('async function withStatus(', '/* -------------------------------------------------------------- operations */'),
    appSection('function draftContainsSecureValue(', 'function pushOperation('),
    appSection('function hasPolicyEdits(', '/* Pending edits live only in memory'),
    appSection('function canLeaveIncompleteNumber(', 'function currentValidation('),
    appSection('async function withEditorLoad(', 'async function loadDocument('),
    appSection('function openCreateContract()', 'async function loadContract('),
    appSection('function recoveryBanner()', 'function quarantineNotice()'),
    appSection('function tabBar(', 'function renderWorkspace('),
    appSection('async function openHistory()', 'async function openEnvironmentCompare('),
    appSection('async function openWorkspaceSettingsContent()', 'async function openTerraformExportReview('),
    appSection('function renderStartupRecovery(', '// Nothing starts'),
    appSection('const editorDocuments =', 'const els ='),
  ];
  vm.runInContext(sections.join('\n'), scope);
  return {dom, els, scope, owner, context, calls, statuses, storedDrafts};
}
