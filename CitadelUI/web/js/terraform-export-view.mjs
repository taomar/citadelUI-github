import { h, mount } from './dom.mjs';
import { confirmDialog } from './dialog.mjs';
import { renderParamDocument, renderOutlineNav } from './paramview.mjs';
import { renderValue } from './fields.mjs';
import { editorField, preserveEditorFocus } from './editor-focus.mjs';
import { EXPORT_STATUS, exportPathKey } from '../../shared/terraform-export.mjs';
import { hclLiteral, TerraformExportError } from '../../shared/terraform-literals.mjs';

export async function downloadTerraformZip(file) {
  if (!(file.bytes instanceof Uint8Array) || file.bytes.length < 22) throw new Error('The reviewed ZIP bytes are unavailable.');
  const blob = new Blob([file.bytes], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: file.name });
  try {
    document.body.append(link);
    link.click();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  } finally {
    link.remove();
  }
  // Give the browser time to consume the Blob; never revoke before click.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const badge = (status) => h('span', { class: `chip tf-status tf-status-${status}` }, EXPORT_STATUS[status]);
const code = (text) => h('code', {}, text);
const denyEdit = () => { throw new Error('Saved-source export does not edit Bicep. Exit export to author changes.'); };
const SERVICE_ANCHORS = {
  Basics: 'environmentName', APIM: 'apimServiceName', 'Key Vault': 'keyVaultName',
  Monitoring: 'azureMonitorLogSettings', 'Event Hub': 'eventHubCapacityUnits', 'Logic App': 'logicAppsSkuName',
  Foundry: 'aiFoundryInstances', Identity: 'entraAuth', 'API Center': 'enableAPICenter',
};

function lockSource(root, includingTargets = false) {
  const descendants = [...root.querySelectorAll('input, select, textarea')];
  const controls = root.matches('input, select, textarea') ? [root, ...descendants] : descendants;
  for (const control of controls) {
    if (!includingTargets && control.closest('.tf-target')) continue;
    control.disabled = true;
    control.setAttribute('aria-readonly', 'true');
  }
  for (const button of root.querySelectorAll('button')) {
    if (!includingTargets && button.closest('.tf-target')) continue;
    if (['lm-name', 'lm-editor-toggle', 'rec-toggle'].some((name) => button.classList.contains(name))) continue;
    button.disabled = true;
    button.hidden = true;
  }
}

function readOnlyContext(expanded, rerender) {
  return {
    readOnly: true, allParameters: true, completeProjection: true, onChange: denyEdit, onAppend: denyEdit, onRemove: denyEdit,
    onAddProperty: denyEdit, applyObject: denyEdit, resolveEnv: () => null,
    pendingFor: () => false, findingsFor: () => [], schemaFor: () => null, paramValue: () => undefined,
    isOpen: (key, fallback) => expanded.has(key) ? expanded.get(key) : fallback,
    setOpen: (key, value) => expanded.set(key, value), rerender,
  };
}

/** Main-page projection, isolated from normal actions, drafts, subscriptions and saves. */
export async function openTerraformExport({
  session, surface, onExit = () => {}, download = downloadTerraformZip, confirm = confirmDialog,
}) {
  const nodes = [surface.workspace, surface.areas, surface.actions, surface.rail].filter(Boolean);
  const previous = nodes.map((node) => ({ node, children: [...(node.childNodes || node.children)] }));
  const previousMode = surface.shell.dataset.workspace;
  const previousRail = surface.shell.dataset.rail;
  const previousPath = surface.breadcrumb?.textContent;
  const opener = document.activeElement;
  const body = h('div', { class: 'tf-export-workspace' });
  const footer = h('div', { class: 'tb-command-set' });
  const expandedByArea = new Map();
  const fieldDrafts = new Map();
  const errors = new Map();
  let areaId = 'deployment';
  let view = null;
  let review = null;
  let busy = false;
  let pending = null;
  let closed = false;
  let message = '';
  let tone = 'info';
  let focused = null;
  let actionName = '';
  let inputSequence = 0;

  const expanded = () => {
    if (!expandedByArea.has(areaId)) expandedByArea.set(areaId, new Map());
    return expandedByArea.get(areaId);
  };
  const controls = new Map();
  const remember = (key, node) => { controls.set(key, node); node.dataset.exportFocus = key; return node; };
  const button = (label, handler, { disabled = false, primary = false, key = label } = {}) =>
    remember(key, h('button', {
      type: 'button', class: primary ? 'btn btn-primary' : 'btn', disabled: busy || disabled,
      'aria-busy': busy && actionName === key ? 'true' : null,
      onclick: () => { if (!busy) return handler(); },
    }, busy && actionName === key ? `${label}...` : label));

  function renderKeepingFocus(key) {
    const active = document.activeElement;
    focused = key || active?.dataset.exportFocus;
    preserveEditorFocus(body, render);
    if (focused && (!document.activeElement || document.activeElement === document.body || document.activeElement === active)) {
      controls.get(focused)?.focus({ preventScroll: true });
    }
  }

  function run(key, task) {
    if (busy) return pending;
    busy = true; actionName = key; message = ''; tone = 'info';
    focused = document.activeElement?.dataset.exportFocus || key;
    render();
    pending = (async () => {
      try {
        await task();
      } catch (error) {
        tone = 'error';
        message = error instanceof TerraformExportError ? error.message :
          `Export did not complete: ${error.message || 'Source or download setup failed. Retry after correcting it.'}`;
        review = null;
      } finally {
        busy = false; actionName = '';
        if (!closed) {
          view = session.view();
          render();
          controls.get(focused)?.focus({ preventScroll: true });
        }
      }
    })();
    return pending;
  }

  const currentArea = () => view?.areas.find((entry) => entry.id === areaId);

  function inputField(spec, row) {
    const area = currentArea();
    const key = `${areaId}:${area.path}:${spec.key}`;
    const hasValue = Object.hasOwn(area.choices, spec.key);
    const committed = hasValue ? area.choices[spec.key] : spec.default;
    const draft = fieldDrafts.has(key) ? fieldDrafts.get(key) : committed;
    const inputId = `tf-input-${++inputSequence}`;
    const update = (value) => {
      try {
        session.setInput(areaId, spec.key, value);
        errors.delete(key); fieldDrafts.delete(key); review = null;
        view = session.view();
        renderKeepingFocus(key);
      } catch (error) {
        errors.set(key, error.message);
        renderKeepingFocus(key);
      }
    };
    let control;
    if (spec.confirmation) {
      control = h('input', { type: 'checkbox', checked: committed === true, disabled: busy, onchange: (event) => update(event.target.checked ? true : undefined) });
    } else if (spec.fixed) {
      control = h('span', { class: 'tf-fixed-value' }, hclLiteral(spec.default));
    } else if (spec.enum || spec.type === 'bool') {
      const values = spec.enum || [true, false];
      control = h('select', {
        class: 'ctl', disabled: busy,
        onchange: (event) => update(event.target.value === '' ? undefined : spec.type === 'bool' ? event.target.value === 'true' : event.target.value),
      }, h('option', { value: '' }, 'Choose a value'), values.map((value) => h('option', { value: String(value) }, String(value))));
      control.value = draft === undefined ? '' : String(draft);
    } else if (['array', 'object'].includes(spec.type)) {
      control = h('textarea', {
        class: 'ctl tf-json-input', rows: 4, disabled: busy, spellcheck: false,
        value: typeof draft === 'string' ? draft : draft === undefined ? '' : JSON.stringify(draft, null, 2),
        oninput: (event) => fieldDrafts.set(key, event.target.value),
        onchange: (event) => {
          try { update(JSON.parse(event.target.value)); }
          catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            errors.set(key, 'Enter literal JSON data of the declared type, not Bicep or Terraform expressions.');
            renderKeepingFocus(key);
          }
        },
      });
    } else {
      control = h('input', {
        class: 'ctl', type: spec.type === 'int' ? 'number' : 'text', autocomplete: 'off', spellcheck: false,
        disabled: busy, value: draft ?? '', min: spec.min, max: spec.max,
        oninput: (event) => fieldDrafts.set(key, event.target.value),
        onchange: (event) => update(spec.type === 'int' ? (event.target.value === '' ? undefined : Number(event.target.value)) : event.target.value),
      });
    }
    control.id = inputId;
    control.setAttribute('aria-label', `${spec.source ? 'Export-only source value' : 'Terraform input'} ${spec.label}${spec.confirmation ? ` for ${row.source}` : ''}`);
    if (!spec.fixed) {
      remember(key, control);
      editorField(control, ['terraform', areaId, area.path, spec.key]);
    }
    const defaultAction = spec.acceptDefault && !hasValue
      ? button('Use displayed default', () => update(structuredClone(spec.default)), { key: `${key}:default` }) : null;
    return h('div', { class: 'tf-input-row' },
      h(spec.fixed ? 'div' : 'label', spec.fixed ? {} : { for: inputId }, spec.confirmation ? `${spec.label} for ${row.source}` : spec.label,
        h('span', { class: 'hint' }, spec.source ? ' Export-only; Bicep stays unchanged' : ' Export only')),
      h('div', { class: 'tf-input-control' }, control, defaultAction,
        hasValue ? h('span', { class: 'hint' }, 'Explicit value') : null),
      spec.reason ? h('p', { class: 'hint' }, spec.reason) : null,
      errors.has(key) ? h('p', { class: 'field-error', role: 'alert' }, errors.get(key)) : null);
  }

  function proposedValues(row) {
    const entries = Object.entries(row.proposed || {});
    if (!entries.length) return null;
    const ctx = readOnlyContext(expanded(), () => renderKeepingFocus());
    const values = h('div', { class: 'tf-proposed-values' }, entries.map(([name, value]) => {
      if (value === undefined) return null;
      const rendered = renderValue(value, ['terraform-output', name], ctx,
        { name, type: typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'int' : Array.isArray(value) ? 'array' : typeof value });
      lockSource(rendered, true);
      return h('div', { class: 'tf-proposed-value' }, entries.length > 1 ? code(name) : null, rendered);
    }));
    return values;
  }

  function rowNotes(row, { nested = true } = {}) {
    const notes = row.notes || [];
    const blockers = notes.filter((entry) => ['input', 'change'].includes(entry.status));
    const other = notes.filter((entry) => !['input', 'change'].includes(entry.status));
    return h('div', { class: 'tf-mapping-note' },
      h('div', { class: 'tf-mapping-head' }, badge(row.status),
        h('span', { class: 'hint' }, row.origin || 'Saved source')),
      h('div', { class: 'tf-target-names' }, row.targets?.length ? row.targets.map(code) : h('span', { class: 'hint' }, 'No compatible target')),
      h('small', { class: 'tf-output-path' }, row.outputPath),
      row.sources?.length > 1 ? h('p', { class: 'hint' }, 'Together with: ', row.sources.map(code)) : null,
      blockers.map((entry) => h('p', { class: entry.status === 'change' ? 'field-error' : 'field-warning' },
        entry.path?.length > 1 ? `${entry.path.join('.')}: ` : '', entry.reason)),
      row.inputs?.map((spec) => inputField(spec, row)),
      proposedValues(row),
      other.length || (nested && row.nested?.length) || row.evidence ? h('details', { class: 'tf-mapping-details' },
        h('summary', {}, 'Property mapping and reasons'),
        other.map((entry) => h('p', { class: 'hint' }, entry.reason)),
        nested && row.nested?.length ? h('dl', { class: 'tf-property-list' }, row.nested.map((entry) =>
          h('div', {}, h('dt', {}, code(entry.path.join('.'))),
            h('dd', {}, entry.targets.map(code),
              entry.value !== undefined && !['object'].includes(typeof entry.value) ? h('span', {}, ` = ${String(entry.value)}`) : null,
              entry.reason ? h('span', { class: 'hint' }, entry.reason) : null)))) : null,
        row.evidence ? h('p', { class: 'hint' }, 'Pinned evidence: ', code(row.evidence)) : null) : null);
  }

  function serviceInputs(service, extras) {
    if (!extras.length) return null;
    const needed = extras.filter((entry) => entry.status === 'input').length;
    const defaults = extras.flatMap((row) => row.inputs.filter((spec) => spec.acceptDefault && spec.default !== undefined));
    const disclosureState = expanded();
    const box = h('details', { class: 'tf-service-inputs', open: disclosureState.get(`extra:${service}`) ?? false },
      h('summary', {}, `${service} export-only choices${needed ? ` (${needed} need input)` : ''}`),
      defaults.length ? button(`Use displayed ${service} defaults`, () => {
        for (const spec of defaults) if (!Object.hasOwn(currentArea().choices, spec.key)) session.setInput(areaId, spec.key, structuredClone(spec.default));
        view = session.view(); review = null; renderKeepingFocus(`defaults:${service}`);
      }, { key: `defaults:${service}` }) : null,
      extras.map((row) => h('div', { class: 'tf-extra' },
        h('div', { class: 'tf-mapping-head' }, badge(row.status), code(row.source)),
        row.inputs.length ? row.inputs.map((spec) => inputField(spec, row)) : row.notes.map((entry) => h('p', { class: 'hint' }, entry.reason)),
        row.notes.filter((entry) => entry.status === 'change').map((entry) => h('p', { class: 'field-error' }, entry.reason)),
        row.status !== 'input' ? proposedValues(row) : null)));
    box.addEventListener('toggle', () => disclosureState.set(`extra:${service}`, box.open));
    return box;
  }

  function parameterForm(area) {
    const projection = area.projection;
    const rows = new Map(projection.rows.map((row) => [row.source, row]));
    const attachedServices = new Set();
    const ctx = {
      ...readOnlyContext(expanded(), () => renderKeepingFocus()),
      schemaFor: (name) => projection.document.schema.parameters[name],
      paramValue: (name) => projection.document.params.find((entry) => entry.name === name)?.value,
      decorateParameter: (param, element) => {
        const row = rows.get(param.name);
        if (!row) return element;
        const extra = projection.extras.filter((entry) => entry.service === row.service);
        const showExtras = extra.length && !attachedServices.has(row.service) &&
          (SERVICE_ANCHORS[row.service] === row.source || !rows.has(SERVICE_ANCHORS[row.service]));
        if (showExtras) attachedServices.add(row.service);
        element.classList.add('tf-source-row');
        element.dataset.exportStatus = row.status;
        const note = h('div', { class: 'tf-target' }, rowNotes(row, { nested: param.name !== 'llmBackendConfig' }),
          showExtras ? serviceInputs(row.service, extra) : null);
        // Backends keep their full-width incumbent typed model view. Scalar and
        // object rows gain a fourth datasheet cell instead of a separate report.
        element.append(note);
        return element;
      },
      decorateBackend: (path, element) => {
        const row = rows.get('llmBackendConfig');
        const notes = row.nested.filter((entry) => entry.path[1] === path[1] && entry.path.length === 3);
        const item = h('aside', { class: 'tf-target tf-backend-target', 'aria-label': 'Terraform backend properties' },
          h('h4', {}, 'Terraform backend'),
          notes.map((entry) => h('div', { class: 'tf-property' }, code(entry.targets.join(', ')),
            entry.value === undefined ? h('div', {}, 'Needs input') :
              proposedValues({ proposed: { [entry.targets.join(', ')]: entry.value } }))));
        return h('div', { class: 'tf-backend' }, element, item);
      },
      decorateValue: (path, rendered) => {
        if (path[0] !== 'llmBackendConfig' || path.length < 5) return rendered;
        const row = rows.get(path[0]);
        const entry = row.nested.find((candidate) => exportPathKey(candidate.path) === exportPathKey(path));
        if (!entry) return rendered;
        return h('div', { class: 'tf-model-field' }, rendered,
          h('div', { class: 'tf-property' }, code(entry.targets.join(', ')),
            entry.status === 'change' ? h('span', { class: 'field-error' }, entry.reason) : null));
      },
    };
    const form = renderParamDocument(projection.document, ctx);
    lockSource(form);
    const unattached = projection.extras.filter((entry) => !attachedServices.has(entry.service));
    if (unattached.length) form.append(h('section', { class: 'tf-target tf-extra-section' },
      h('h3', {}, 'Additional target choices'),
      [...new Set(unattached.map((entry) => entry.service))].map((service) =>
        serviceInputs(service, unattached.filter((entry) => entry.service === service)))));
    const nav = renderOutlineNav(projection.document, ctx, (id) => {
      expanded().set('active-section', id);
      for (const item of nav?.querySelectorAll('button') || []) {
        item.classList.toggle('active', item.dataset.section === id);
        item.setAttribute('aria-current', item.dataset.section === id ? 'location' : 'false');
      }
    }, 'tabs');
    return { form, nav };
  }

  function mappingScreen(area) {
    const selector = h('select', {
      class: 'ctl tf-source-selector', disabled: busy,
      'aria-label': `${area.label} source configuration`,
      onchange: (event) => run(`source:${area.id}`, async () => {
        review = null;
        await session.select(area.id, { path: event.target.value || null });
      }),
    }, h('option', { value: '' }, 'Choose one saved configuration'),
    area.configurations.map((path) => h('option', { value: path }, path)));
    selector.value = area.path || '';
    remember(`source:${area.id}`, selector);
    const { form, nav } = area.projection ? parameterForm(area) : {};
    return h('div', { class: 'sheetwrap tf-export-preview' },
      h('div', { class: 'sheet-sticky' },
        h('header', { class: 'sheet-strip' },
          h('div', { class: 'strip-top' }, h('h2', { class: 'strip-title', tabindex: -1, id: 'tf-export-heading' }, `${area.label} - Terraform export`),
            h('span', { class: 'chip chip-note' }, 'Experimental / saved source')),
          h('p', { class: 'hint tf-caption' }, 'Bicep remains the authoring source. Review mapped values beside the original settings; only explicit export-only inputs are editable.')),
        nav),
      h('div', { class: 'tf-source-selection' }, h('label', {}, 'Saved source', selector),
        area.path ? h('p', { class: 'hint tf-output-path tf-selected-source' }, 'Source file: ', code(area.path)) : null,
        h('p', { class: 'hint' }, area.included
          ? `Included: ${area.projection?.path || 'one target-relative variable file'}. One configuration per root; contracts are never merged.`
          : 'Excluded from this ZIP by your area selection. Its inputs are retained while you navigate.')),
      area.error ? h('p', { class: 'field-error tf-notice', role: 'alert' }, area.error) : null,
      !area.path ? h('p', { class: 'tf-notice field-warning' }, 'Choose exactly one configuration. Other contracts will not be merged into it or exported under invented names.') : null,
      area.projection ? h('div', { class: 'sheet-body' },
        h('div', { class: 'tf-column-head', 'aria-hidden': 'true' }, h('span', {}, 'Saved Bicep setting / value'), h('span', {}, 'Terraform property / proposed value / output')),
        form,
        area.projection.unusedTargets.length ? h('details', { class: 'tf-unused' },
          h('summary', {}, 'Declared but unconsumed Terraform inputs'),
          h('p', { class: 'hint' }, 'These target declarations are not emitted as pretend mappings: ', area.projection.unusedTargets.map(code))) : null) : null);
  }

  function reviewScreen() {
    return h('section', { class: 'tf-review' },
      h('h2', { tabindex: -1, id: 'tf-review-heading' }, 'Review Terraform ZIP'),
      h('p', {}, `Exactly ${review.files.length} variable file${review.files.length === 1 ? '' : 's'}, ${review.size} bytes. No wrapper directory, module files, source files, reports or extra policies.`),
      h('p', { class: 'hint' }, 'Approval downloads these bytes only. It does not write a repository, deploy resources, migrate state, or prove resource identity/parity. Source and policy hashes are re-read immediately before download.'),
      review.files.map((file) => h('details', { class: 'tf-review-file', open: true },
        h('summary', {}, code(file.path)),
        h('p', { class: 'hint' }, 'SHA-256 ', code(file.hash)),
        h('pre', { class: 'raw tf-hcl', tabindex: 0, 'aria-label': `Reviewed contents of ${file.path}` }, file.text))),
      h('details', { class: 'tf-review-provenance' },
        h('summary', {}, 'Approval binding and source dependencies'),
        h('p', { class: 'hint' }, 'Mapping ', code(view.contract.version), ' / target ', code(view.contract.revision)),
        h('p', { class: 'hint' }, 'ZIP SHA-256 ', code(review.zipHash)),
        h('p', { class: 'hint' }, 'Review ID ', code(review.id)),
        review.dependencies.map((entry) => h('p', { class: 'hint' }, code(entry.path), ' ', code(entry.hash)))));
  }

  async function requestExit() {
    if (busy) return;
    if (!await confirm({
      title: 'Exit Terraform export?',
      message: 'Export-only inputs and ZIP review will be cleared. Original Bicep, XML and editor state are unchanged.',
      confirmLabel: 'Exit export',
    })) return;
    session.close(); closed = true;
    window.removeEventListener('keydown', shortcut, true);
    window.removeEventListener('beforeunload', unload);
    for (const { node, children } of previous) mount(node, children);
    if (previousMode === undefined) delete surface.shell.dataset.workspace;
    else surface.shell.dataset.workspace = previousMode;
    if (previousRail === undefined) delete surface.shell.dataset.rail;
    else surface.shell.dataset.rail = previousRail;
    surface.shell.classList.remove('terraform-export-mode');
    if (surface.breadcrumb) surface.breadcrumb.textContent = previousPath;
    onExit();
    const replacement = surface.actions.querySelector('[data-terraform-export-entry]');
    const returnTo = opener?.isConnected && opener !== document.body && !opener.disabled ? opener : replacement;
    returnTo?.focus();
  }

  function render() {
    if (closed) return;
    controls.clear();
    inputSequence = 0;
    mount(footer,
      button('Exit export', requestExit),
      button('Reload saved source', () => run('Reload saved source', async () => { review = null; await session.reload(); })),
      review ? button('Back to mapping', () => { session.revise(); review = null; renderKeepingFocus('Review ZIP'); })
        : button('Review ZIP', () => run('Review ZIP', async () => {
          const prefixes = view.areas.filter((area) => area.included).map((area) => `${area.id}:${area.path}:`);
          if ([...fieldDrafts.keys(), ...errors.keys()].some((key) => prefixes.some((prefix) => key.startsWith(prefix)))) {
            throw new TerraformExportError('input', 'Finish or correct the export-only field being edited in an included configuration before review.');
          }
          review = await session.review();
          focused = 'Approve & export ZIP';
        }), { primary: true, disabled: !view?.ready }),
      review ? button('Approve & export ZIP', () => run('Approve & export ZIP', async () => {
        await session.approveAndExport(review.id, download);
        review = null; tone = 'ok';
        message = 'ZIP download requested with the exact reviewed bytes. No repository files were written.';
        focused = 'Review ZIP';
      }), { primary: true }) : null);
    if (!view) {
      mount(body, h('section', { class: 'tf-notice', role: 'status' }, 'Reading saved source and allowed policy dependencies...'));
      return;
    }
    mount(surface.areas, h('div', { class: 'areas tf-area-rail' }, view.areas.map((area) => {
      const included = remember(`include:${area.id}`, h('input', {
        type: 'checkbox', checked: area.included, disabled: busy, 'aria-label': `Include ${area.label} in ZIP`,
        onchange: (event) => run(`include:${area.id}`, async () => {
          review = null;
          await session.select(area.id, { included: event.target.checked });
        }),
      }));
      return h('div', { class: 'tf-area-option' }, h('label', { class: 'tf-include' }, included, 'Include in ZIP'),
        remember(`area:${area.id}`, h('button', {
          type: 'button', class: `area${areaId === area.id ? ' active' : ''}`, disabled: busy,
          'aria-current': areaId === area.id ? 'page' : 'false',
          onclick: () => {
            if (review) session.revise();
            areaId = area.id; review = null; renderKeepingFocus(`area:${area.id}`);
          },
        }, h('span', { class: 'area-title' }, area.label),
        h('span', { class: 'area-sub' }, !area.included ? 'Excluded' : area.error || !area.path ? 'Needs source' :
          area.projection?.blockers.length ? `${area.projection.blockers.length} to resolve` : 'Ready'))));
    })),
    h('div', { class: 'tf-rail-note' }, h('strong', {}, `${view.included} area${view.included === 1 ? '' : 's'} included`),
      h('p', {}, view.ready ? 'All included settings are ready for byte review.' : `${view.blockers} blocking setting${view.blockers === 1 ? '' : 's'}. No partial settings export.`),
      h('p', {}, 'Target ', code(view.contract.revision.slice(0, 12))),
      h('details', {}, h('summary', {}, 'Mapping contract'),
        code(view.contract.version), h('p', {}, view.contract.repository), code(view.contract.revision))));
    if (surface.breadcrumb) surface.breadcrumb.textContent = 'Terraform export / saved source';
    mount(body,
      message ? h('p', { class: `tf-notice ${tone === 'error' ? 'field-error' : tone === 'ok' ? 'tf-success' : 'hint'}`, role: tone === 'error' ? 'alert' : 'status' }, message) : null,
      busy ? h('p', { class: 'tf-notice', role: 'status', 'aria-live': 'polite' }, `${actionName} - please wait. Existing source files stay untouched.`) : null,
      review ? reviewScreen() : mappingScreen(currentArea()));
  }

  const shortcut = (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault(); event.stopImmediatePropagation();
      message = 'Export has no Save action. Use Review ZIP, then Approve & export ZIP.'; tone = 'info'; render();
    } else if (event.key === 'Escape' && !document.getElementById('modal')?.open) {
      event.preventDefault(); event.stopPropagation(); requestExit();
    }
  };
  const unload = (event) => { event.preventDefault(); event.returnValue = ''; };
  window.addEventListener('keydown', shortcut, true);
  window.addEventListener('beforeunload', unload);
  surface.shell.dataset.workspace = 'terraform-export';
  surface.shell.dataset.rail = 'off';
  surface.shell.classList.add('terraform-export-mode');
  if (surface.rail) mount(surface.rail);
  mount(surface.workspace, body); mount(surface.actions, footer);
  await run('Read saved source', async () => { view = await session.initialize(); });
  body.querySelector('h2')?.focus({ preventScroll: true });
  return { body, footer, whenIdle: () => pending, get busy() { return busy; }, get closed() { return closed; } };
}
