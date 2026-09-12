/**
 * The door.
 *
 * This container has exactly one owner. On first run nobody holds it, so the
 * first person here is asked to create it; afterwards everyone is asked to sign
 * in as it. There is no "create another account" and no "forgot password",
 * because neither exists on the server either — a forgotten password is
 * recovered by redeploying with fresh state, which is the honest operation for a
 * container whose identity is one file.
 *
 * The session token is the API credential for everything else the page does. It
 * is no longer published in the markup, so the only way to hold one is to come
 * through here. That is the whole of the change: every route still authenticates
 * exactly as it did, but the token now has to be earned.
 *
 * The token is kept in `localStorage` so the owner signs in once and stays in
 * across tabs and browser restarts. It is deliberately not an httpOnly cookie —
 * a hardening pass should make it one. What makes this acceptable in the
 * meantime is the Content-Security-Policy: `script-src 'self'` admits no
 * third-party script, so there is no realistic reader for the value.
 */
const TOKEN_KEY = 'citadel.session-token';

export function storedToken() {
  try {
    return window.localStorage.getItem(TOKEN_KEY) || null;
  } catch {
    // Storage can be unavailable outright in a hardened profile. The page still
    // works; the owner signs in again on the next load.
    return null;
  }
}

function keepToken(token) {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* Not fatal: the token stays in memory for this page. */
  }
}

export function forgetToken() {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* Nothing to do. */
  }
}

function authState() {
  return document.querySelector('meta[name="citadel-auth"]')?.content || 'claimed';
}

async function post(path, payload) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof body.error === 'object' ? body.error : {};
    throw Object.assign(new Error(detail.message || `Sign-in failed (${res.status}).`), {
      code: detail.code || null,
      status: res.status,
    });
  }
  return body;
}

/**
 * Is the token we are holding still worth anything?
 *
 * The session token is process-wide, so a container restart invalidates every
 * stored copy. Without this check the page would boot with a dead token and fail
 * on its first real request, which reads as "the app is broken" rather than
 * "please sign in again". Asking one cheap authenticated question first turns a
 * restart into a sign-in prompt.
 */
async function tokenWorks(token) {
  try {
    const res = await fetch('/api/health', { headers: { 'X-Citadel-Session': token } });
    return res.ok;
  } catch {
    return false;
  }
}

function field(form, { id, label, type, autocomplete, hint }) {
  const wrap = document.createElement('label');
  wrap.className = 'gate-field';
  const caption = document.createElement('span');
  caption.className = 'gate-label';
  caption.textContent = label;
  const input = document.createElement('input');
  input.id = id;
  input.name = id;
  input.type = type;
  input.required = true;
  input.autocomplete = autocomplete;
  input.className = 'ctl gate-input';
  wrap.append(caption, input);
  if (hint) {
    const note = document.createElement('span');
    note.className = 'gate-hint';
    note.textContent = hint;
    wrap.append(note);
  }
  form.append(wrap);
  return input;
}

/**
 * Hold the page until this browser holds a session token.
 *
 * Resolves with the token. Never resolves without one — there is no path from
 * here into the application that skips the credential.
 */
export function requireOwnerSession() {
  return new Promise((resolve) => {
    const state = authState();
    const appShell = document.querySelector('.shell');
    const shellWasInert = appShell?.inert;
    if (appShell) appShell.inert = true;

    const overlay = document.createElement('div');
    overlay.className = 'gate';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'gate-title');

    const panel = document.createElement('section');
    panel.className = 'gate-panel';

    const brand = document.createElement('div');
    brand.className = 'gate-brand';
    brand.setAttribute('aria-label', 'Citadel Control Panel');
    const brandMark = document.createElement('span');
    brandMark.className = 'tb-mark';
    brandMark.setAttribute('aria-hidden', 'true');
    const brandName = document.createElement('span');
    brandName.className = 'gate-brand-name';
    brandName.setAttribute('aria-hidden', 'true');
    brandName.textContent = 'Citadel Control Panel';
    brand.append(brandMark, brandName);

    const title = document.createElement('h1');
    title.className = 'gate-title';
    title.id = 'gate-title';
    title.tabIndex = -1;

    const blurb = document.createElement('p');
    blurb.className = 'gate-blurb';

    const form = document.createElement('form');
    form.className = 'gate-form';
    form.noValidate = true;

    const error = document.createElement('p');
    error.id = 'gate-error';
    error.className = 'gate-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;

    panel.append(brand, title, blurb, form);
    overlay.append(panel);

    // An unreadable owner record must never be offered as a fresh claim.
    if (state === 'unavailable') {
      title.textContent = 'This container cannot be opened';
      blurb.textContent =
        'The owner record on the data volume is missing or unreadable. This instance cannot verify its owner. Ask the instance administrator to inspect the existing data volume and backups before making changes; do not replace retained state just to retry sign-in.';
      document.body.append(overlay);
      title.focus();
      return;
    }

    const claiming = state === 'unclaimed';
    title.textContent = claiming ? 'Create the owner account' : 'Sign in';
    blurb.textContent = claiming
      ? 'Create the single owner account for this Citadel instance. These credentials protect workspace settings and retained application data.'
      : 'Use the owner account created for this Citadel instance. This is an instance sign-in, not Microsoft or GitHub sign-in.';
    const scope = document.createElement('p');
    scope.className = 'gate-hint';
    scope.id = 'gate-scope';
    scope.textContent = 'One owner only. There is no second account or password reset. Keep the owner credentials safe; creating fresh instance state is not a way to preserve or recover existing owner data.';
    panel.replaceChildren(brand, title, blurb, scope, form);
    overlay.setAttribute('aria-describedby', 'gate-scope');

    const username = field(form, {
      id: 'gate-username',
      label: 'Username',
      type: 'text',
      autocomplete: 'username',
    });
    username.spellcheck = false;
    const password = field(form, {
      id: 'gate-password',
      label: 'Password',
      type: 'password',
      autocomplete: claiming ? 'new-password' : 'current-password',
      hint: claiming ? 'At least 8 characters.' : undefined,
    });

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn btn-primary gate-submit';
    submit.textContent = claiming ? 'Create owner and continue' : 'Sign in';
    form.append(error, submit);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      error.hidden = true;
      for (const control of [username, password, submit]) {
        control.removeAttribute('aria-invalid');
        control.removeAttribute('aria-describedby');
      }
      submit.disabled = true;
      submit.setAttribute('aria-busy', 'true');
      submit.textContent = claiming ? 'Creating\u2026' : 'Signing in\u2026';
      try {
        const body = await post(
          claiming ? '/api/owner/claim' : '/api/owner/session',
          { username: username.value, password: password.value }
        );
        keepToken(body.sessionToken);
        password.value = '';
        overlay.remove();
        if (appShell) appShell.inert = shellWasInert;
        resolve(body.sessionToken);
      } catch (failure) {
        // A claim that lost the race is not an error the user caused: someone
        // else took the container first, and the honest next step is to sign in.
        if (failure.code === 'OWNER_ALREADY_CLAIMED') {
          window.location.reload();
          return;
        }
        error.textContent = failure.message;
        error.hidden = false;
        submit.disabled = false;
        submit.removeAttribute('aria-busy');
        submit.textContent = claiming ? 'Create owner and continue' : 'Sign in';
        const invalid = failure.code === 'INVALID_USERNAME' ? username
          : ['INVALID_PASSWORD', 'INVALID_CREDENTIALS'].includes(failure.code) ? password : null;
        if (invalid) invalid.setAttribute('aria-invalid', 'true');
        const target = invalid || submit;
        target.setAttribute('aria-describedby', error.id);
        if (invalid === password) password.value = '';
        target.focus();
      }
    });

    document.body.append(overlay);
    username.focus();
  });
}

/**
 * The application's entry condition: a working session token, or a locked door.
 */
export async function ensureOwnerSession() {
  const existing = storedToken();
  if (existing && authState() !== 'unclaimed' && (await tokenWorks(existing))) {
    return existing;
  }
  // Either nothing stored, or what was stored did not survive a restart.
  if (existing) forgetToken();
  return requireOwnerSession();
}
