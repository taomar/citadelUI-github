import { h } from '../../../web/js/dom.mjs';
import { renderValue } from '../../../web/js/fields.mjs';
import { recordOptions, renderParamDocument } from '../../../web/js/paramview.mjs';
import { renderBlocks } from '../../../web/js/docblocks.mjs';
import { exportControlContext } from '../../../web/js/terraform-export-controls.mjs';
import { renderPolicy } from '../../../web/js/policyview.mjs';
import { decoratePolicy } from '../../../web/js/policynav.mjs';
import { renderMigrationModels } from '../../../web/js/migration-value-view.mjs';
import { queueOperation, previewDocument } from '../../../web/js/preview.mjs';
import { preserveEditorFocus } from '../../../web/js/editor-focus.mjs';
import { parameterInput, setParameterInput } from '../../../web/js/contract-edit-state.mjs';

export const record = Object.freeze({name:'first', units:7, enabled:true, region:'eastus', description:'retained', extra:'sixth'});
export const instances = Object.freeze([{name:'first-account',location:'eastus'},{name:'second-account',location:'westus2'}]);
export const target = Object.freeze({index:0, ready:true, subscriptionId:'11111111-1111-4111-8111-111111111111',
  resourceGroupName:'synthetic-rg', accountName:'synthetic-account', projectName:'synthetic-project', location:'eastus'});

export function widget(id, options = {}) {
  const events = [], open = new Map();
  const inputOwner = {operations:[],parameterInputs:{}};
  let live, root, original;
  const emit = (event,operation) => {
    events.push(event);
    if (!live) return;
    inputOwner.operations = queueOperation(inputOwner.operations,operation,live.document);
    setParameterInput(inputOwner,operation.path,null);
    preserveEditorFocus(root,() => root.replaceChildren(live.render()));
  };
  const ctx = {
    onChange:(path,value) => emit({action:'change',path,value},{op:'set',path,value}),
    onAppend:(path,value) => emit({action:'append',path,value},{op:'append',path,value}),
    onRemove:path => emit({action:'remove',path},{op:'remove',path}),
    onAddProperty:(path,key,value) => emit({action:'add-property',path,key,value},{op:'addProperty',path,key,value}),
    isOpen:(key,fallback) => open.has(key) ? open.get(key) : fallback,
    setOpen:(key,value) => open.set(key,value),
    schema:() => null, schemaFor:() => null, pendingFor:() => false, issuesFor:() => [], problemsFor:() => [],
    paramValue:name => name === 'aiFoundryInstances' ? instances : name === 'additionalApimGateways' ? [{name:'one'},{name:'two'}] : undefined,
    accessTargets:{foundries:[target,{...target,index:1,ready:false,accountName:'incomplete'}]},
    saveSubscriptionId:async value => events.push({action:'subscription',...value}),
  };
  if (options.reactive) Object.assign(ctx,{
    inputOwner,inputDraft:path => parameterInput(inputOwner,path),
    onInputDraft:(path,value) => setParameterInput(inputOwner,path,value),
  });
  if (id.startsWith('field-record-')) {
    original = structuredClone(options.rows || [record]);
    root = renderValue(original, ['records'], ctx, {type:'array'}, {record:{maxVisible:3}});
  } else if (id === 'field-env-fallback') {
    original = options.unset
      ? {__expr:'call',callee:'readEnvironmentVariable',args:['REVIEW_ONLY_VARIABLE',''],raw:"readEnvironmentVariable('REVIEW_ONLY_VARIABLE', '')"}
      : {__expr:'call',callee:'readEnvironmentVariable',args:['REVIEW_ONLY_VARIABLE','old'],raw:"readEnvironmentVariable('REVIEW_ONLY_VARIABLE', 'old')"};
    root = renderValue(original, ['setting'], ctx, {type:'string',name:'setting'});
  } else if (id === 'field-expression-inspect') {
    original = {__expr:'call',callee:'resourceGroup',args:[],raw:'resourceGroup().location'};
    root = renderValue(original, ['setting'], ctx, {type:'string',name:'setting'});
  } else if (id === 'field-foundry-service-index') {
    original = [{name:'review-model',publisher:'OpenAI',version:'1',sku:'Standard',capacity:1,
      ...(options.missing ? {} : {aiserviceIndex:options.index ?? 0})}];
    root = renderValue(original, ['aiFoundryModelsConfig'], ctx, {type:'array'}, recordOptions('aiFoundryModelsConfig',ctx));
  } else if (id === 'contract-additional-foundry' || id === 'contract-foundry-endpoint-source') {
    original = id === 'contract-additional-foundry' ? [] : [{subscriptionId:target.subscriptionId,
      resourceGroupName:target.resourceGroupName,accountName:target.accountName,projectName:target.projectName,
      ...(options.missing ? {} : {endpointSource:options.invalid ? 'secondary:9' : ''})}];
    if (options.existing) original = [{...target}];
    root = renderValue(original, ['additionalFoundries'], ctx, {type:'array'}, recordOptions('additionalFoundries',ctx));
  } else if (id === 'documentation-example-expand') {
    original = [{type:'code',label:'Review example',lines:["param label = 'example'",'// Never deployed.']}];
    root = renderBlocks(original);
  } else if (id === 'export-mapping-reason') {
    original = {source:'environmentName',sourceValue:'review',proposed:{environment_name:'review'},
      status:'mapped',notes:[],nested:[{path:['environmentName'],targets:['environment_name'],status:'mapped',
        reason:'The reviewed source name is mapped without a source write.'}]};
    const exportCtx = exportControlContext('deployment',{rows:[original]},{...ctx,readOnly:true});
    root = exportCtx.renderParameterValue({name:'environmentName',kind:'string',value:'review'});
  } else if (id === 'subscription-value') {
    original = {path:'bicep/infra/main.bicepparam',params:[],outline:{sections:[]},
      subscription:{environmentName:options.noEnvironment ? '' : 'review',value:'11111111-1111-4111-8111-111111111111',
        hash:'synthetic-env-hash',source:'.azure/review/.env',available:true,configured:true,valid:true,
        error:options.error || null}};
    root = renderParamDocument(original,ctx);
  } else if (id === 'policy-outline-jump') {
    original = {path:'synthetic-policy.xml',text:'<policies><inbound><base /></inbound></policies>',controls:{}};
    root = decoratePolicy(renderPolicy(original,{policyMode:'guided',onPolicyChange:value => events.push(value)}),ctx);
  } else if (id === 'migration-model-disclosure') {
    original = {id:'models',name:'llmBackendConfig',structured:{
      available:true,sourceIssues:[],unpairedSources:[],
      backends:[{key:'target',backendId:'new-backend',backendType:'ai-foundry',endpoint:'https://target.invalid',
        confirmedSource:'old',options:[{key:'old',backendId:'old-backend',backendType:'ai-foundry',
          file:'old/main.bicepparam',eligible:true,endpoint:'https://source.invalid'}],
        unmatchedSourceModels:[],models:[{key:'chat',name:'chat',modelPath:'/chat',fields:[
          {key:'capacity',label:'Capacity',source:'9',current:'3',comparison:'different',selected:false,eligible:true,problems:[]},
        ]}]}],
    }};
    root = renderMigrationModels(original,{busy:false,pairs:new Map(),expanded:open,register() {},
      showUnchanged:true,onPairDraft:() => {throw new Error('Not a pairing test');},
      onPair:() => {throw new Error('Not a pairing test');},onClearPair:() => {throw new Error('Not a clearing test');},
      onModelField:(_row,_backend,_model,field,checked) => events.push({action:'model-field',field:field.key,checked})});
  } else throw new Error(`Unknown review widget ${id}`);
  if (options.reactive) {
    const name = id === 'contract-additional-foundry' ? 'additionalFoundries' : id === 'field-env-fallback' ? 'setting'
      : id.startsWith('field-record-') ? 'records' : null;
    if (!name) throw new Error(`No reactive document fixture for ${id}`);
    const document = {params:[{name,value:original}],format:'bicep'};
    live = {document,render:() => renderValue(previewDocument(document,inputOwner.operations).params[0].value,
      [name],ctx,{type:name === 'setting' ? 'string' : 'array',name},
      name === 'records' ? {record:{maxVisible:3}} : recordOptions(name,ctx))};
    root = h('div',{class:'review-reactive-host'},root);
  }
  return {id,root,original,events,open,ctx,
    get operations() { return inputOwner.operations; },
    get parameterInputs() { return inputOwner.parameterInputs; }};
}

export function mountWidget(id, options) {
  const value = widget(id,options);
  const host = document.getElementById('review-host');
  if (!host) throw new Error('Missing isolated review host');
  host.replaceChildren(h('h1', {}, id), value.root);
  return value;
}
