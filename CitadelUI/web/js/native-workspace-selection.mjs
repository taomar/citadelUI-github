import { h } from './dom.mjs';
import { createConfiguration, TERRAFORM_ROOTS, validateConfiguration } from '../../shared/workspace-configuration.mjs';
import { NATIVE_AREA_TITLES, NATIVE_LOCAL_CREATION_NOTICE } from '../../shared/terraform/workspace.mjs';

/** Selection only: inventory never grants read/write authority over a file. */
export function nativeWorkspaceSelection({ inventory, configuration, onChange }) {
  const units = (configuration?.units || []).map((unit) => ({ ...unit }));
  let profileId = configuration?.profileId || crypto.randomUUID();
  const listing = h('div', { class: 'catalog-form' });
  const error = h('p', { class: 'field-error', role: 'alert', hidden: true });
  const area = h('select', { class: 'ctl', 'aria-label': 'Native area' },
    Object.keys(TERRAFORM_ROOTS).map((key) => h('option', { value: key }, NATIVE_AREA_TITLES[key])));
  const alias = h('input', { class: 'ctl', type: 'text', 'aria-label': 'Native value file',
    placeholder: 'environments/development.tfvars', list: 'native-value-candidates', spellcheck: false });
  const candidates = h('datalist', { id: 'native-value-candidates' });
  const allowCreate = h('input', { type: 'checkbox', 'aria-label': 'Create an empty operator file if absent' });
  const nonsecret = h('input', { type: 'checkbox', 'aria-label': 'This is a nonsecret operator file' });
  const chosen = h('div', { class: 'catalog-form' });
  const known = new Set(inventory.files.map((file) => file.alias));
  function paint() {
    const prefix = area.value === 'deployment' ? 'environments/' : `${TERRAFORM_ROOTS[area.value]}/`;
    candidates.replaceChildren(...inventory.files.filter((file) =>
      file.alias.startsWith(prefix) && /\.tfvars(?:\.json)?$/.test(file.alias)).map((file) => h('option', { value: file.alias })));
    alias.placeholder = `${prefix}${area.value === 'deployment' ? 'development' : 'terraform'}.tfvars`;
    chosen.replaceChildren(...units.map((unit, index) => h('div', { class: 'catalog-summary-row' },
      h('div', {}, h('strong', {}, NATIVE_AREA_TITLES[unit.area]), h('p', { class: 'hint' }, unit.valueAlias),
        h('p', { class: 'hint' }, `${unit.syntax === 'hcl-tfvars' ? 'HCL' : 'JSON'}; ${known.has(unit.valueAlias) ? 'existing file' : 'create empty file on first save'}`)),
      h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': `Remove unit ${unit.valueAlias}`,
        onclick: () => { units.splice(index, 1); publish(); paint(); } }, 'Remove'))));
  }
  function publish() {
    if (!units.length) { onChange(null); return; }
    onChange(validateConfiguration({ version: 1, revision: 1, format: 'terraform', profileId, units }));
  }
  area.addEventListener('change', paint);
  const add = h('button', { class: 'btn', type: 'button', onclick: () => {
    error.hidden = true;
    try {
      const root = TERRAFORM_ROOTS[area.value];
      const prefix = root ? `${root}/` : '';
      if (!known.has(`${prefix}variables.tf`) || !known.has(`${prefix}main.tf`)) {
        throw new Error('This repository does not contain variables.tf and main.tf for that native root.');
      }
      const valueAlias = alias.value.trim();
      if (!known.has(valueAlias) && !allowCreate.checked) {
        throw new Error('That operator file is missing (ignored .tfvars may not exist in GitHub). Select an existing file, choose Local, or explicitly create an empty file. Examples are not copied.');
      }
      const candidate = createConfiguration('terraform', [...units, {
        area: area.value, rootAlias: root, valueAlias, syntax: valueAlias.endsWith('.json') ? 'json-tfvars' : 'hcl-tfvars',
        allowCreate: allowCreate.checked, nonsecret: nonsecret.checked,
      }]);
      units.splice(0, units.length, ...candidate.units);
      publish();
      alias.value = '';
      allowCreate.checked = false;
      nonsecret.checked = false;
      paint();
    } catch (failure) { error.textContent = failure.message; error.hidden = false; }
  } }, 'Add native unit');
  listing.append(
    h('p', { class: 'hint' }, 'Select each native root and its operator value file explicitly. Any area can stand alone; multiple files can belong to one folder attachment. Bindings are immutable after attachment.'),
    h('label', { class: 'field' }, 'Area', area),
    h('label', { class: 'field' }, 'Operator value file (repository-relative)', alias, candidates),
    h('label', { class: 'catalog-persist' }, allowCreate, h('span', {}, 'Create an empty operator file if absent; never copy examples or defaults')),
    h('p', { class: 'hint' }, `For Local creation: ${NATIVE_LOCAL_CREATION_NOTICE}`),
    h('label', { class: 'catalog-persist' }, nonsecret, h('span', {}, 'This is a nonsecret operator file. Whole-file backups and commits must not contain credentials.')),
    h('p', { class: 'hint' }, 'Known-sensitive files are blocked, including edits to unrelated fields. Detection is conservative, not a guarantee that arbitrary files are secret-free. HCL .tfvars is native; explicit JSON files additionally require your usual -var-file selection.'),
    add, error, chosen);
  paint();
  return listing;
}
