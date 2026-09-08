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
  input.className = 'gate-input';
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

    const overlay = document.createElement('div');
    overlay.className = 'gate';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'gate-title');

    const panel = document.createElement('section');
    panel.className = 'gate-panel';

    const brand = document.createElement('div');
    brand.className = 'gate-brand';
    brand.innerHTML = '<span class="gate-mark" aria-hidden="true"></span>';
    const brandName = document.createElement('span');
    brandName.className = 'gate-brand-name';
    brandName.textContent = 'Citadel Control Panel';
    brand.append(brandName);

    const title = document.createElement('h1');
    title.className = 'gate-title';
    title.id = 'gate-title';

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

    /**
     * A container whose owner record cannot be read is not a container anyone
     * can sign in to, and it must not be offered as a fresh one either. Saying
     * so plainly is the whole recovery instruction: redeploy.
     */
    if (state === 'unavailable') {
      title.textContent = 'This container cannot be opened';
      blurb.textContent =
        'The owner record on the data volume is missing or unreadable, so this container cannot verify who owns it. Redeploy with fresh state to claim it again.';
      document.body.append(overlay);
      return;
    }

    const claiming = state === 'unclaimed';
    title.textContent = claiming ? 'Create the owner account' : 'Sign in';
    blurb.textContent = claiming
      ? 'This container has no owner yet. The account you create now is the only account it will ever have — there is no second user and no password reset, so keep the password somewhere safe. Recovering it means redeploying with fresh state.'
      : 'Sign in with the owner account created when this container first started.';

    const username = field(form, {
      id: 'gate-username',
      label: 'Username',
      type: 'text',
      autocomplete: 'username',
    });
    const password = field(form, {
      id: 'gate-password',
      label: 'Password',
      type: 'password',
      autocomplete: claiming ? 'new-password' : 'current-password',
      hint: claiming ? 'At least 8 characters.' : undefined,
    });

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'gate-submit';
    submit.textContent = claiming ? 'Create owner and continue' : 'Sign in';
    form.append(error, submit);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.hidden = true;
      for (const control of [username, password, submit]) {
        control.removeAttribute('aria-invalid');
        control.removeAttribute('aria-describedby');
      }
      submit.disabled = true;
      submit.textContent = claiming ? 'Creating\u2026' : 'Signing in\u2026';
      try {
        const body = await post(
          claiming ? '/api/owner/claim' : '/api/owner/session',
          { username: username.value, password: password.value }
        );
        keepToken(body.sessionToken);
        overlay.remove();
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
