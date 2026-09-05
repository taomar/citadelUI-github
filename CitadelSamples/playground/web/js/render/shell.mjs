/** Signed Run Dossier frame. It renders navigation context, not application state. */

import {
  DOSSIER_IDS,
  DOSSIER_STAGE_LABELS,
  DOSSIER_STAGES,
  normalizeDossierStage,
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
  const ready = value.readyToAttempt === true || value.state === 'ready-to-attempt';
  const blocked = value.readyToAttempt === false || value.state === 'blocked';
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
  const subscriptions = Array.isArray(identity.subscriptions) ? identity.subscriptions : [];
  const requestedSubscriptionId = identity.selectedSubscriptionId ?? identity.activeSubscription?.id ?? '';
  let selectedId = subscriptions.find((subscription) => subscription.id === requestedSubscriptionId)?.id
    ?? subscriptions[0]?.id
    ?? '';
  const signedIn = identity.state === 'ready' || Boolean(identity.account);

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
          || identity.state === 'launching'
          || identity.state === 'waiting'
          || typeof (callbacks.onIdentitySignIn ?? callbacks.onIdentity) !== 'function',
        'aria-busy': identity.state === 'launching' || identity.state === 'waiting' ? 'true' : undefined,
        text: signedIn ? 'Switch Azure account' : 'Sign in with Microsoft',
        onclick: () => (callbacks.onIdentitySignIn ?? callbacks.onIdentity)?.(),
      }),
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
          text: 'Verify',
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
      ]),
    ];
  } else if (localAuthContext(identity)) {
    body = [
      identityFact('System sign-in', 'Unavailable in this adapter'),
      el('p', {
        class: 'dossier-terminal-fallback-note',
        text: identity.terminalFallback?.message
          ?? 'Continue in the terminal, then return here and verify the active account.',
      }),
      el('button', {
        type: 'button',
        class: 'dossier-identity-action',
        disabled:
          identity.terminalFallback?.available === false
          || typeof callbacks.onIdentityTerminalFallback !== 'function',
        text: 'Continue in terminal',
        onclick: () => callbacks.onIdentityTerminalFallback?.(),
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

function stageNavigation(currentStage, onStageChange) {
  return el('nav', { class: 'dossier-stage-navigation', 'aria-label': 'Dossier stages' }, [
    el(
      'ol',
      {},
      DOSSIER_STAGES.map((stage, index) =>
        el('li', {}, [
          el('button', {
            type: 'button',
            class: 'dossier-stage-button',
            'aria-current': stage === currentStage ? 'step' : undefined,
            'data-stage': stage,
            onclick: () => onStageChange?.(stage),
          }, [
            el('span', { class: 'dossier-stage-number', 'aria-hidden': 'true', text: String(index + 1) }),
            el('span', { text: DOSSIER_STAGE_LABELS[stage] }),
          ]),
        ]),
      ),
    ),
  ]);
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
  const identity = model.identity ?? {};
  const directoryOpen = model.directoryOpen === true;
  const currentStage = normalizeDossierStage(model.stage);
  const ownerDocument = container.ownerDocument ?? globalThis.document;
  const priorActive = ownerDocument?.activeElement ?? null;
  const priorDirectoryFocused = priorActive?.closest?.(`#${DOSSIER_IDS.recipeDrawer}`) != null;
  const priorSearchSelection = priorActive?.id === 'recipe-directory-search'
    && typeof priorActive.selectionStart === 'number'
    ? { start: priorActive.selectionStart, end: priorActive.selectionEnd }
    : null;
  const inertWhenDirectoryOpen = directoryOpen ? true : undefined;
  const identityCallbacks = {
    onIdentity,
    onIdentityToggle,
    onIdentitySignIn,
    onIdentitySubscriptionChange,
    onIdentityVerify,
    onIdentitySetActive,
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
    role: directoryOpen ? 'dialog' : undefined,
    'aria-modal': directoryOpen ? 'true' : undefined,
    'aria-label': directoryOpen ? 'Recipe picker' : undefined,
  }, [
    el('button', {
      type: 'button',
      class: 'dossier-drawer-scrim',
      'aria-label': 'Close recipe picker',
      tabindex: directoryOpen ? '0' : '-1',
      onclick: () => onDirectoryToggle?.(false),
    }),
    directory,
  ]);

  const dossier = el('main', {
    id: DOSSIER_IDS.dossier,
    class: 'dossier-content',
    tabindex: '-1',
    inert: inertWhenDirectoryOpen,
  });

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
      badge(
        notebook.verified === true ? 'Notebook verified' : 'Notebook not verified',
        notebook.verified === true ? 'success' : 'warning',
      ),
    ]),
    el('div', { class: 'dossier-masthead-actions' }, [
      el('button', {
        type: 'button',
        class: 'dossier-inspector-button',
        'aria-label': 'Open provenance',
        'aria-controls': DOSSIER_IDS.provenanceDrawer,
        text: 'Provenance',
        onclick: () => onOpenProvenance?.(),
      }),
      el('button', {
        type: 'button',
        class: 'dossier-inspector-button',
        'aria-label': 'Open diagnostics',
        'aria-controls': DOSSIER_IDS.diagnosticsDrawer,
        text: 'Diagnostics',
        onclick: () => onOpenDiagnostics?.(),
      }),
      renderIdentitySurface(identity, identityCallbacks),
    ]),
  ]);
  const contextBar = renderContextBar(model.execution, identity);
  if (directoryOpen) contextBar.setAttribute('inert', '');
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
    stageNavigation(currentStage, onStageChange),
  ]);

  const root = el('div', {
    id: DOSSIER_IDS.shell,
    class: 'dossier-shell',
    'data-directory-open': directoryOpen ? 'true' : 'false',
    'data-runner-mode': runner.mode ?? 'preview',
    onkeydown: (event) => {
      if (directoryOpen && event.key === 'Escape') {
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

  return Object.freeze({ root, dossier, directory, drawer });
}
