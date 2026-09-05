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

function identityFact(label, value, { mono = false } = {}) {
  return el('div', { class: 'dossier-identity-fact' }, [
    el('span', { class: 'dossier-identity-label', text: label }),
    mono
      ? identifier(value, 'dossier-identity-value')
      : el('span', { class: 'dossier-identity-value', text: value || 'Not reported' }),
  ]);
}

function renderIdentitySurface(identity = {}, callbacks = {}) {
  if (identity.kind === 'hosted-bff') return renderHostedIdentity(identity, callbacks);
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
  const showStatus = busy || identity.statusImportant === true
    || !['ready', 'signed-out', 'unknown', 'unavailable'].includes(identity.state);

  if (!localAuthContext(identity)) return null;
  return el('section', {
    id: DOSSIER_IDS.globalIdentity,
    class: 'task-identity',
    'aria-label': 'Azure account for this launch',
    'data-identity-kind': kind,
    'data-launch-capability': launchAvailable ? identity.launchCapability ?? 'system-browser' : 'unavailable',
  }, [
    el('div', { class: 'task-identity-intro' }, [
      el('div', {}, [
        el('h2', { text: signedIn ? 'Azure account' : 'Sign in to this launch' }),
        el('p', {
          text: signedIn
            ? identity.account?.name ?? identity.account?.label
            : launchAvailable
              ? 'Use the system browser to sign in to this launch-private Azure CLI session.'
              : identity.terminalFallback?.message
                ?? 'System sign-in is disabled. This private Azure CLI session is not exposed to terminals.',
        }),
      ]),
      el('button', {
        id: 'dossier-identity-sign-in',
        type: 'button',
        class: 'dossier-identity-action dossier-identity-action-primary',
        disabled: !launchAvailable || identity.canSignIn === false || busy
          || typeof callbacks.onIdentitySignIn !== 'function',
        'aria-busy': loginBusy ? 'true' : undefined,
        text: signedIn ? 'Switch Azure account' : 'Sign in with Microsoft',
        onclick: () => callbacks.onIdentitySignIn?.(),
      }),
    ]),
    showStatus && identity.message
      ? el('p', { class: 'dossier-identity-status', role: 'status', text: identity.message })
      : null,
    loginBusy && identity.canCancel === true
      ? el('button', {
          id: 'dossier-identity-cancel',
          type: 'button',
          class: 'dossier-identity-action',
          disabled: typeof callbacks.onIdentityCancel !== 'function',
          text: 'Cancel sign-in',
          onclick: () => callbacks.onIdentityCancel?.(),
        })
      : null,
    signedIn || subscriptions.length
      ? el('div', { class: 'task-active-subscription' }, [
          identityFact('Active subscription', identity.activeSubscription?.label ?? identity.activeSubscription?.id, { mono: true }),
          el('p', { text: 'The active CLI subscription is separate from the intended recipe target.' }),
        ])
      : null,
    el('details', { class: 'task-account-controls', 'data-disclosure-key': 'account-controls' }, [
      el('summary', { id: 'dossier-account-toggle', text: signedIn ? 'Account / subscription' : 'Azure CLI status' }),
      !showStatus && identity.message
        ? el('p', { class: 'dossier-identity-status', text: identity.message })
        : null,
      signedIn || subscriptions.length ? el('div', { class: 'task-subscription-controls' }, [
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
        el('button', {
          id: 'dossier-subscription-set-active',
          type: 'button',
          class: 'dossier-identity-action',
          disabled:
            identity.canSetActive !== true
            || !selectedId
            || typeof callbacks.onIdentitySetActive !== 'function',
          text: 'Set Active',
          onclick: () => callbacks.onIdentitySetActive?.(selectedId),
        }),
      ]) : null,
      el('button', {
        id: 'dossier-identity-refresh',
        type: 'button',
        class: 'dossier-identity-action',
        disabled: identity.canVerify !== true || identity.verifying === true
          || typeof callbacks.onIdentityVerify !== 'function',
        'aria-busy': identity.verifying === true ? 'true' : undefined,
        text: 'Refresh Azure CLI Status',
        onclick: () => callbacks.onIdentityVerify?.(),
      }),
      signedIn ? el('p', {
        class: 'dossier-identity-warning',
        text: 'Set Active changes only this Citadel playground launch.',
      }) : null,
    ]),
  ]);
}

function renderHostedIdentity(identity, callbacks) {
  const auth = identity.auth;
  const action = (id, label, callback, disabled = false) => el('button', {
    id, type: 'button', class: 'dossier-identity-action', text: label,
    disabled: disabled || identity.busy || typeof callback !== 'function', onclick: callback,
  });
  return el('section', { id: DOSSIER_IDS.globalIdentity, class: 'task-identity', 'aria-label': 'Application account' }, [
    el('h2', { text: auth.signedIn ? 'Application account' : 'Sign in to Citadel' }),
    el('p', { text: auth.account?.name ?? 'Sign in with Microsoft here. No terminal or launch link is required.' }),
    !auth.signedIn ? el('p', { text: 'The selected recipe and non-secret inputs return after sign-in. Gateway keys are not saved and must be re-entered.' }) : null,
    auth.available
      ? action('dossier-identity-sign-in', auth.signedIn ? 'Switch account' : 'Sign in with Microsoft', callbacks.onIdentitySignIn, auth.pending)
      : el('p', { role: 'status', text: auth.recovering ? 'The application session is temporarily unavailable. Retry the connection here.'
        : 'The deployment owner must configure Microsoft sign-in before this application can authenticate operators.' }),
    auth.recovering ? action('dossier-identity-retry', 'Retry connection', callbacks.onIdentityRetry) : null,
    auth.signedIn ? action('dossier-identity-sign-out', 'Sign out', callbacks.onIdentitySignOut) : null,
    auth.pending ? action('dossier-identity-cancel', 'Cancel pending sign-in', callbacks.onIdentityCancel) : null,
    auth.signedIn && !auth.authorized ? el('p', { role: 'status', text: 'This account has no configured operator entitlement. Contact the deployment owner.' }) : null,
    identity.message ? el('p', { role: 'status', text: identity.message }) : null,
    identity.management && auth.authorized ? el('div', {}, [
      el('p', { text: 'Azure requests use this account through a server-owned delegated token. No Azure CLI session is involved.' }),
      !auth.azureConnected ? action('dossier-connect-azure', 'Connect Azure', callbacks.onIdentityConnectAzure) : null,
      auth.azureConnected ? action('dossier-load-subscriptions', 'Load subscriptions', callbacks.onIdentityVerify) : null,
      auth.azureConnected ? el('label', { for: 'dossier-hosted-subscription', text: 'Permitted Azure subscription' }) : null,
      auth.azureConnected ? el('select', {
        id: 'dossier-hosted-subscription', disabled: identity.busy,
        onchange: (event) => callbacks.onIdentitySubscriptionChange?.(event.target.value),
      }, [
        el('option', { value: '', text: 'Choose a subscription', selected: !identity.selectedSubscriptionId }),
        ...(identity.subscriptions ?? []).map((item) => el('option', {
          value: item.id, text: `${item.name || item.id} (${item.id})`,
          selected: item.id === identity.selectedSubscriptionId,
        })),
      ]) : null,
      auth.azureConnected ? action('dossier-use-subscription', 'Use subscription', () => callbacks.onIdentitySetActive?.(identity.selectedSubscriptionId), !identity.selectedSubscriptionId) : null,
      auth.selectedSubscription ? el('p', { text: `Selected subscription: ${auth.selectedSubscription.name || auth.selectedSubscription.id}` }) : null,
    ]) : null,
    !identity.management && identity.supported ? el('p', { text: 'Application sign-in authorizes use of Citadel. This recipe uses the gateway key, not an Azure account token.' }) : null,
    identity.supported === false ? el('p', { role: 'status', text: 'This recipe needs a separately approved protected Docker adapter. Signing in does not enable it.' }) : null,
    auth.issues?.length ? el('details', {}, [
      el('summary', { text: 'Deployment configuration requirements' }),
      ...auth.issues.map((issue) => el('p', { text: issue })),
    ]) : null,
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

function renderContextBar(execution = {}, identity = {}, { runner = {}, notebook = {}, operatorAuthorization = {} } = {}) {
  const authorization = authorizationContext(execution.authorization);
  const gateway = identity.kind === 'gateway-key';
  const runsAs = gateway ? 'Gateway caller' : modelValue(execution.runsAs);
  const credential = gateway
    ? `Gateway key - ${identity.keyPresent ? 'present in memory' : 'missing'}`
    : execution.runsAs?.credential ?? execution.credential;
  const activeSubscription = execution.activeSubscription ?? identity.activeSubscription ?? {};

  const body = el('div', { class: 'execution-context-body' }, [
    contextItem('Runner', runner.label ?? 'Preview only'),
    contextItem('Protected source', notebook.verified === true ? 'Notebook verified' : 'Notebook not verified'),
    operatorAuthorization.required === true
      ? contextItem('Hosted operator access',
          operatorAuthorization.authorized === true ? 'Authorized to operate' : 'Not authorized to operate',
          operatorAuthorization.signedIn === true ? 'Signed in' : 'Not signed in')
      : null,
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

  return el('section', {
    class: 'execution-context-bar',
    'aria-label': 'Execution context',
    'data-identity-kind': identity.kind ?? 'unavailable',
  }, [
    el('details', {
      class: 'execution-context-disclosure',
      'data-disclosure-key': 'execution-details',
    }, [
      el('summary', { id: 'dossier-execution-toggle', class: 'execution-context-summary' }, [
        el('span', { class: 'execution-context-summary-label', text: 'Execution Details' }),
      ]),
      body,
    ]),
  ]);
}

function canReceiveModalFocus(element) {
  if (element.tabIndex < 0 || element.matches(':disabled') || element.closest('[hidden], [inert]')) return false;
  const style = element.ownerDocument.defaultView.getComputedStyle(element);
  if (style.visibility === 'hidden' || style.visibility === 'collapse' || !element.getClientRects().length) return false;
  // Chromium can report rectangles for unfocusable content in a closed details.
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName !== 'DETAILS' || parent.open) continue;
    const summary = [...parent.children].find((child) => child.tagName === 'SUMMARY');
    if (!summary?.contains(element)) return false;
  }
  return true;
}

function trapModalFocus(event, container, onClose) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation?.();
    onClose?.();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...container.querySelectorAll(
    'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary',
  )].filter(canReceiveModalFocus);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  const active = container.ownerDocument?.activeElement;
  if (!focusable.includes(active)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
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
  onIdentitySignOut,
  onIdentityConnectAzure,
  onIdentityRetry,
  onIdentitySubscriptionChange,
  onIdentityVerify,
  onIdentitySetActive,
  onIdentityCancel,
  onIdentityTerminalFallback,
  onDirectoryToggle,
  onRecipeSelect,
  onDirectoryQuery,
  onDirectoryGroupChange,
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
  const directoryCount = Number.isFinite(model.directory?.catalogueTotal)
    ? model.directory.catalogueTotal
    : Number.isFinite(model.directory?.total)
      ? model.directory.total
      : 0;
  const ownerDocument = container.ownerDocument ?? globalThis.document;
  const priorActive = ownerDocument?.activeElement ?? null;
  const priorDirectoryFocused = priorActive?.closest?.(`#${DOSSIER_IDS.recipeDrawer}`) != null;
  const priorDirectory = container.querySelector(`#${DOSSIER_IDS.recipeDirectory}`);
  const priorListScroll = priorDirectory?.querySelector('.recipe-directory-groups')?.scrollTop ?? 0;
  const priorDirectoryOpen = container.querySelector(`#${DOSSIER_IDS.recipeDrawer}`)?.dataset.open === 'true';
  const recipeChanged = priorDirectory?.dataset.recipeId !== recipe.id;
  const queryChanged = priorDirectory?.dataset.query !== (model.directory?.query ?? '');
  const revealSelected = directoryOpen && (!priorDirectoryOpen || recipeChanged);
  const priorSearchSelection = priorActive?.id === 'recipe-directory-search'
    && typeof priorActive.selectionStart === 'number'
    ? { start: priorActive.selectionStart, end: priorActive.selectionEnd }
    : null;
  const inertWhenDirectoryOpen = directoryOpen && directoryModal ? true : undefined;
  const identityCallbacks = {
    onIdentity,
    onIdentityToggle,
    onIdentitySignIn,
    onIdentitySignOut,
    onIdentityConnectAzure,
    onIdentityRetry,
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
    onkeydown: directoryOpen && directoryModal
      ? (event) => trapModalFocus(event, drawer, () => onDirectoryToggle?.(false))
      : undefined,
  }, [
    el('button', {
      type: 'button',
      class: 'dossier-drawer-scrim',
      'aria-label': 'Close recipe picker',
      tabindex: '-1',
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

  const mobileActions = el('details', { class: 'dossier-mobile-actions' }, [
    el('summary', {
      id: 'dossier-mobile-actions-toggle',
      class: 'dossier-mobile-actions-summary',
      'aria-label': 'Open guide and diagnostics',
      text: 'More',
    }),
    el('div', { class: 'dossier-mobile-actions-panel' }, [
      el('button', {
        id: 'dossier-mobile-guide',
        type: 'button',
        class: 'dossier-identity-action',
        text: 'Guide and provenance',
        onclick: (event) => {
          event.currentTarget.closest('details').open = false;
          onOpenProvenance?.();
        },
      }),
      el('button', {
        id: 'dossier-mobile-diagnostics',
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
    el('div', { class: 'dossier-current-recipe visually-hidden' }, [
      recipe.id ? identifier(recipe.id, 'dossier-current-id') : null,
    ]),
    el('div', { class: 'dossier-masthead-status' }, [
      badge(runner.label ?? 'Preview only', runner.tone),
    ]),
    el('div', { class: 'dossier-masthead-actions' }, [
      el('button', {
        id: 'dossier-guide',
        type: 'button',
        class: 'dossier-inspector-button dossier-desktop-command',
        'data-short-label': 'Guide',
        'aria-label': 'Open guide and provenance',
        'aria-controls': DOSSIER_IDS.provenanceDrawer,
        text: 'Guide',
        onclick: () => onOpenProvenance?.(),
      }),
      el('button', {
        id: 'dossier-diagnostics',
        type: 'button',
        class: 'dossier-inspector-button dossier-desktop-command',
        'data-short-label': 'Checks',
        'aria-label': 'Open diagnostics',
        'aria-controls': DOSSIER_IDS.diagnosticsDrawer,
        text: 'Checks',
        onclick: () => onOpenDiagnostics?.(),
      }),
      mobileActions,
    ]),
  ]);
  const contextBar = renderContextBar(model.execution, identity, { runner, notebook, operatorAuthorization });
  const identitySurface = renderIdentitySurface(identity, identityCallbacks);
  const workspaceBar = el('div', {
    class: 'dossier-workspace-bar',
    inert: inertWhenDirectoryOpen,
  }, [
    el('button', {
      id: 'dossier-directory-toggle',
      type: 'button',
      class: 'dossier-directory-toggle',
      'aria-controls': DOSSIER_IDS.recipeDrawer,
      'aria-expanded': directoryOpen ? 'true' : 'false',
      'aria-label': directoryCount > 0
        ? `Browse all ${directoryCount} recipes. Current recipe: ${recipe.title ?? 'none selected'}`
        : `Browse recipes. Current recipe: ${recipe.title ?? 'none selected'}`,
      onclick: () => onDirectoryToggle?.(!directoryOpen),
    }, [
      el('span', {
        class: 'dossier-directory-toggle-icon',
        'aria-hidden': 'true',
      }),
      el('span', { class: 'dossier-directory-toggle-copy' }, [
        el('span', {
          class: 'dossier-directory-toggle-label',
          text: 'Browse Recipes',
        }),
        el('span', {
          class: 'dossier-directory-toggle-current',
          text: recipe.title ?? 'Choose a recipe',
        }),
      ]),
      directoryCount > 0
        ? el('span', {
            class: 'dossier-directory-toggle-count',
            'aria-hidden': 'true',
            text: String(directoryCount),
          })
        : null,
    ]),
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
    workspaceBar,
    drawer,
    dossier,
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
    onGroupChange: onDirectoryGroupChange,
    onClose: () => onDirectoryToggle?.(false),
  });

  directory.dataset.recipeId = recipe.id ?? '';
  const list = directory.querySelector('.recipe-directory-groups');
  if (list && !revealSelected && !queryChanged) list.scrollTop = priorListScroll;

  if (directoryOpen && (!priorDirectoryOpen || priorDirectoryFocused)) {
    const search = directory.querySelector('#recipe-directory-search');
    const previous = priorActive?.id ? ownerDocument.getElementById(priorActive.id) : null;
    const target = previous && directory.contains(previous) && canReceiveModalFocus(previous)
      ? previous
      : search;
    target?.focus({ preventScroll: true });
    if (search && priorSearchSelection) {
      search.setSelectionRange(priorSearchSelection.start, priorSearchSelection.end);
    }
  } else if (!directoryOpen && priorDirectoryFocused) {
    root.querySelector('.dossier-directory-toggle')?.focus();
  }

  if (revealSelected) {
    requestAnimationFrame(() => {
      if (!list?.isConnected) return;
      const selected = directory.querySelector('[aria-current="page"]');
      if (!selected || selected.closest('details:not([open])')) return;
      const bounds = list.getBoundingClientRect();
      const row = selected.getBoundingClientRect();
      if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom;
      else if (row.top < bounds.top) list.scrollTop -= bounds.top - row.top;
    });
  }

  return Object.freeze({ root, dossier, contextBar, identitySurface, directory, drawer });
}
