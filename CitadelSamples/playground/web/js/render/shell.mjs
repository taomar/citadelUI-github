/** Signed Run Dossier frame. It renders navigation context, not application state. */

import {
  DOSSIER_IDS,
} from './dossier-contract.mjs';
import { el, replace } from './dom.mjs';
import { renderDirectory } from './directory.mjs';

const TONES = new Set(['brand', 'success', 'warning', 'danger', 'neutral', 'cloud']);

function tone(value, fallback = 'neutral') {
  return TONES.has(value) ? value : fallback;
}

function badge(label, badgeTone = 'neutral', attributes = {}) {
  return el('span', {
    class: 'dossier-shell-badge',
    'data-tone': tone(badgeTone),
    text: label,
    ...attributes,
  });
}

function identifier(value, className = '') {
  return el('code', {
    class: className,
    translate: 'no',
    text: value || 'Not reported',
  });
}

function modelValue(value) {
  if (!value || typeof value !== 'object') return value;
  return value.value ?? value.label ?? value.name ?? value.id ?? '';
}

function contextItem(label, value, detail, { mono = false, state = '' } = {}) {
  return el('div', {
    class: 'execution-context-item',
    'data-context-state': state || undefined,
  }, [
    el('span', { class: 'execution-context-label', text: label }),
    mono
      ? identifier(value, 'execution-context-value')
      : el('span', { class: 'execution-context-value', text: value || 'Not reported' }),
    detail
      ? el('span', { class: 'execution-context-detail', text: detail })
      : null,
  ]);
}

function authorizationContext(value = {}) {
  const authorized = value.proven === true || value.state === 'authorized';
  const ready = value.readyToAttempt === true || value.state === 'ready-to-attempt';
  const blocked = value.readyToAttempt === false || value.state === 'blocked';
  if (authorized) {
    return {
      state: 'authorized',
      label: 'Authorized to operate',
      detail: 'The hosted operator entitlement was enforced by the server.',
    };
  }
  if (ready) {
    return {
      state: 'ready-to-attempt',
      label: 'Ready to Attempt',
      detail: 'Preflight checks allow an attempt. The target still decides authorization.',
    };
  }
  if (blocked) {
    return {
      state: 'blocked',
      label: 'Not Ready to Attempt',
      detail: 'One or more declared checks block this attempt.',
    };
  }
  return {
    state: 'unknown',
    label: 'Authorization Unverified',
    detail: 'No target authorization claim has been made.',
  };
}

function systemLaunchAvailable(identity) {
  return identity.systemBrowser?.available === true
    || identity.launchCapability === 'system-browser'
    || identity.launchCapability === 'wam';
}

function localAuthContext(identity) {
  const kind = String(identity.kind ?? '');
  return kind === 'local-operator'
    || kind.startsWith('azure-cli')
    || identity.authAdapter === 'local';
}

function identitySummary(identity) {
  if (identity.kind === 'gateway-key') return 'Gateway key';
  if (identity.account?.label) return identity.account.label;
  if (identity.account?.name) return identity.account.name;
  if (localAuthContext(identity)) return systemLaunchAvailable(identity) ? 'Microsoft account' : 'Local identity';
  if (identity.kind === 'hosted-relay') return 'Account details';
  return 'Identity unavailable';
}

function identityFact(label, value, { mono = false } = {}) {
  return el('div', { class: 'dossier-identity-fact' }, [
    el('span', { class: 'dossier-identity-label', text: label }),
    mono
      ? identifier(value, 'dossier-identity-value')
      : el('span', { class: 'dossier-identity-value', text: value || 'Not reported' }),
  ]);
}

function renderIdentitySurface(identity = {}, callbacks = {}) {
  const kind = identity.kind ?? 'unavailable';
  const launchAvailable = kind !== 'gateway-key' && systemLaunchAvailable(identity);
  const subscriptions = Array.isArray(identity.subscriptions)
    ? identity.subscriptions.filter((subscription) => subscription.enabled !== false)
    : [];
  const requestedSubscriptionId = identity.selectedSubscriptionId ?? identity.activeSubscription?.id ?? '';
  let selectedId = subscriptions.find((subscription) => subscription.id === requestedSubscriptionId)?.id
    ?? subscriptions[0]?.id
    ?? '';
  const signedIn = identity.state === 'ready' || Boolean(identity.account);
  const loginBusy = ['starting', 'waiting-system-ui', 'verifying', 'cancel-requested'].includes(identity.state);
  const busy = loginBusy || identity.subscriptionBusy === true;

  let body;
  if (kind === 'gateway-key') {
    body = [
      identityFact('Credential', identity.keyPresent ? 'Present in memory' : 'Missing'),
      identityFact('Header', identity.headerName, { mono: true }),
      el('button', {
        type: 'button',
        class: 'dossier-identity-action',
        disabled: identity.canManage === false || typeof callbacks.onIdentity !== 'function',
        text: 'Manage gateway key',
        onclick: () => callbacks.onIdentity?.(),
      }),
    ];
  } else if (launchAvailable) {
    body = [
      identityFact('Account', identity.account?.name ?? identity.account?.label),
      el('button', {
        type: 'button',
        class: 'dossier-identity-action dossier-identity-action-primary',
        disabled:
          identity.canSignIn === false
          || busy
          || typeof (callbacks.onIdentitySignIn ?? callbacks.onIdentity) !== 'function',
        'aria-busy': busy ? 'true' : undefined,
        text: signedIn ? 'Switch Azure account' : 'Sign in with Microsoft',
        onclick: () => (callbacks.onIdentitySignIn ?? callbacks.onIdentity)?.(),
      }),
      identity.message
        ? el('p', {
            class: 'dossier-identity-status',
            role: 'status',
            text: identity.message,
          })
        : null,
      el('label', {
        class: 'dossier-identity-field',
        for: 'dossier-account-subscription',
      }, [
        el('span', { text: 'Account / subscription' }),
        el(
          'select',
          {
            id: 'dossier-account-subscription',
            name: 'execution-account-subscription',
            autocomplete: 'off',
            disabled:
              subscriptions.length === 0
              || identity.canSelectSubscription === false
              || typeof callbacks.onIdentitySubscriptionChange !== 'function',
            onchange: (event) => {
              selectedId = event.target.value;
              callbacks.onIdentitySubscriptionChange?.(selectedId);
            },
          },
          subscriptions.length
            ? subscriptions.map((subscription) =>
                el('option', {
                  value: subscription.id,
                  selected: subscription.id === selectedId,
                  text: subscription.label ?? subscription.name ?? subscription.id,
                }),
              )
            : [el('option', { value: '', text: 'No subscriptions reported' })],
        ),
      ]),
      el('div', { class: 'dossier-identity-actions' }, [
        el('button', {
          type: 'button',
          class: 'dossier-identity-action',
          disabled:
            identity.canVerify !== true
            || identity.verifying === true
            || typeof callbacks.onIdentityVerify !== 'function',
          'aria-busy': identity.verifying === true ? 'true' : undefined,
          text: 'Refresh Azure CLI Status',
          onclick: () => callbacks.onIdentityVerify?.(),
        }),
        el('button', {
          type: 'button',
          class: 'dossier-identity-action',
          disabled:
            identity.canSetActive !== true
            || !selectedId
            || typeof callbacks.onIdentitySetActive !== 'function',
          text: 'Set Active',
          onclick: () => callbacks.onIdentitySetActive?.(selectedId),
        }),
        loginBusy && identity.canCancel === true
          ? el('button', {
              type: 'button',
              class: 'dossier-identity-action',
              disabled: typeof callbacks.onIdentityCancel !== 'function',
              text: 'Cancel sign-in',
              onclick: () => callbacks.onIdentityCancel?.(),
            })
          : null,
      ]),
      el('p', {
        class: 'dossier-identity-warning',
        text: 'Set Active changes only this Citadel playground launch.',
      }),
    ];
  } else if (localAuthContext(identity)) {
    body = [
      identityFact('System sign-in', 'Disabled for this launch'),
      el('p', {
        class: 'dossier-terminal-fallback-note',
        text: identity.terminalFallback?.message
          ?? 'This private Azure CLI session is not exposed to terminals. Restart with system sign-in enabled.',
      }),
      el('button', {
        type: 'button',
        class: 'dossier-identity-action',
        disabled: identity.canVerify !== true || typeof callbacks.onIdentityVerify !== 'function',
        text: 'Refresh Azure CLI Status',
        onclick: () => callbacks.onIdentityVerify?.(),
      }),
    ];
  } else {
    body = [
      identityFact('Account', identity.account?.name ?? identity.account?.label),
      identityFact('Active subscription', identity.activeSubscription?.label ?? identity.activeSubscription?.id, {
        mono: true,
      }),
    ];
  }

  return el('details', {
    id: DOSSIER_IDS.globalIdentity,
    class: 'dossier-identity-surface',
    'data-identity-kind': kind,
    'data-launch-capability': launchAvailable ? identity.launchCapability ?? 'system-browser' : 'unavailable',
    ontoggle: (event) => callbacks.onIdentityToggle?.(event.currentTarget.open),
  }, [
    el('summary', {
      class: 'dossier-identity-summary',
      'aria-label': identitySummary(identity),
      'data-compact-label': identity.kind === 'gateway-key' ? 'Gateway key' : 'Identity',
      text: identitySummary(identity),
    }),
    el('div', { class: 'dossier-identity-panel' }, body),
  ]);
}

function hostedIdentityPath(execution = {}) {
  const hosted = execution.hosted ?? {};
  const rows = [
    ['Entra caller', hosted.entraCaller ?? modelValue(execution.human)],
    ['Playground identity', hosted.playgroundIdentity],
    ['Relay identity', hosted.relayIdentity],
    ['Key Vault / key', hosted.keyReference],
    ['Target', hosted.target ?? modelValue(execution.target)],
  ];
  return el('ol', { class: 'hosted-identity-path', 'aria-label': 'Hosted execution identity path' },
    rows.map(([label, value]) =>
      el('li', {}, [
        el('span', { class: 'hosted-identity-label', text: label }),
        identifier(value, 'hosted-identity-value'),
      ]),
    ),
  );
}

function renderContextBar(execution = {}, identity = {}) {
  const authorization = authorizationContext(execution.authorization);
  const gateway = identity.kind === 'gateway-key';
  const runsAs = gateway ? 'Gateway caller' : modelValue(execution.runsAs);
  const credential = gateway
    ? `Gateway key - ${identity.keyPresent ? 'present in memory' : 'missing'}`
    : execution.runsAs?.credential ?? execution.credential;
  const activeSubscription = execution.activeSubscription ?? identity.activeSubscription ?? {};

  return el('section', {
    class: 'execution-context-bar',
    'aria-label': 'Execution context',
    'data-identity-kind': identity.kind ?? 'unavailable',
  }, [
    el('div', { class: 'execution-context-grid' }, [
      contextItem(
        'Human / account',
        modelValue(execution.human),
        execution.human?.detail,
        { mono: execution.human?.mono === true },
      ),
      contextItem('Runs as / credential', runsAs, credential, {
        mono: execution.runsAs?.mono === true,
      }),
      contextItem(
        'Active subscription',
        modelValue(activeSubscription),
        activeSubscription.detail,
        { mono: activeSubscription.mono !== false },
      ),
      contextItem(
        'Intended target',
        modelValue(execution.target),
        execution.target?.detail,
        { mono: execution.target?.mono !== false },
      ),
      contextItem('Authorization', authorization.label, authorization.detail, {
        state: authorization.state,
      }),
    ]),
    identity.kind === 'hosted-relay' ? hostedIdentityPath(execution) : null,
  ]);
}

function stageProgress(wizard = {}, onStageChange) {
  const steps = Array.isArray(wizard.steps) ? wizard.steps : [];
  const currentIndex = Math.max(0, steps.findIndex((step) => step.id === wizard.currentStep));
  return el('label', {
    class: 'dossier-stage-progress',
    'data-dossier-stage-progress': 'true',
  }, [
    el('span', {
      text: `Step ${currentIndex + 1} of ${Math.max(steps.length, 1)}`,
    }),
    el(
      'select',
      {
        name: 'wizard-step',
        'aria-label': 'Current wizard step',
        onchange: (event) => onStageChange?.(event.target.value),
      },
      steps.map((step, index) =>
        el('option', {
          value: step.id,
          selected: step.id === wizard.currentStep,
          disabled: step.enabled === false,
          text: `${index + 1}. ${step.title}`,
        }),
      ),
    ),
  ]);
}

function scrollWorkspaceByKey(event) {
  if (
    event.defaultPrevented
    || event.target !== event.currentTarget
    || event.altKey
    || event.ctrlKey
    || event.metaKey
  ) {
    return;
  }
  const workspace = event.currentTarget;
  const page = Math.max(40, Math.floor(workspace.clientHeight * 0.85));
  let next = null;
  if (event.key === 'PageDown' || (event.key === ' ' && !event.shiftKey)) {
    next = workspace.scrollTop + page;
  } else if (event.key === 'PageUp' || (event.key === ' ' && event.shiftKey)) {
    next = workspace.scrollTop - page;
  } else if (event.key === 'Home') {
    next = 0;
  } else if (event.key === 'End') {
    next = workspace.scrollHeight;
  }
  if (next === null) return;
  event.preventDefault();
  workspace.scrollTo({ top: next, behavior: 'auto' });
}

export function renderShell({
  container,
  model = {},
  onIdentity,
  onIdentityToggle,
  onIdentitySignIn,
  onIdentitySubscriptionChange,
  onIdentityVerify,
  onIdentitySetActive,
  onIdentityCancel,
  onIdentityTerminalFallback,
  onDirectoryToggle,
  onRecipeSelect,
  onDirectoryQuery,
  onStageChange,
  onOpenProvenance,
  onOpenDiagnostics,
} = {}) {
  if (!container) throw new TypeError('A dossier shell container is required.');

  const recipe = model.recipe ?? {};
  const runner = model.runner ?? {};
  const notebook = model.notebook ?? {};
  const operatorAuthorization = model.operatorAuthorization ?? {};
  const identity = model.identity ?? {};
  const directoryOpen = model.directoryOpen === true;
  const directoryModal = model.directoryModal === true;
  const wizard = model.wizard ?? {};
  const ownerDocument = container.ownerDocument ?? globalThis.document;
  const priorActive = ownerDocument?.activeElement ?? null;
  const priorDirectoryFocused = priorActive?.closest?.(`#${DOSSIER_IDS.recipeDrawer}`) != null;
  const priorSearchSelection = priorActive?.id === 'recipe-directory-search'
    && typeof priorActive.selectionStart === 'number'
    ? { start: priorActive.selectionStart, end: priorActive.selectionEnd }
    : null;
  const inertWhenDirectoryOpen = directoryOpen && directoryModal ? true : undefined;
  const identityCallbacks = {
    onIdentity,
    onIdentityToggle,
    onIdentitySignIn,
    onIdentitySubscriptionChange,
    onIdentityVerify,
    onIdentitySetActive,
    onIdentityCancel,
    onIdentityTerminalFallback,
  };

  const directory = el('nav', {
    id: DOSSIER_IDS.recipeDirectory,
    class: 'recipe-directory',
    'aria-label': 'Recipe directory',
  });
  const drawer = el('aside', {
    id: DOSSIER_IDS.recipeDrawer,
    class: 'dossier-recipe-drawer',
    'data-open': directoryOpen ? 'true' : 'false',
    role: directoryOpen && directoryModal ? 'dialog' : undefined,
    'aria-modal': directoryOpen && directoryModal ? 'true' : undefined,
    'aria-label': directoryOpen && directoryModal ? 'Recipe picker' : undefined,
  }, [
    el('button', {
      type: 'button',
      class: 'dossier-drawer-scrim',
      'aria-label': 'Close recipe picker',
      tabindex: directoryOpen && directoryModal ? '0' : '-1',
      onclick: () => onDirectoryToggle?.(false),
    }),
    directory,
  ]);

  const dossier = el('main', {
    id: DOSSIER_IDS.dossier,
    class: 'dossier-content',
    tabindex: '-1',
    inert: inertWhenDirectoryOpen,
    onkeydown: scrollWorkspaceByKey,
  });
  const actions = el('div', {
    class: 'dossier-action-host',
    inert: inertWhenDirectoryOpen,
  });

  const mobileActions = el('details', { class: 'dossier-mobile-actions' }, [
    el('summary', {
      class: 'dossier-mobile-actions-summary',
      'aria-label': 'Open guide and diagnostics',
      text: 'More',
    }),
    el('div', { class: 'dossier-mobile-actions-panel' }, [
      el('button', {
        type: 'button',
        class: 'dossier-identity-action',
        text: 'Guide and provenance',
        onclick: (event) => {
          event.currentTarget.closest('details').open = false;
          onOpenProvenance?.();
        },
      }),
      el('button', {
        type: 'button',
        class: 'dossier-identity-action',
        text: 'Diagnostics',
        onclick: (event) => {
          event.currentTarget.closest('details').open = false;
          onOpenDiagnostics?.();
        },
      }),
    ]),
  ]);
  const masthead = el('header', {
    id: DOSSIER_IDS.masthead,
    class: 'dossier-masthead',
    inert: inertWhenDirectoryOpen,
  }, [
    el('div', { class: 'dossier-brand' }, [
      el('span', { class: 'dossier-brand-mark', 'aria-hidden': 'true' }),
      el('span', { class: 'dossier-brand-name', text: 'Citadel' }),
      el('span', { class: 'dossier-brand-product', text: 'Publish Playground' }),
    ]),
    el('div', { class: 'dossier-current-recipe' }, [
      el('span', { class: 'dossier-current-label', text: 'Current recipe' }),
      el('span', { class: 'dossier-current-title', text: recipe.title ?? 'Select a recipe' }),
      recipe.id ? identifier(recipe.id, 'dossier-current-id') : null,
    ]),
    el('div', { class: 'dossier-masthead-status' }, [
      badge(runner.label ?? 'Preview only', runner.tone),
      operatorAuthorization.required === true
        ? badge(
            operatorAuthorization.signedIn === true ? 'Signed in' : 'Not signed in',
            operatorAuthorization.signedIn === true ? 'success' : 'warning',
          )
        : null,
      operatorAuthorization.required === true
        ? badge(
            operatorAuthorization.authorized === true
              ? 'Authorized to operate'
              : 'Not authorized to operate',
            operatorAuthorization.authorized === true ? 'success' : 'danger',
          )
        : null,
      badge(
        notebook.verified === true ? 'Notebook verified' : 'Notebook not verified',
        notebook.verified === true ? 'success' : 'warning',
      ),
    ]),
    el('div', { class: 'dossier-masthead-actions' }, [
      el('button', {
        type: 'button',
        class: 'dossier-inspector-button dossier-desktop-command',
        'data-short-label': 'Guide',
        'aria-label': 'Open guide and provenance',
        'aria-controls': DOSSIER_IDS.provenanceDrawer,
        text: 'Guide',
        onclick: () => onOpenProvenance?.(),
      }),
      el('button', {
        type: 'button',
        class: 'dossier-inspector-button dossier-desktop-command',
        'data-short-label': 'Checks',
        'aria-label': 'Open diagnostics',
        'aria-controls': DOSSIER_IDS.diagnosticsDrawer,
        text: 'Checks',
        onclick: () => onOpenDiagnostics?.(),
      }),
      mobileActions,
      renderIdentitySurface(identity, identityCallbacks),
    ]),
  ]);
  const contextBar = renderContextBar(model.execution, identity);
  if (directoryOpen && directoryModal) contextBar.setAttribute('inert', '');
  const workspaceBar = el('div', {
    class: 'dossier-workspace-bar',
    inert: inertWhenDirectoryOpen,
  }, [
    el('button', {
      type: 'button',
      class: 'dossier-directory-toggle',
      'aria-controls': DOSSIER_IDS.recipeDrawer,
      'aria-expanded': directoryOpen ? 'true' : 'false',
      text: 'Recipes',
      onclick: () => onDirectoryToggle?.(!directoryOpen),
    }),
    stageProgress(wizard, onStageChange),
  ]);

  const root = el('div', {
    id: DOSSIER_IDS.shell,
    class: 'dossier-shell',
    'data-directory-open': directoryOpen ? 'true' : 'false',
    'data-runner-mode': runner.mode ?? 'preview',
    onkeydown: (event) => {
      if (directoryOpen && directoryModal && event.key === 'Escape') {
        event.preventDefault();
        onDirectoryToggle?.(false);
      }
    },
  }, [
    masthead,
    contextBar,
    workspaceBar,
    drawer,
    dossier,
    actions,
    el('p', {
      id: DOSSIER_IDS.liveRegion,
      class: 'visually-hidden',
      role: 'status',
      'aria-live': 'polite',
    }),
  ]);

  replace(container, root);
  renderDirectory({
    container: directory,
    model: model.directory,
    onSelect: onRecipeSelect,
    onQuery: onDirectoryQuery,
    onClose: () => onDirectoryToggle?.(false),
  });

  if (directoryOpen) {
    const search = directory.querySelector('#recipe-directory-search');
    search?.focus();
    if (search && priorSearchSelection) {
      search.setSelectionRange(priorSearchSelection.start, priorSearchSelection.end);
    }
  } else if (priorDirectoryFocused) {
    root.querySelector('.dossier-directory-toggle')?.focus();
  }

  return Object.freeze({ root, dossier, actions, directory, drawer });
}
