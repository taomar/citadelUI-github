import { desktopVersionLabel } from './runtime-config.mjs';

export async function installDesktopFooter(window, build, withUpdates) {
  await window.webContents.insertCSS(`
    #citadel-desktop-footer {
      position: fixed;
      left: .5rem;
      bottom: .5rem;
      z-index: 40;
      max-width: 14rem;
      padding: .25rem .375rem;
      border-radius: .2rem;
      color: var(--nav-muted, #c3dcf2);
      background: var(--nav, #0b3c68);
      font-family: inherit;
      font-size: .6875rem;
      line-height: 1.4;
    }
    #citadel-desktop-version { display: block; font-size: inherit; white-space: nowrap; user-select: text; }
    #citadel-desktop-footer button {
      display: block;
      margin-top: .25rem;
      min-height: 1.5rem;
      padding: .125rem .375rem;
      border: 1px solid var(--nav-muted, #c3dcf2);
      border-radius: .2rem;
      font: inherit;
      color: var(--nav-ink, #fff);
      background: var(--nav-active, #15558e);
      cursor: pointer;
    }
    #citadel-desktop-footer button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    #citadel-desktop-footer button:disabled { cursor: wait; }
    #citadel-desktop-update-status { display: block; margin-top: .25rem; font-size: inherit; }
    #citadel-desktop-footer [hidden] { display: none; }
  `);
  const title = `Citadel UI ${build.version}\nApplication source: ${build.applicationRevision}\nRelease: ${build.releaseRevision || 'development'}`;
  await window.webContents.executeJavaScript(`(() => {
    let footer = document.getElementById('citadel-desktop-footer');
    if (!footer) {
      footer = document.createElement('div');
      footer.id = 'citadel-desktop-footer';
      document.body.append(footer);
    }
    footer.unsubscribeUpdates?.();
    footer.replaceChildren();
    const badge = document.createElement('small');
    badge.id = 'citadel-desktop-version';
    badge.setAttribute('aria-label', 'Citadel UI desktop version and application source');
    badge.textContent = ${JSON.stringify(desktopVersionLabel(build))};
    badge.title = ${JSON.stringify(title)};
    footer.append(badge);
    if (!${JSON.stringify(withUpdates)}) return;
    const api = window.citadelDesktopUpdates;
    const button = document.createElement('button');
    button.id = 'citadel-desktop-update';
    button.type = 'button';
    button.textContent = 'Check for updates';
    const status = document.createElement('small');
    status.id = 'citadel-desktop-update-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    const release = document.createElement('button');
    release.id = 'citadel-desktop-update-release';
    release.type = 'button';
    release.textContent = 'View release';
    release.hidden = true;
    footer.append(button, status, release);
    let state = { phase: 'idle', canInstall: false };
    const showError = () => {
      button.disabled = false;
      button.textContent = 'Check for updates';
      button.removeAttribute('aria-busy');
      footer.dataset.updatePhase = 'error';
      status.hidden = false;
      status.textContent = 'The update action failed. Check for updates to retry.';
      state = { phase: 'error', canInstall: false };
    };
    const render = (next) => {
      state = next;
      footer.dataset.updatePhase = state.phase;
      const busy = ['checking', 'confirming', 'downloading', 'restarting'].includes(state.phase);
      button.disabled = busy;
      button.setAttribute('aria-busy', String(busy));
      button.title = state.reason;
      button.textContent = state.phase === 'ready' ? 'Restart to update'
        : state.phase === 'downloading' ? 'Preparing update...'
        : state.phase === 'checking' ? 'Checking...'
        : state.phase === 'available' && state.canInstall ? 'Update to v' + state.availableVersion
        : 'Check for updates';
      status.textContent = state.message;
      status.title = state.canInstall ? state.message : state.reason;
      status.hidden = !state.message;
      release.hidden = !state.availableVersion;
      release.disabled = busy;
    };
    button.addEventListener('click', () => {
      const action = state.phase === 'ready' ? 'restart'
        : state.phase === 'available' && state.canInstall ? 'download' : 'check';
      api[action]().then(render).catch(showError);
    });
    release.addEventListener('click', () => api.viewRelease().catch(showError));
    footer.unsubscribeUpdates = api.subscribe(render);
    api.state().then(render).catch(showError);
  })()`);
}
