import { h } from './dom.mjs';
import { formatIcon } from './format-icon.mjs';

/** List markup only; the catalog retains models, controls and action authority. */
export function renderWorkspaceCatalogList({
  rows, hasWorkspaces, addWorkspaceButton,
  renderSortButton, renderSourceBadge, renderChip, renderStatus,
  formatTime, renderRowActions, onClearFilters,
}) {
  const sortHeader = (key, label) => {
    const button = renderSortButton(key, label);
    const direction = button.getAttribute('aria-sort');
    button.removeAttribute('aria-sort');
    return h('th', { scope: 'col', 'aria-sort': direction }, button);
  };
  if (!rows.length) {
    if (hasWorkspaces) {
      return h(
        'div',
        { class: 'catalog-empty' },
        h('p', {}, 'No workspace matches this search.'),
        h(
          'button',
          { class: 'btn', type: 'button', onclick: onClearFilters },
          'Clear filters'
        )
      );
    }
    return h(
      'div',
      { class: 'catalog-empty' },
      h('p', {}, 'No workspaces yet.'),
      h(
        'p',
        { class: 'hint' },
        'A workspace is one Citadel repository \u2014 a local folder, or a GitHub repository on a branch you choose. Once attached it appears here and opens in one click.'
      ),
      addWorkspaceButton
    );
  }

  return h(
    'div',
    {
      class: 'catalog-scroller',
      tabindex: '0',
      role: 'group',
      'aria-label': 'Saved workspaces table',
    },
    h(
      'table',
      { class: 'otable catalog-table' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          sortHeader('label', 'Workspace'),
          sortHeader('source', 'Source'),
          h('th', { scope: 'col' }, 'Repository or folder'),
          h('th', { scope: 'col' }, 'Branch'),
          h('th', { scope: 'col' }, 'Connection'),
          h('th', { scope: 'col' }, 'Capabilities'),
          sortHeader('status', 'Status'),
          sortHeader('opened', 'Last opened'),
          h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions'))
        )
      ),
      h(
        'tbody',
        {},
        rows.map((row) =>
          h(
            'tr',
            { class: 'catalog-row' },
            h(
              'td',
              { 'data-label': 'Workspace' },
              h('span', { class: 'otable-link' }, row.label),
              h('small', { class: 'hint' }, row.projectLabel,
                row.projectLabel && row.formatLabel ? ' \u00b7 ' : null,
                row.formatLabel ? h('span', { class: 'format-label' },
                  ['bicep', 'terraform'].includes(row.configurationFormat) ? formatIcon(row.configurationFormat) : null,
                  row.formatLabel) : null)
            ),
            h('td', { 'data-label': 'Source' }, renderSourceBadge(row.kind)),
            h(
              'td',
              { class: 'otable-path', 'data-label': 'Repository or folder' },
              h('code', {}, row.location || 'Not recorded')
            ),
            h(
              'td',
              { class: 'otable-path', 'data-label': 'Branch' },
              row.branch ? [
                h('small', { class: 'hint' }, 'Source'),
                h('code', {}, row.branch),
                row.workingBranch && row.workingBranch !== row.branch
                  ? h('small', { class: 'hint' }, 'Writes: ', h('code', {}, row.workingBranch)) : null,
              ] : h('span', { class: 'hint' }, '\u2014')
            ),
            h(
              'td',
              { class: 'catalog-connection-cell', 'data-label': 'Connection' },
              row.kind === 'github'
                ? h(
                    'span',
                    { class: row.connection ? '' : 'hint' },
                    row.connection ? row.connection.name : 'Not connected'
                  )
                : h('span', { class: 'hint' }, '\u2014')
            ),
            h(
              'td',
              { class: 'catalog-capabilities', 'data-label': 'Capabilities' },
              row.capabilities.length
                ? row.capabilities.map((capability) => renderChip(capability, 'chip-neutral'))
                : h('span', { class: 'hint' }, '\u2014')
            ),
            h(
              'td',
              { 'data-label': 'Status' },
              renderStatus(row.status, row)
            ),
            h('td', { 'data-label': 'Last opened' }, formatTime(row.lastOpenedAt)),
            // Keep the action buttons in one grid item for the stacked layout.
            h(
              'td',
              { 'data-label': 'Actions' },
              h('div', { class: 'catalog-actions' }, renderRowActions(row))
            )
          )
        )
      )
    )
  );
}
