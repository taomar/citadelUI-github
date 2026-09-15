import { h } from './dom.mjs';
import { showDialog, dismissDialog } from './dialog.mjs';

const tokenPage = 'https://github.com/settings/personal-access-tokens/new';

function section(title, ...content) {
  return h('section', { class: 'catalog-help-section' }, h('h3', {}, title), ...content);
}

function permission(label, access, reason) {
  return h('tr', {}, h('th', { scope: 'row' }, `${label}: ${access}`), h('td', {}, reason));
}

function helpContent(id, purpose) {
  const creating = purpose === 'create';
  const reading = purpose === 'source';
  return h('div', { id: `${id}-help`, class: 'catalog-token-help' },
    h('p', { class: 'catalog-help-intro' }, creating
      ? 'Use a temporary token to create and populate a new private repository.'
      : reading ? 'Use read-only access to import values from a source repository.'
        : 'Limit editing access to the repositories you will use.'),
    section('1. Choose the scope',
      h('dl', { class: 'catalog-help-scope' },
        h('dt', {}, 'Resource owner'),
        h('dd', {}, creating
          ? 'Choose the intended Organization or Personal destination. Your signed-in GitHub user stays the same.'
          : 'Choose the user or organization that owns the repositories.'),
        h('dt', {}, 'Repository access'),
        h('dd', {}, creating
          ? 'All repositories. The new repository does not exist yet, so it cannot be selected beforehand.'
          : reading ? 'Only select repositories, then select the source repository.'
            : 'Only select repositories; select only the repositories you will use.'),
        h('dt', {}, 'Expiration'),
        h('dd', {}, creating ? 'Use a temporary token with a 1-day expiration.' : 'Give the token a name and a short expiration.'))),
    section('2. Set permissions',
      h('table', { class: 'catalog-help-table' },
        h('caption', { class: 'sr-only' }, 'Required token permissions and purpose'),
        h('tbody', {},
          permission('Repository Metadata', 'Read-only', 'Included automatically.'),
          permission('Repository Contents', reading ? 'Read-only' : 'Read and write',
            reading ? 'Read source files. No write access is requested.' : 'Read branches and import files or save edits.'),
          creating ? permission('Repository Administration', 'Read and write', 'Create and configure the private repository.') : null,
          creating ? permission('Organization Members', 'Read-only', 'Verify membership for organization creation. Discovery through readable repositories does not require write access.') : null,
          creating ? permission('Repository Workflows', 'Read and write', 'Only if the source preview reports .github/workflows files.') : null)),
      creating
        ? h('p', {}, 'Administration alone cannot read branches or populate the repository. For workflow sources, Citadel disables Actions before copying and leaves Actions disabled for your review. No Pull requests permission is needed.')
        : h('p', {}, reading
          ? 'Leave other permissions unset. Source reading does not require write, Administration, repository creation, Actions, or Workflows permissions.'
          : 'Leave all other repository, account and organization permissions unset. Pull requests, Actions, Workflows and administration permissions are not required.')),
    section('3. Generate and connect',
      h('a', {
        class: 'btn', href: creating
          ? `${tokenPage}?name=Citadel%20repository%20creation&administration=write&contents=write&expires_in=1`
          : tokenPage,
        target: '_blank', rel: 'noopener noreferrer',
      }, creating ? 'Open prefilled GitHub token form (Administration + Contents)' : 'Create a fine-grained token on GitHub'),
      h('p', {}, creating
        ? 'The link only prefills a fine-grained token form; it does not create a token or grant permissions automatically.'
        : 'Review the selected resource owner and permissions on GitHub.'),
      h('p', {}, `Generate the token, copy it once, and paste it into ${reading ? 'Source GitHub token' : 'the GitHub token field'}. Never paste it into chat or logs.`),
      h('p', {}, 'Organization approval may be required. Pending tokens can only read public resources. A token cannot grant more access than your account already has.')),
    section(creating ? 'After setup' : 'Access boundaries',
      h('p', {}, creating
        ? 'After setup, narrow the token to Only select repositories and the new repository, remove Administration and any unneeded Workflows permission, or reconnect with a regular Contents-only token. New repositories are always private.'
        : reading
          ? 'This token is session-only and is erased from the form when submitted. Saved connection persistence is managed separately in Settings.'
          : 'Contents: Read-only can read files, but cannot create branches or save changes. Citadel attaches repositories for editing, not read-only browsing.'),
      h('p', {}, 'Read-only tokens can identify organizations through readable repositories. Discovering an owner does not prove permission to create a repository.')));
}

export function githubTokenHelpButton({ id, purpose = 'existing', disabled = false, show = showDialog, dismiss = dismissDialog }) {
  const button = h('button', {
    class: 'btn btn-sm', type: 'button', disabled,
    'aria-label': 'Token help for GitHub personal access tokens',
    'aria-haspopup': 'dialog',
    onclick: () => {
      const back = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => dismiss() }, 'Back to form');
      show('GitHub token help', helpContent(id, purpose), [back], {
        stack: true, returnFocus: button,
      });
    },
  }, 'Token help');
  return button;
}
