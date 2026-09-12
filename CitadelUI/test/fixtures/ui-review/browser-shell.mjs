import { h, mount } from '../../../web/js/dom.mjs';
import { showDialog, closeDialog, captureDialogStatus } from '../../../web/js/dialog.mjs';
import { createDocumentActions } from '../../../web/js/document-action.mjs';
import { WorkspaceViewState } from '../../../web/js/workspace-view-state.mjs';
import { guardedHandler } from '../../../web/js/single-flight.mjs';
import { hasParameterInputs } from '../../../web/js/contract-edit-state.mjs';
import { environmentSourceOf } from '../../../web/js/registry.mjs';
import { saveStatusLine } from '../../../web/js/save-resolution.mjs';
import { mutationComplete } from '../../../shared/mutation-outcome.mjs';

let source;
async function applicationSource() {
  if (source) return source;
  const response = await fetch('/web/js/app.mjs');
  if (!response.ok) throw new Error(`Cannot read pinned app source: ${response.status}`);
  source = (await response.text()).replace(/\r\n/g,'\n');
  return source;
}
function section(app,start,end) {
  const first = app.indexOf(start), last = app.indexOf(end,first);
  if (first < 0 || last <= first) throw new Error(`Missing actual app section: ${start}`);
  return app.slice(first,last);
}

export async function mountShell(id) {
  const app = await applicationSource();
  const createEditorState = new Function(`${section(app,'function createEditorState()','const viewStates =')}; return createEditorState;`)();
  const context = {projectId:'review-project',environment:{id:'review-active',projectId:'review-project',label:'Synthetic',
    source:{kind:'local',localPath:'C:\\synthetic'}}};
  const calls = [], statuses = [], owner = createEditorState();
  owner.contracts = {root:'bicep/infra/citadel-access-contracts',parent:'contracts',contracts:[]};
  owner.current = {path:'synthetic.bicepparam',hash:'synthetic-hash',params:[],format:'bicep'};
  const viewStates = new WorkspaceViewState(() => owner);
  const scope = {
    h, mount, document, requestAnimationFrame:callback => window.requestAnimationFrame(callback),
    guardedHandler, hasParameterInputs, environmentSourceOf, saveStatusLine, mutationComplete,
    state:viewStates.activate(context), viewStates, activeWorkspace:() => context,
    showModal:showDialog, closeModal:closeDialog, captureDialogStatus,
    els:{workspace:document.getElementById('review-host'),shell:document.getElementById('workspace')},
    location:window.location,
    setStatus:(message,tone) => { owner.status = message ? {message,tone} : null; statuses.push({message,tone}); },
    reportClientError:error => calls.push({action:'error',message:error.message}),
    writeContextNode:() => h('p', {}, 'Synthetic local target; no real repository access.'),
    render:() => calls.push({action:'render',tab:owner.tab}),
    returnToSetup:() => { throw new Error('Actual startup-return lifecycle is tested in the Node transaction/session harness.'); },
    api:{createContract:async (value,target) => {
      calls.push({action:'create',value,environmentId:target.environment.id});
      throw new Error('Synthetic service rejected creation; no source was written.');
    }},
  };
  scope.documentActions = createDocumentActions({views:viewStates,currentOwner:() => owner,setStatus:scope.setStatus});
  const bodies = [
    section(app,'async function withStatus(','/* -------------------------------------------------------------- operations */'),
    section(app,'function canLeaveIncompleteNumber(','function currentValidation('),
    section(app,'function openCreateContract()','async function loadContract('),
    section(app,'function recoveryBanner()','function quarantineNotice()'),
    section(app,'function tabBar(','function renderWorkspace('),
    section(app,'function renderStartupRecovery(','/**\n * Leave the active workspace'),
  ];
  // The only evaluated text is the locally served, pinned production source.
  const handlers = new Function('scope',`with (scope) { ${bodies.join('\n')}\nreturn {contractsOverview,tabBar,renderStartupRecovery}; }`)(scope);
  const root = scope.els.workspace;
  if (id.startsWith('contract-create-')) {
    root.replaceChildren(handlers.contractsOverview({title:'Access contracts'}));
  } else if (id === 'contract-policy-tab') {
    root.replaceChildren(handlers.tabBar([['params','Parameters'],['policy','Policy'],['raw','Raw file']]));
  } else if (id === 'shell-startup-reload') {
    handlers.renderStartupRecovery(new Error('Synthetic startup failure'));
  } else throw new Error(`Unknown shell fixture ${id}`);
  return {id,root,events:calls,original:owner.current,open:new Map(),owner,statuses};
}
