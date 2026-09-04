/** The readiness and provenance rail, and its compact disclosure twin. */

import { chip, el, link, replace } from './dom.mjs';

function block(title, children) {
  return el('section', { class: 'ctx-block' }, [
    el('h2', { class: 'rail-head', text: title }),
    ...(Array.isArray(children) ? children : [children]),
  ]);
}

function readinessRows(model) {
  return model.readiness.groups.map((group) =>
    el('div', { class: 'ctx-row' }, [
      el('span', { class: 'ctx-row-label', text: group.title }),
      group.blocking > 0
        ? chip(`${group.blocking} needed`, 'warning')
        : chip(`${group.supplied}/${group.count}`, 'success', { mono: true }),
    ]),
  );
}

function buildContextNodes(model) {
  const nodes = [];

  nodes.push(
    block('Readiness', [
      el('div', { class: 'ctx-row' }, [
        el('span', { class: 'ctx-row-label', text: 'Configuration' }),
        model.readiness.ready
          ? chip('Complete', 'success')
          : chip(`${model.readiness.blocking.length} needed`, 'warning'),
      ]),
      ...readinessRows(model),
      model.readiness.blocking.length > 0
        ? el('p', {
            class: 'hint',
            text: `Still needed: ${model.readiness.blocking.map((entry) => entry.label).join(', ')}.`,
          })
        : null,
      model.readiness.totalWarningCount > 0
        ? el('p', {
            class: 'hint',
            text: `${model.readiness.totalWarningCount} generated value${model.readiness.totalWarningCount === 1 ? '' : 's'} not known yet. Each one falls back as documented.`,
          })
        : null,
    ]),
  );

  if (model.runtime) {
    nodes.push(
      block('Runtime for this sample', [
        el('div', { class: 'ctx-row' }, [
          el('span', { class: 'ctx-row-label', text: 'Capability' }),
          chip(model.runtime.badge.label, model.runtime.badge.tone),
        ]),
        ...model.runtime.dependencies.map((dependency) =>
          el('div', { class: 'ctx-row' }, [
            el('span', { class: 'ctx-row-label', text: dependency.label }),
            chip(
              dependency.optional && dependency.available === false
                ? 'optional fallback missing'
                : dependency.available === true
                  ? 'present'
                  : dependency.available === false
                    ? 'missing'
                    : 'unknown',
              dependency.available === true
                ? 'success'
                : dependency.optional
                  ? 'neutral'
                  : dependency.available === false
                    ? 'warning'
                    : 'neutral',
            ),
          ]),
        ),
        model.runtime.note ? el('p', { class: 'hint', text: model.runtime.note }) : null,
        ...model.runtime.reasons.map((reason) => el('p', { class: 'hint', text: reason })),
        ...(model.runtime.advisories ?? []).map((advisory) => el('p', { class: 'hint', text: advisory })),
      ]),
    );
  }

  nodes.push(
    block('Prerequisites', [
      model.prerequisites.length
        ? el(
            'div',
            {},
            model.prerequisites.map((prerequisite) =>
              el('div', { class: 'ctx-row' }, [
                el('span', { class: 'ctx-row-label', text: prerequisite.title }),
                chip('manual', 'neutral'),
              ]),
            ),
          )
        : el('p', { class: 'hint', text: 'None beyond the shared profiles.' }),
      el('p', {
        class: 'hint',
        text: 'These are checked by you, not by this page. Nothing here probes your environment.',
      }),
    ]),
  );

  nodes.push(
    block('Risk', [
      el('div', { class: 'ctx-row' }, [
        el('span', { class: 'ctx-row-label', text: 'Level' }),
        chip(model.risk.badge.label, model.risk.badge.tone),
      ]),
      el('div', { class: 'ctx-row' }, [
        el('span', { class: 'ctx-row-label', text: 'Acknowledgement' }),
        chip(model.risk.requiresAcknowledgement ? 'Required' : 'Not required', model.risk.requiresAcknowledgement ? 'warning' : 'neutral'),
      ]),
    ]),
  );

  nodes.push(
    block('Execution', [
      el('div', { class: 'ctx-row' }, [
        el('span', { class: 'ctx-row-label', text: 'Runtime' }),
        chip(model.capability.badge.label, model.capability.badge.tone),
      ]),
      el('div', { class: 'ctx-row' }, [
        el('span', { class: 'ctx-row-label', text: 'State' }),
        chip(model.execution.label, model.execution.tone),
      ]),
      el('p', { class: 'hint', text: model.capability.reason ?? '' }),
    ]),
  );

  nodes.push(
    block('Provenance', [
      el('div', { class: 'ctx-row' }, [
        el('span', { class: 'ctx-row-label', text: 'Notebook cells' }),
        el('span', { class: 'ctx-row-value', text: model.provenance.cells.join(', ') }),
      ]),
      el('p', { class: 'hint', text: model.provenance.note }),
      el('p', { class: 'ctx-hash', text: `${model.provenance.notebook}` }),
      el('p', { class: 'ctx-hash', text: `sha256 ${model.provenance.sha256}` }),
    ]),
  );

  nodes.push(
    block('Scope', [
      el('p', {
        class: 'hint',
        text: 'The source notebook contains no image, multimodal or LLM-inference sample, so this catalogue has none either.',
      }),
      el('p', { class: 'hint' }, [link('Read the full provenance record', '/playground/provenance.json')]),
    ]),
  );

  return nodes;
}

export function renderContext({ rail, compact, model }) {
  replace(rail, buildContextNodes(model));
  if (compact) replace(compact, buildContextNodes(model));
}
