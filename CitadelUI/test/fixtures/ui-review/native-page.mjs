import { mountWidget } from './widgets.mjs';
import { mountShell } from './browser-shell.mjs';
import { closeDialog } from '../../../web/js/dialog.mjs';

const bootCount = Number(sessionStorage.getItem('review-boot-count') || 0) + 1;
sessionStorage.setItem('review-boot-count',String(bootCount));
let current;
window.coverageFixture = {
  bootCount,
  async mount(id,options = {}) {
    if (document.getElementById('modal').open) closeDialog();
    if (['contract-additional-foundry','field-env-fallback'].includes(id)) options = {...options,reactive:true};
    current = /^(contract-create-|contract-policy-tab$|shell-startup-reload$)/.test(id)
      ? await mountShell(id) : mountWidget(id,options);
    document.getElementById('workspace').scrollTop = 0;
    return this.snapshot();
  },
  snapshot() {
    return {id:current?.id,events:current?.events,original:current?.original,
      open:current ? [...current.open] : [],tab:current?.owner?.tab,statuses:current?.statuses,bootCount,
      operations:current?.operations,parameterInputs:current?.parameterInputs};
  },
  setIncompleteInput() {
    if (!current?.owner) throw new Error('No shell owner');
    current.owner.parameterInputs.bad = {path:['capacity'],text:'1e',badInput:true};
  },
};
document.body.dataset.reviewReady = 'true';
