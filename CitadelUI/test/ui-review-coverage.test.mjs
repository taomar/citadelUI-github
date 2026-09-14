import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installDom, loadDialogModule, readText } from './_dom-stub.mjs';
import { shellHarness, find, button, activate, input } from './fixtures/ui-review/shell-harness.mjs';
import { widget, record, target } from './fixtures/ui-review/widgets.mjs';
import { nativeLocalFixture } from './_native-fixture.mjs';
import { initializeNativeParser } from '../shared/terraform/parser.mjs';
import { migrationHarness } from './_migration-fixture.mjs';
import { isolatedSnapshotApp } from './_migration-snapshot-fixture.mjs';
import { openMigrationWizard } from '../web/js/migration-wizard.mjs';
import { serializeValue } from '../shared/bicepparam/serialize.mjs';

const labelled = (root,label) => find(root,node => node.getAttribute?.('aria-label') === label);
const css = (root,name) => find(root,node => node.classList?.contains(name));
const nodes = (root,predicate) => [root,...(root.children || []).flatMap(child => nodes(child,() => true))].filter(predicate);
function component(id,options) {
  const dom = installDom();
  globalThis.HTMLElement = globalThis.Node;
  globalThis.window = {matchMedia:() => ({matches:true}), addEventListener() {}, removeEventListener() {}};
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  const result = widget(id,options);
  dom.root.append(result.root);
  return Object.assign(result,{dom});
}
async function change(control,value) {
  assert(control && !control.disabled);
  control.value = value;
  await activate(control,'change');
}
function unchanged(actual,expected) { assert.deepEqual(structuredClone(actual),structuredClone(expected)); }

test('UI review coverage: contract-additional-foundry adds only a ready, nonduplicate target', async () => {
  const view = component('contract-additional-foundry');
  const picker = labelled(view.root,'Add existing Foundry');
  assert(picker);
  picker.focus();
  const choices = nodes(view.dom.root,node => node.getAttribute?.('role') === 'option');
  assert.equal(choices.length,1);
  assert.match(readText(choices[0]),/synthetic-account/);
  await activate(choices[0]);
  unchanged(view.events,[{action:'append',path:['additionalFoundries'],value:{subscriptionId:target.subscriptionId,
    resourceGroupName:target.resourceGroupName,accountName:target.accountName,projectName:target.projectName,endpointSource:''}}]);
  unchanged(view.original,[]);
  assert.equal(picker.getAttribute('aria-expanded'),'false');
  const duplicate = component('contract-additional-foundry',{existing:true});
  assert.equal(labelled(duplicate.root,'Add existing Foundry'),null);
  assert.match(readText(duplicate.root),/already|No .*Foundry|No .*Foundries/i);
});

test('UI review coverage: contract-create-open opens the real creation dialog and focuses its name', async () => {
  const f = await shellHarness();
  const overview = f.scope.contractsOverview({title:'Access contracts'});
  f.els.workspace.append(overview);
  const trigger = button(overview,'New contract');
  trigger.focus();
  await activate(trigger);
  assert(f.dom.modal.open);
  assert.match(readText(f.dom.modal),/New access contract/);
  assert.equal(document.activeElement.id,'new-contract-name');
  assert(button(f.dom.modal,'Create'));
  assert(button(f.dom.modal,'Cancel'));
  assert.equal(f.calls.length,0);
});

test('UI review coverage: contract-create-cancel closes and restores focus without creating source', async () => {
  const mutations = [];
  const f = await shellHarness({api:{createContract:async () => mutations.push('create')}});
  const overview = f.scope.contractsOverview({title:'Access contracts'});
  f.els.workspace.append(overview);
  const trigger = button(overview,'New contract');
  trigger.focus();
  await activate(trigger);
  input(find(f.dom.modal,node => node.id === 'new-contract-name'),'draft-only');
  await activate(button(f.dom.modal,'Cancel'));
  assert.equal(f.dom.modal.open,false);
  assert.equal(document.activeElement,trigger);
  unchanged(mutations,[]);
  unchanged(f.owner.operations,[]);
});

test('UI review coverage: contract-create-name rejects empty input and previews the exact lowercase target', async () => {
  const submissions = [];
  const f = await shellHarness({api:{createContract:async (value,context) => {
    submissions.push({value,context});
    throw new Error('Synthetic service rejected this name; no file was created.');
  }}});
  f.scope.openCreateContract();
  const field = find(f.dom.modal,node => node.id === 'new-contract-name');
  input(field,'  ');
  await activate(button(f.dom.modal,'Create'));
  assert.equal(submissions.length,0);
  assert.equal(field.validationMessage,'Enter a contract name.');
  input(field,'  HR-Chat01  ');
  assert.equal(field.validationMessage,'');
  assert.match(readText(f.dom.modal),/Creates bicep\/infra\/citadel-access-contracts\/contracts\/hr-chat01\/ containing main\.bicepparam and ai-product-policy\.xml/);
  await activate(button(f.dom.modal,'Create'));
  assert.equal(submissions.length,1);
  unchanged(submissions[0].value,{name:'HR-Chat01'});
  assert.equal(submissions[0].context,f.context);
  assert(f.dom.modal.open);
  assert.match(readText(f.dom.modal),/Synthetic service rejected/);
});

test('UI review coverage: contract-foundry-endpoint-source changes or adds only the selected endpoint selector', async () => {
  const view = component('contract-foundry-endpoint-source');
  const control = labelled(view.root,'Endpoint source for additional Foundry row 1');
  unchanged(control.children.map(node => node.value),['','global','primary','secondary:0','secondary:1']);
  await change(control,'secondary:1');
  unchanged(view.events,[{action:'change',path:['additionalFoundries',0,'endpointSource'],value:'secondary:1'}]);
  assert.equal(view.original[0].endpointSource,'');
  const missing = component('contract-foundry-endpoint-source',{missing:true});
  await change(labelled(missing.root,'Endpoint source for additional Foundry row 1'),'primary');
  unchanged(missing.events,[{action:'add-property',path:['additionalFoundries',0],key:'endpointSource',value:'primary'}]);
  const invalid = component('contract-foundry-endpoint-source',{invalid:true});
  assert.match(readText(invalid.root),/secondary:9.*invalid/);
});

test('UI review coverage: contract-policy-tab activates Policy but obeys the real incomplete-input gate', async () => {
  const f = await shellHarness();
  const tabs = f.scope.tabBar([['params','Parameters'],['policy','Policy'],['raw','Raw file']]);
  f.els.workspace.append(tabs);
  const before = structuredClone(f.owner.current);
  await activate(button(tabs,'Policy'));
  assert.equal(f.owner.tab,'policy');
  unchanged(f.calls.filter(call => call[0] === 'render'),[['render','policy']]);
  unchanged(f.owner.current,before);
  f.owner.parameterInputs.bad = {path:['capacity'],text:'1e',badInput:true};
  await activate(button(tabs,'Raw file'));
  assert.equal(f.owner.tab,'policy','incomplete input must prevent the subsequent navigation');
  assert.equal(f.calls.filter(call => call[0] === 'render').length,1);
  assert(f.statuses.some(entry => entry.tone === 'error'));
});

test('UI review coverage: documentation-example-expand exposes exact example bytes in a native disclosure', () => {
  const view = component('documentation-example-expand');
  const disclosure = css(view.root,'doc-code');
  assert.equal(disclosure.tagName,'DETAILS');
  assert.equal(disclosure.children[0].tagName,'SUMMARY');
  assert.equal(readText(disclosure.children[0]),'Review example');
  assert.equal(readText(find(disclosure,node => node.tagName === 'CODE')),"param label = 'example'\n// Never deployed.");
  assert.equal(Boolean(disclosure.open),false);
  // Native summary click/keyboard activation is covered by the companion browser run.
  unchanged(view.events,[]);
});

test('UI review coverage: export-mapping-reason renders the mapped field reason without changing the projection', () => {
  const view = component('export-mapping-reason');
  const disclosure = css(view.root,'tf-field-reason');
  assert.equal(disclosure.tagName,'DETAILS');
  assert.equal(readText(disclosure.children[0]),'Mapping reason');
  assert.match(readText(disclosure),/mapped without a source write/);
  assert.equal(view.original.proposed.environment_name,'review');
  unchanged(view.events,[]);
});

test('UI review coverage: field-env-fallback edits only the in-file argument and explicitly activates an unset fallback', async () => {
  const view = component('field-env-fallback');
  const field = find(view.root,node => node.tagName === 'INPUT');
  input(field,'new fallback');
  await activate(field,'change');
  unchanged(view.events,[{action:'change',path:['setting','__args',1],value:'new fallback'}]);
  unchanged(view.original.args,['REVIEW_ONLY_VARIABLE','old']);
  const unset = component('field-env-fallback',{unset:true});
  const trigger = find(unset.root,node => node.tagName === 'BUTTON');
  assert(trigger);
  await activate(trigger);
  const promoted = find(unset.root,node => node.tagName === 'INPUT');
  assert.equal(document.activeElement,promoted);
  input(promoted,'explicit');
  await activate(promoted,'change');
  unchanged(unset.events,[{action:'change',path:['setting','__args',1],value:'explicit'}]);
});

test('UI review coverage: field-expression-inspect preserves opaque syntax and directs edits to raw source', () => {
  const view = component('field-expression-inspect');
  assert.equal(readText(css(view.root,'expr-raw')),'resourceGroup().location');
  assert.match(readText(view.root),/Preserved exactly as written\. Edit the raw file/);
  assert.equal(nodes(view.root,node => ['INPUT','SELECT','TEXTAREA','BUTTON'].includes(node.tagName)).length,0);
  unchanged(view.events,[]);
  assert.equal(view.original.raw,'resourceGroup().location');
});

test('UI review coverage: field-foundry-service-index keeps zero-based identity and removes All instances override', async () => {
  const view = component('field-foundry-service-index');
  const control = labelled(view.root,'AI service for model row 1');
  await change(control,'1');
  await change(control,'');
  unchanged(view.events,[{action:'change',path:['aiFoundryModelsConfig',0,'aiserviceIndex'],value:1},
    {action:'remove',path:['aiFoundryModelsConfig',0,'aiserviceIndex']}]);
  assert.equal(view.original[0].aiserviceIndex,0);
  const missing = component('field-foundry-service-index',{missing:true});
  await change(labelled(missing.root,'AI service for model row 1'),'0');
  unchanged(missing.events,[{action:'add-property',path:['aiFoundryModelsConfig',0],key:'aiserviceIndex',value:0}]);
  const invalid = component('field-foundry-service-index',{index:8});
  assert.match(readText(invalid.root),/8.*invalid/i);
});

test('UI review coverage: field-record-add appends an independent typed blank template', async () => {
  const view = component('field-record-add');
  await activate(button(view.root,'Add entry'));
  unchanged(view.events,[{action:'append',path:['records'],value:{name:'',units:0,enabled:false,region:'',description:'',extra:''}}]);
  view.events[0].value.name = 'only-new-row';
  unchanged(view.original,[record]);
});

test('UI review coverage: field-record-additional expands and collapses only the addressed detail row', async () => {
  const view = component('field-record-additional');
  const trigger = css(view.root,'rec-toggle'), detail = css(view.root,'rec-detail');
  assert(detail.hidden);
  assert.equal(trigger.getAttribute('aria-controls'),detail.id);
  await activate(trigger);
  assert.equal(detail.hidden,false);
  assert.equal(trigger.getAttribute('aria-expanded'),'true');
  assert.equal(view.open.get('record:["records"]:0'),true);
  await activate(trigger);
  assert.equal(detail.hidden,true);
  assert.equal(trigger.getAttribute('aria-expanded'),'false');
  assert.equal(view.open.get('record:["records"]:0'),false);
  unchanged(view.events,[]);
});

test('UI review coverage: field-record-remove addresses exactly its row without deleting the source itself', async () => {
  const view = component('field-record-remove');
  await activate(labelled(view.root,'Remove entry 1'));
  unchanged(view.events,[{action:'remove',path:['records',0]}]);
  unchanged(view.original,[record]);
  const rows = [{...record,name:'first'},{...record,name:'second',units:8},{...record,name:'third',units:9}];
  const live = component('field-record-remove',{reactive:true,rows});
  const units = index => find(live.root,node => node.dataset?.parameterInput === JSON.stringify(['records',index,'units']));
  input(units(1),'42');
  await activate(units(1),'change');
  await activate(labelled(live.root,'Remove entry 1'));
  assert.equal(units(0).value,'42');
  assert.equal(units(1).value,'9');
  input(units(1),'99');
  await activate(units(1),'change');
  assert.equal(units(0).value,'42');
  assert.equal(units(1).value,'99');
  assert(live.operations.some(operation => operation.op === 'set' && operation.path[1] === 1 && operation.value === 42));
  assert(live.operations.some(operation => operation.op === 'set' && operation.path[1] === 2 && operation.value === 99));
  unchanged(live.original,rows);
});

test('UI review coverage: history-rollback restores verified transaction bytes through the actual History control', async t => {
  await initializeNativeParser();
  const local = await nativeLocalFixture();
  t.after(() => local.close());
  const alias = 'environments/development.tfvars';
  const beforeSource = await local.provider.read(alias), before = beforeSource.text;
  const document = await local.service.deployment(alias);
  local.hooks.request = async path => { if (path.endsWith('/receipt')) throw new Error('Synthetic receipt outage'); };
  await assert.rejects(local.service.save(alias,[{op:'set',path:['environment_name'],value:'review-changed'}],document.hash,document.nativeIdentity));
  assert.notEqual((await local.provider.read(alias)).text,before);
  delete local.hooks.request;
  const journal = (await local.store.history(local.environment.id)).find(entry => entry.recoveryRequired || entry.status === 'committing');
  assert(journal,'a real interrupted journal must back the recovery button');
  const calls = [];
  const f = await shellHarness({context:local.context,state:{current:document},api:{
    history:context => local.service.history(context),
    inspectRecovery:(id,context) => local.service.inspectRecovery(id,context),
    recoverTransaction:(id,action,context) => { calls.push({id,action,context}); return local.service.recoverTransaction(id,action,context); },
  }});
  await f.scope.openHistory();
  await activate(button(f.dom.modal,'Recover'));
  assert.match(readText(f.dom.modal),/Recover transaction/);
  await activate(button(f.dom.modal,'Roll back'));
  assert.equal(calls.length,1);
  assert.equal(calls[0].id,journal.transactionId || journal.id);
  assert.equal(calls[0].action,'rollback');
  assert.equal(calls[0].context,local.context);
  const restored = await local.provider.read(alias);
  assert.equal(restored.text,before);
  assert.deepEqual(restored.bytes,beforeSource.bytes);
  assert.equal((await local.store.getTransaction(local.environment.id,calls[0].id)).status,'rolled_back');
  assert.match(readText(f.dom.modal),/Environment history/);
  assert.equal(f.statuses.filter(entry => entry.tone === 'error').length,0);
});

test('UI review coverage: migration-backend-pair-clear clears the confirmed backend and its choices without writes', async t => {
  const app = await isolatedSnapshotApp(t);
  const path = 'bicep/infra/llm-backend-onboarding/main.bicepparam', source = `older/${path}`;
  const backend = (id,capacity) => ({backendId:id,backendType:'ai-foundry',endpoint:`https://${id}.invalid/`,
    authType:'managed-identity',supportedModels:[{name:'chat',modelVersion:'1',capacity}]});
  const before = `using './main.bicep'\nparam llmBackendConfig = ${serializeValue([backend('new-backend',3),backend('other-backend',5)])}\n`;
  const donorText = `param llmBackendConfig = ${serializeValue([backend('old-backend',9),backend('old-other',11)])}\n`;
  const harness = migrationHarness({snapshotRequest:app.request,targetFiles:{[path]:before,
    [path.replace(/\.bicepparam$/,'.bicep')]:'param llmBackendConfig array\n'},donorFiles:{[source]:donorText}});
  const dialog = await loadDialogModule();
  const wizard = await openMigrationWizard({session:harness.session,chooseDirectory:async () => harness.donorRoot,
    show:dialog.showDialog,dismiss:dialog.dismissDialog,confirm:dialog.confirmDialog,
    download:async () => {throw new Error('No export authorized');}});
  const press = async action => {
    await activate(find(wizard.body,node => node.dataset?.action === action) || find(wizard.footer,node => node.dataset?.action === action));
    await wizard.whenIdle();
  };
  await press('choose-folder');
  await press('area-llm-onboarding');
  await change(labelled(wizard.body,'Destination parameter file'),path);
  const donor = find(wizard.body,node => node.dataset?.sourceAlias === source);
  assert(donor);
  donor.checked = true;
  await activate(donor,'change');
  await press('map');
  const picker = labelled(wizard.body,'Old backend for new-backend');
  const option = picker.children.find(node => readText(node).startsWith('old-backend ') && !node.disabled);
  await change(picker,option.value);
  await activate(button(wizard.body,'Confirm backend pairing'));
  await wizard.whenIdle();
  const field = labelled(wizard.body,'Import Capacity for new-backend / chat');
  assert(field && !field.disabled);
  field.checked = true;
  await activate(field,'change');
  await wizard.whenIdle();
  assert.equal(wizard.session.view().rows[0].structured.summary.selectedFields,1);
  const otherPicker = labelled(wizard.body,'Old backend for other-backend');
  const otherDisclosure = otherPicker.closest('.migration-backend-review');
  otherDisclosure.open = true;
  await activate(otherDisclosure,'toggle');
  await change(otherPicker,otherPicker.children.find(node => readText(node).startsWith('old-other ')).value);
  await activate(button(wizard.body,'Confirm backend pairing'));
  await wizard.whenIdle();
  const otherField = labelled(wizard.body,'Import Capacity for other-backend / chat');
  otherField.checked = true;
  await activate(otherField,'change');
  await wizard.whenIdle();
  const otherPair = wizard.session.view().rows[0].structured.backends[1].confirmedSource;
  assert.equal(wizard.session.view().rows[0].structured.summary.selectedFields,2);
  const targetBackend = labelled(wizard.body,'Old backend for new-backend').closest('.migration-backend-review');
  await activate(button(targetBackend,'Clear backend pairing'));
  await wizard.whenIdle();
  const review = wizard.session.view().rows[0].structured;
  assert.equal(Boolean(review.backends[0].confirmedSource),false);
  assert.equal(review.summary.selectedFields,1);
  assert.equal(review.backends[1].confirmedSource,otherPair);
  assert(labelled(wizard.body,'Import Capacity for other-backend / chat').checked);
  assert.equal(labelled(wizard.body,'Old backend for new-backend').value,'');
  assert.equal(button(labelled(wizard.body,'Old backend for new-backend').closest('.migration-backend-review'),'Clear backend pairing'),null);
  assert.equal(labelled(wizard.body,'Import Capacity for new-backend / chat'),null);
  const targetAfter = await harness.provider.read(path);
  assert.equal(targetAfter.text,before);
  assert.deepEqual(targetAfter.bytes,new TextEncoder().encode(before));
  assert.equal((await harness.donor.read(source)).text,donorText);
  assert.equal(harness.api.trace.length,0);
  assert.equal(harness.targetTrace.filter(entry => /^(write|writable):/.test(entry)).length,0);
  assert.equal(harness.donorTrace.filter(entry => /^(write|writable):/.test(entry)).length,0);
  dialog.dismissDialog(true);
});

test('UI review coverage: migration-model-disclosure persists its own open state separately from field choices', async () => {
  const view = component('migration-model-disclosure');
  const disclosure = css(view.root,'migration-value-details');
  assert(disclosure && disclosure.tagName === 'DETAILS');
  disclosure.open = true;
  await activate(disclosure,'toggle');
  assert.equal(view.open.get('models:chat'),true);
  disclosure.open = false;
  await activate(disclosure,'toggle');
  assert.equal(view.open.get('models:chat'),false);
  unchanged(view.events,[]);
  assert.equal(view.original.structured.backends[0].models[0].fields[0].selected,false);
});

test('UI review coverage: policy-outline-jump addresses the selected section and records its current marker', async () => {
  const view = component('policy-outline-jump');
  const links = nodes(view.root,node => node.classList?.contains('pnav-link'));
  const sections = nodes(view.root,node => node.classList?.contains('pnav-section'));
  assert(links.length >= 3);
  assert.equal(sections.length,links.length);
  const index = 2, scrolls = [];
  sections.forEach((section,i) => { section.scrollIntoView = options => scrolls.push({index:i,...options}); });
  await activate(links[index]);
  unchanged(scrolls,[{index,block:'start',behavior:'auto'}]);
  assert.equal(view.open.get('policy-block'),index);
  unchanged(links.map(link => link.getAttribute('aria-current')),links.map((_link,i) => i === index ? 'true' : 'false'));
  unchanged(view.events,[]);
});

test('UI review coverage: settings-remove-profile-cancel retains inactive metadata, drafts and source', async () => {
  const active = {id:'review-active',projectId:'review-project',label:'Active',source:{kind:'local',localPath:'C:\\synthetic\\active'}};
  const inactive = {id:'review-inactive',projectId:'review-project',label:'Inactive',source:{kind:'local',localPath:'C:\\synthetic\\inactive'}};
  const entries = [active,inactive], original = structuredClone(entries), writes = [];
  const f = await shellHarness({context:{projectId:'review-project',environment:active},registry:{
    listEnvironments:async () => entries, countDrafts:async id => id === inactive.id ? 2 : 0,
    environmentSnapshot:async id => {writes.push(['snapshot',id]); throw new Error('Cancellation must precede a snapshot');},
    removeEnvironment:async id => {writes.push(['remove',id]); throw new Error('No removal was approved');},
  }});
  await f.scope.openWorkspaceSettingsContent();
  const rows = nodes(f.dom.modal,node => node.classList?.contains('environment-card'));
  const inactiveRow = rows.find(row => readText(row).includes('Inactive'));
  assert(inactiveRow,readText(f.dom.modal));
  const removal = activate(button(inactiveRow,'Remove profile'));
  await setImmediate();
  assert.match(readText(f.dom.modal),/Remove environment profile\?/);
  assert.match(readText(f.dom.modal),/not delete|not removed|never deletes/i);
  await activate(button(f.dom.modal,'Cancel'));
  await removal;
  unchanged(entries,original);
  unchanged(writes,[]);
  assert.match(readText(inactiveRow),/Operation cancelled\./);
  assert.equal(f.statuses.filter(entry => entry.tone === 'error').length,0);
});

test('UI review coverage: shell-startup-reload activates one reload from the rendered recovery control', async () => {
  const f = await shellHarness();
  f.scope.renderStartupRecovery(new Error('Synthetic setup failed'));
  assert.match(readText(f.els.workspace),/Synthetic setup failed/);
  assert.equal(f.els.shell.dataset.workspace,'setup');
  assert.equal(document.activeElement,f.els.workspace);
  await activate(button(f.els.workspace,'Reload Citadel UI'));
  assert.equal(f.calls.filter(call => call[0] === 'reload').length,1);
  assert.equal(f.calls.filter(call => call[0] === 'init').length,0);
});

test('UI review coverage: shell-startup-return preserves drafts and retires the owner before reopening setup', async () => {
  const operation = {op:'set',path:['value'],value:'retained'};
  const f = await shellHarness({state:{operations:[operation]}});
  f.scope.renderStartupRecovery(new Error('Synthetic setup failed'));
  const oldTicket = f.scope.viewStates.ticket();
  await activate(button(f.els.workspace,'Return to setup'));
  assert.notEqual(f.scope.state,f.owner);
  assert.equal(f.scope.viewStates.isCurrent(oldTicket),false);
  unchanged(f.owner.operations,[operation]);
  assert.equal(f.storedDrafts.size,1);
  unchanged([...f.storedDrafts.values()][0].operations,[operation]);
  assert.equal(f.calls.filter(call => call[0] === 'clearActiveWorkspace').length,1);
  assert.equal(f.calls.filter(call => call[0] === 'init').length,1);
  assert.equal(f.calls.filter(call => call[0] === 'reload').length,0);
  assert.match(readText(f.els.workspace),/Synthetic catalog/);
  assert.equal(f.els.workspace.inert,false);
});

test('UI review coverage: subscription-value validates changes and sends the environment/hash-bound save', async () => {
  const view = component('subscription-value');
  const field = labelled(view.root,'Azure subscription ID');
  const save = nodes(view.root,node => node.tagName === 'BUTTON').find(node => /Save/.test(readText(node)));
  assert.equal(save.disabled,false,'the existing valid subscription initially offers its explicit Save action');
  input(field,'not-a-guid');
  assert(save.disabled);
  assert.match(readText(view.root),/GUID|valid subscription/i);
  input(field,'11111111-1111-4111-8111-111111111111');
  assert(save.disabled,'unchanged values must not offer a write');
  const value = '22222222-2222-4222-8222-222222222222';
  input(field,value);
  assert.equal(save.disabled,false);
  await activate(save);
  unchanged(view.events,[{action:'subscription',environmentName:'review',value,expectedHash:'synthetic-env-hash'}]);
  assert.equal(view.original.subscription.value,'11111111-1111-4111-8111-111111111111');
  assert(labelled(component('subscription-value',{noEnvironment:true}).root,'Azure subscription ID').disabled);
  assert(labelled(component('subscription-value',{error:'Synthetic source read error'}).root,'Azure subscription ID').disabled);
});
