import { DOSSIER_IDS } from './dossier-contract.mjs';
import { el, facts, replace } from './dom.mjs';

const NOT_SUPPLIED = 'Not supplied';

function present(value, fallback = NOT_SUPPLIED) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function riskOf(model) {
  return model.risk ?? model.sample?.risk ?? model.request?.plan?.risk ?? {};
}

function identityOf(model) {
  const identity = model.identity ?? {};
  const legacy = model.executionIdentity ?? {};
  return {
    human: present(identity.human ?? identity.humanIdentity ?? identity.principalName),
    execution: present(identity.execution ?? identity.executionIdentity ?? identity.runsAs ?? legacy.runsAs),
    tenant: present(identity.tenant ?? identity.tenantId ?? legacy.authority?.tenantId),
    subscription: present(
      identity.subscription ??
        identity.subscriptionName ??
        identity.subscriptionId ??
        legacy.subscription?.activeName ??
        legacy.subscription?.activeId,
    ),
    fingerprint: identity.fingerprint ?? model.identityFingerprint ?? null,
  };
}

function targetOf(model) {
  const target = model.target ?? {};
  return {
    exact: present(target.exact ?? target.summary ?? target.label),
    apimName: present(target.apimName, ''),
    resourceGroup: present(target.resourceGroup ?? target.resourceGroupName),
    tenant: present(target.tenant ?? target.tenantId),
    subscription: present(target.subscription ?? target.subscriptionName ?? target.subscriptionId),
    actionLabel: safeActionTarget(target.actionLabel ?? target.safeActionLabel),
    fingerprint: target.fingerprint ?? model.targetFingerprint ?? null,
  };
}

function authorizationOf(model) {
  const authorization = model.authorization ?? {};
  const proven = authorization.backendProven === true;
  const ready =
    authorization.ready === true ||
    proven ||
    /^ready to attempt$/i.test(present(authorization.label, ''));
  return {
    proven,
    label: ready ? 'Ready to Attempt' : 'Not Ready',
    summary: proven
      ? present(authorization.summary, 'The backend reported authorization for this exact attempt.')
      : ready
        ? 'The execution context is ready for an attempt. The target may still refuse the operation.'
        : present(authorization.summary, 'The execution identity or target is not ready for an attempt.'),
  };
}

function operationOf(model) {
  const operation = model.operation ?? {};
  return {
    summary: present(operation.summary ?? model.request?.plan?.summary, 'No operation summary was supplied.'),
    text: present(operation.text ?? operation.exact ?? model.exactOperation ?? model.request?.fullText),
    steps: asList(operation.steps ?? model.request?.steps),
  };
}

function requiredInputsOf(model) {
  const explicit = asList(model.requiredInputs);
  if (explicit.length) return explicit;
  const readiness = model.readiness ?? model.context?.readiness ?? {};
  return asList(readiness.blocking ?? model.configure?.blocking);
}

function requiredInputCount(model) {
  if (Number.isSafeInteger(model.requiredInputCount) && model.requiredInputCount >= 0) {
    return model.requiredInputCount;
  }
  if (Number.isSafeInteger(model.configure?.blockingCount) && model.configure.blockingCount >= 0) {
    return model.configure.blockingCount;
  }
  return requiredInputsOf(model).length;
}

function safeActionTarget(value) {
  const text = present(value, '');
  if (!text || text.length > 80 || /[\r\n<>]/.test(text)) return '';
  return text;
}

function isDestructive(model) {
  return riskOf(model).level === 'destructive';
}

function section(title, children, options = {}) {
  return el('section', { class: `review-section${options.className ? ` ${options.className}` : ''}` }, [
    el('div', { class: 'review-section-head' }, [
      el('h3', { class: 'review-section-title', text: title }),
      options.note ? el('span', { class: 'review-section-note', text: options.note }) : null,
    ]),
    ...(Array.isArray(children) ? children : [children]),
  ]);
}

function compactSection(title, rows, className = '') {
  const visibleRows = rows.filter(([, value]) => {
    const text = present(value);
    return text !== NOT_SUPPLIED && text !== 'Not Reported' && text !== 'Not Signed In';
  });
  if (!visibleRows.length) return null;
  return el('section', { class: `review-context-section${className ? ` ${className}` : ''}` }, [
    el('h3', { class: 'review-context-title', text: title }),
    facts(visibleRows),
  ]);
}

function textList(items, emptyText) {
  if (!items.length) return el('p', { class: 'review-empty', text: emptyText });
  return el(
    'ul',
    { class: 'review-list' },
    items.map((item) =>
      el('li', {
        text:
          typeof item === 'object' && item !== null
            ? present(item.label ?? item.reference ?? item.name ?? item.id)
            : present(item),
      }),
    ),
  );
}

function factList(rows, className = '') {
  const list = facts(rows);
  if (className) list.className = `${list.className} ${className}`.trim();
  return list;
}

function renderAcknowledgement(model, callbacks) {
  const acknowledgement = model.acknowledgement ?? model.request?.acknowledgement ?? {};
  if (isDestructive(model)) {
    return el('div', { class: 'review-ack review-ack-destructive', role: 'note' }, [
      el('p', { class: 'review-ack-title', text: 'Destructive confirmation required' }),
      el('p', {
        class: 'review-ack-copy',
        text: 'The run opens a separate confirmation dialog that repeats the identity, target, and irreversible effect.',
      }),
    ]);
  }
  if (!acknowledgement.required) {
    return el('p', { class: 'review-empty', text: 'No additional acknowledgement is required.' });
  }
  return el('div', { class: 'review-ack', 'data-acknowledged': acknowledgement.satisfied ? 'true' : 'false' }, [
    el('p', {
      class: 'review-ack-copy',
      text: present(
        acknowledgement.prompt ?? acknowledgement.label ?? riskOf(model).acknowledgementPrompt,
        'Acknowledge the stated effect before running.',
      ),
    }),
    el('label', { class: 'review-check' }, [
      el('input', {
        type: 'checkbox',
        'data-acknowledgement': 'true',
        checked: acknowledgement.satisfied === true,
        onchange: (event) => callbacks.onAcknowledge?.(event.target.checked),
      }),
      el('span', { text: 'I understand the effect and want to use this acknowledgement for one run.' }),
    ]),
    el('p', {
      class: 'review-ack-note',
      text: 'Changing the identity, target, or any input invalidates this acknowledgement.',
    }),
  ]);
}

function exactOperationDetails(operation, summary = 'Exact Operation') {
  return el('details', { class: 'review-details review-operation-details' }, [
    el('summary', { text: summary }),
    el('div', { class: 'review-details-body' }, [
      el('p', { class: 'review-copy', text: operation.summary }),
      el('pre', { class: 'review-operation', tabindex: '0', text: operation.text }),
    ]),
  ]);
}

export function renderOperationDisclosure(model, { summary = 'Preview Exact Operation' } = {}) {
  return exactOperationDetails(operationOf(model), summary);
}

function technicalDetails(model, operation, deviations, placeholders) {
  const details = asList(model.technicalDetails ?? model.planDetails);
  const steps = asList(operation.steps);
  if (!details.length && !steps.length && !deviations.length && !placeholders.length) return null;
  return el('details', { class: 'review-details' }, [
    el('summary', { text: 'Technical Details' }),
    el('div', { class: 'review-details-body' }, [
      details.length ? textList(details, '') : null,
      steps.length
        ? el(
            'ol',
            { class: 'review-steps' },
            steps.map((step, index) =>
              el('li', {}, [
                el('span', { class: 'review-step-index', text: String(step.index ?? index + 1) }),
                el('span', {
                  text: present(step.title ?? step.detail ?? step.text, `Step ${index + 1}`),
                }),
              ]),
            ),
          )
        : el('p', { class: 'review-empty', text: 'No additional plan details were supplied.' }),
      deviations.length
        ? el('div', { class: 'review-detail-group' }, [
            el('h4', { text: 'Deviations' }),
            textList(deviations, ''),
          ])
        : null,
      placeholders.length
        ? el('div', { class: 'review-detail-group' }, [
            el('h4', { text: 'Credential Placeholders' }),
            textList(placeholders, ''),
          ])
        : null,
    ]),
  ]);
}

/**
 * Render the decision-first review. The ledger owns the page's single primary
 * action, so this surface never duplicates it.
 */
export function renderReview(container, model, callbacks = {}) {
  container.id = DOSSIER_IDS.review;
  const identity = identityOf(model);
  const target = targetOf(model);
  const authorization = authorizationOf(model);
  const risk = riskOf(model);
  const operation = operationOf(model);
  const deviations = asList(model.deviations ?? model.request?.deviations ?? model.request?.plan?.deviations);
  const placeholders = asList(model.placeholders ?? model.request?.placeholders ?? model.request?.plan?.secretRefs);
  const missingInputs = requiredInputCount(model);
  const readyToAttempt = missingInputs === 0 && model.canRun === true;

  const review = el('article', {
    class: 'dossier-review',
    'data-risk': present(risk.level, 'unknown'),
    'aria-labelledby': `${DOSSIER_IDS.review}-title`,
  }, [
    el('header', { class: 'review-heading' }, [
      el('div', {}, [
        el('h2', {
          id: `${DOSSIER_IDS.review}-title`,
          class: 'review-title',
          text: present(model.title ?? model.sample?.title, 'Run review'),
        }),
        el('p', {
          class: 'review-intro',
          text: 'Confirm the target and impact before this run starts.',
        }),
      ]),
      el('span', {
        class: 'review-state',
        'data-state': missingInputs > 0 ? 'blocked' : readyToAttempt ? 'ready' : 'not-ready',
        text:
          missingInputs > 0
            ? `${missingInputs} Required Input${missingInputs === 1 ? '' : 's'}`
            : readyToAttempt
              ? 'Ready to Attempt'
              : 'Not Ready',
      }),
    ]),
    el('div', { class: 'review-context-grid' }, [
      compactSection('Run Context', [
        ['Runs as', identity.execution],
        ['Target', target.exact],
        ['Authorization', `${authorization.label}. ${authorization.summary}`],
      ], authorization.proven ? 'review-authorization-proven' : ''),
    ]),
    section(
      'Impact',
      [
        factList([
          ['This run will', present(risk.effect)],
          ['Blast radius', present(risk.blastRadius)],
          ['Recovery', present(risk.reversibility)],
        ], 'review-impact-list'),
      ],
      { note: present(risk.level, 'unknown') },
    ),
    section('Acknowledgement', [renderAcknowledgement(model, callbacks)]),
    exactOperationDetails(operation),
    technicalDetails(model, operation, deviations, placeholders),
  ]);

  replace(container, [review]);
  return review;
}

function blockerHref(blocker) {
  const href = present(blocker?.href ?? blocker?.target, '');
  return href.startsWith('#') && !/[\s<>"']/.test(href) ? href : '';
}

function renderBlockers(model, callbacks) {
  const blockers = requiredInputsOf(model);
  if (!blockers.length) return el('p', { class: 'ledger-clear', text: 'No required inputs are blocking review.' });
  return el(
    'ul',
    { class: 'ledger-blockers' },
    blockers.map((blocker) => {
      const label = present(blocker?.label ?? blocker?.path ?? blocker);
      const href = blockerHref(blocker);
      if (!href) return el('li', { text: label });
      return el('li', {}, [
        el('a', {
          href,
          text: label,
          onclick: (event) => {
            callbacks.onBlocker?.(blocker, event);
          },
        }),
      ]);
    }),
  );
}

function primaryAction(model) {
  if (model.running === true) {
    const target = targetOf(model).actionLabel;
    return {
      kind: 'run',
      label: `Run Sample${target ? ` on ${target}` : ''}`,
      disabled: true,
    };
  }
  const missing = requiredInputCount(model);
  if (missing > 0) {
    return {
      kind: 'resolve',
      label: `Resolve ${missing} Required Input${missing === 1 ? '' : 's'}`,
      disabled: model.resolveDisabled === true,
    };
  }
  if (model.reviewed !== true) {
    return { kind: 'review', label: 'Review Sample', disabled: model.reviewDisabled === true };
  }
  const target = targetOf(model).actionLabel;
  return {
    kind: 'run',
    label: `Run Sample${target ? ` on ${target}` : ''}`,
    disabled:
      model.running === true ||
      model.canRun === false ||
      model.runAllowed === false ||
      (!isDestructive(model) &&
        (model.acknowledgement ?? model.request?.acknowledgement)?.required === true &&
        (model.acknowledgement ?? model.request?.acknowledgement)?.satisfied !== true),
  };
}

function invokePrimary(action, trigger, model, callbacks) {
  if (action.kind === 'resolve') {
    callbacks.onResolveInputs?.();
    return;
  }
  if (action.kind === 'review') {
    callbacks.onReview?.();
    return;
  }
  if (isDestructive(model)) {
    callbacks.onRequestDestructiveConfirmation?.(trigger, model);
    return;
  }
  callbacks.onRun?.();
}

/**
 * Render the compact decision ledger. This is the only renderer that emits the
 * contextual primary action.
 */
export function renderLedger(container, model, callbacks = {}) {
  container.id = DOSSIER_IDS.ledger;
  const identity = identityOf(model);
  const target = targetOf(model);
  const authorization = authorizationOf(model);
  const risk = riskOf(model);
  const action = primaryAction(model);
  const missingInputs = requiredInputCount(model);
  const readyToAttempt = missingInputs === 0 && model.canRun === true;
  const destructiveHandlerMissing =
    action.kind === 'run' && isDestructive(model) && typeof callbacks.onRequestDestructiveConfirmation !== 'function';

  const primary = el('button', {
    type: 'button',
    class: 'btn btn-primary ledger-primary',
    'data-primary-action': action.kind,
    'data-dossier-action': action.kind,
    disabled: action.disabled || destructiveHandlerMissing,
    'aria-busy': model.running === true ? 'true' : undefined,
    text: action.label,
  });
  primary.addEventListener('click', () => invokePrimary(action, primary, model, callbacks));

  const ledger = el('aside', { class: 'run-ledger', 'aria-label': 'Run decision ledger' }, [
    el('header', { class: 'ledger-heading' }, [
      el('div', {}, [
        el('p', { class: 'review-eyebrow', text: 'Run ledger' }),
        el('h2', { class: 'ledger-title', text: present(model.shortTitle ?? model.sample?.shortTitle, 'Current sample') }),
      ]),
      el('span', {
        class: 'ledger-state',
        'data-state': missingInputs > 0 ? 'blocked' : model.running ? 'running' : readyToAttempt ? 'ready' : 'not-ready',
        text:
          missingInputs > 0
            ? `${missingInputs} blocked`
            : model.running
              ? 'Attempt in progress'
              : readyToAttempt
                ? 'Ready to Attempt'
                : 'Not Ready',
      }),
    ]),
    el('section', { class: 'ledger-section' }, [
      el('h3', { text: 'Identity' }),
      facts([
        ['Human', identity.human],
        ['Execution', identity.execution],
      ]),
    ]),
    el('section', { class: 'ledger-section' }, [
      el('h3', { text: 'Target' }),
      facts([
        ['Exact target', target.exact],
        ['Tenant', target.tenant],
        ['Subscription', target.subscription],
      ]),
    ]),
    el('section', { class: 'ledger-section' }, [
      el('h3', { text: 'Authorization' }),
      el('p', {
        class: authorization.proven ? 'ledger-authorization is-proven' : 'ledger-authorization',
        text: `${authorization.label}. ${authorization.summary}`,
      }),
    ]),
    el('section', { class: 'ledger-section ledger-risk', 'data-risk': present(risk.level, 'unknown') }, [
      el('h3', { text: 'Risk' }),
      el('p', { class: 'ledger-risk-level', text: present(risk.level, 'unknown') }),
      el('p', { text: present(risk.effect) }),
    ]),
    el('section', { class: 'ledger-section' }, [
      el('h3', { text: 'Blockers' }),
      renderBlockers(model, callbacks),
    ]),
    el('div', {
      class: 'ledger-actions dossier-action-bar',
      'data-dossier-action-bar': 'true',
      'data-dossier-bottom-dock': 'true',
    }, [
      primary,
      model.running
        ? el('button', {
            type: 'button',
            class: 'btn ledger-cancel',
            text: 'Cancel Run',
            onclick: () => callbacks.onCancel?.(),
          })
        : null,
      model.runBlockedReason
        ? el('p', { class: 'ledger-action-reason', role: 'status', text: model.runBlockedReason })
        : null,
    ]),
  ]);

  replace(container, [ledger]);
  return ledger;
}

function confirmationFingerprint(model) {
  const identity = identityOf(model);
  const target = targetOf(model);
  const risk = riskOf(model);
  const operation = operationOf(model);
  return JSON.stringify({
    supplied: model.confirmationFingerprint ?? null,
    identity: {
      supplied: identity.fingerprint,
      fields: [identity.human, identity.execution, identity.tenant, identity.subscription],
    },
    target: {
      supplied: target.fingerprint,
      fields: [target.exact, target.apimName, target.resourceGroup, target.tenant, target.subscription],
    },
    inputs: model.inputFingerprint ?? null,
    effect: [risk.level, risk.effect, risk.blastRadius, risk.reversibility],
    operation: operation.text,
    typedRequirement: typedRequirement(model),
  });
}

function typedRequirement(model) {
  const apimName = targetOf(model).apimName;
  if (apimName) return `DELETE ${apimName}`;
  return present(model.confirmation?.requiredText, '');
}

/**
 * Create and render the destructive confirmation dialog. Calling `open` never
 * runs anything; only an explicit valid confirmation calls `onConfirm`.
 */
export function createDestructiveConfirmationController(container, initialCallbacks = {}) {
  let dialog = null;
  let typedInput = null;
  let confirmButton = null;
  let validation = null;
  let initialFocus = null;
  let activeModel = null;
  let activeCallbacks = initialCallbacks;
  let fingerprint = '';
  let returnFocus = null;
  let requiredText = '';

  function restoreFocus() {
    const target = returnFocus;
    returnFocus = null;
    target?.focus?.();
  }

  function resetEntry() {
    if (typedInput) typedInput.value = '';
    if (validation) validation.textContent = '';
    if (confirmButton) confirmButton.disabled = Boolean(requiredText);
  }

  function close(reason = 'cancel') {
    if (dialog?.open) dialog.close(reason);
  }

  function cancel(reason) {
    resetEntry();
    activeCallbacks.onCancel?.(reason);
  }

  function checkEntry({ announce = false } = {}) {
    const valid = !requiredText || typedInput?.value === requiredText;
    if (confirmButton) confirmButton.disabled = !valid;
    if (validation) {
      validation.textContent = !valid && announce ? `Type ${requiredText} exactly to continue.` : '';
    }
    return valid;
  }

  function confirm() {
    if (!checkEntry({ announce: true })) {
      typedInput?.focus?.();
      return;
    }
    const model = activeModel;
    confirmButton.disabled = true;
    close('confirmed');
    resetEntry();
    activeCallbacks.onConfirm?.(model);
  }

  function buildDialog(model) {
    const identity = identityOf(model);
    const target = targetOf(model);
    const risk = riskOf(model);
    const operation = operationOf(model);
    requiredText = typedRequirement(model);
    const titleId = `${DOSSIER_IDS.destructiveDialog}-title`;
    const descriptionId = `${DOSSIER_IDS.destructiveDialog}-description`;
    initialFocus = el('h2', {
      id: titleId,
      tabindex: '-1',
      text: 'Confirm destructive run',
    });

    typedInput = requiredText
      ? el('input', {
          class: 'ctl destructive-confirmation-input',
          type: 'text',
          autocomplete: 'off',
          spellcheck: 'false',
          'aria-describedby': `${DOSSIER_IDS.destructiveDialog}-validation`,
          oninput: () => checkEntry(),
        })
      : null;
    validation = el('p', {
      id: `${DOSSIER_IDS.destructiveDialog}-validation`,
      class: 'destructive-confirmation-validation',
      role: 'status',
      'aria-live': 'polite',
    });
    confirmButton = el('button', {
      type: 'button',
      class: 'btn btn-primary destructive-confirmation-submit',
      disabled: Boolean(requiredText),
      text: 'Confirm Destructive Run',
      onclick: confirm,
    });

    const form = el(
      'form',
      {
        class: 'destructive-confirmation-form',
        method: 'dialog',
        onsubmit: (event) => event.preventDefault(),
      },
      [
        el('header', { class: 'destructive-confirmation-heading' }, [
          el('p', { class: 'review-eyebrow', text: 'Final destructive check' }),
          initialFocus,
          el('p', {
            id: descriptionId,
            class: 'destructive-confirmation-description',
            text: 'Confirm the identity, exact target, and irreversible effect before this attempt is handed to the runner.',
          }),
        ]),
        el('div', { class: 'destructive-confirmation-scroll' }, [
          compactSection('Identity', [
            ['Human identity', identity.human],
            ['Execution identity', identity.execution],
          ]),
          compactSection('Tenant and subscription', [
            ['Tenant', target.tenant === NOT_SUPPLIED ? identity.tenant : target.tenant],
            ['Subscription', target.subscription === NOT_SUPPLIED ? identity.subscription : target.subscription],
          ]),
          compactSection('Exact target', [
            ['Target', target.exact],
            ['Resource group', target.resourceGroup],
            ['API Management', target.apimName],
          ]),
          compactSection('Destructive effect', [
            ['Effect', present(risk.effect)],
            ['Blast radius', present(risk.blastRadius)],
            ['Reversibility', present(risk.reversibility)],
          ]),
          el('section', { class: 'review-context-section' }, [
            el('h3', { class: 'review-context-title', text: 'Exact generated operation' }),
            el('pre', { class: 'review-operation destructive-confirmation-operation', tabindex: '0', text: operation.text }),
          ]),
          requiredText
            ? el('div', { class: 'destructive-confirmation-entry' }, [
                el('label', { class: 'destructive-confirmation-label' }, [
                  el('span', {}, ['Type ', el('code', { text: requiredText }), ' to continue']),
                  typedInput,
                ]),
                validation,
              ])
            : el('p', {
                class: 'destructive-confirmation-description',
                text: 'No API Management name was supplied, so this confirmation does not invent a typed target.',
              }),
        ]),
        el('footer', { class: 'destructive-confirmation-actions' }, [
          el('button', {
            type: 'button',
            class: 'btn',
            text: 'Cancel',
            onclick: () => {
              cancel('button');
              close('cancel');
            },
          }),
          confirmButton,
        ]),
      ],
    );

    dialog = el(
      'dialog',
      {
        id: DOSSIER_IDS.destructiveDialog,
        class: 'destructive-confirmation',
        'aria-modal': 'true',
        'aria-labelledby': titleId,
        'aria-describedby': descriptionId,
      },
      [form],
    );
    dialog.addEventListener('cancel', () => {
      cancel('escape');
    });
    dialog.addEventListener('close', restoreFocus);
    return dialog;
  }

  function discard() {
    close('invalidated');
    resetEntry();
    activeModel = null;
    fingerprint = '';
    replace(container, []);
    dialog = null;
    typedInput = null;
    confirmButton = null;
    validation = null;
    initialFocus = null;
    requiredText = '';
  }

  function render(model, callbacks = {}) {
    const nextFingerprint = confirmationFingerprint(model);
    activeCallbacks = { ...initialCallbacks, ...callbacks };
    if (dialog && nextFingerprint === fingerprint) {
      activeModel = model;
      return dialog;
    }
    if (dialog) discard();
    activeModel = model;
    fingerprint = nextFingerprint;
    const nextDialog = buildDialog(model);
    replace(container, [nextDialog]);
    return nextDialog;
  }

  function open(trigger) {
    if (!dialog || !activeModel) return false;
    if (dialog.open) return true;
    if (typeof dialog.showModal !== 'function') {
      throw new Error('Native dialog.showModal() is required for destructive confirmation.');
    }
    returnFocus = trigger?.focus ? trigger : null;
    resetEntry();
    dialog.showModal();
    initialFocus?.focus?.();
    return true;
  }

  function invalidate(nextModelOrFingerprint) {
    const nextFingerprint =
      typeof nextModelOrFingerprint === 'string'
        ? nextModelOrFingerprint
        : nextModelOrFingerprint
          ? confirmationFingerprint(nextModelOrFingerprint)
          : '';
    if (!dialog || nextFingerprint === fingerprint) return false;
    discard();
    return true;
  }

  return {
    render,
    open,
    close,
    invalidate,
    destroy: discard,
    get dialog() {
      return dialog;
    },
    get fingerprint() {
      return fingerprint;
    },
  };
}
