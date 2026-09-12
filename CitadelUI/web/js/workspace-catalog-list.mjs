import { h } from './dom.mjs';

/** List markup only; the catalog retains models, controls and action authority. */
export function renderWorkspaceCatalogList({
  rows, hasWorkspaces, addWorkspaceButton,
  renderSortButton, renderSourceBadge, renderChip, renderStatus,
  formatTime, renderRowActions, onClearFilters,
}) {
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
          h('th', { scope: 'col' }, renderSortButton('label', 'Workspace')),
          h('th', { scope: 'col' }, renderSortButton('source', 'Source')),
          h('th', { scope: 'col' }, 'Repository or folder'),
          h('th', { scope: 'col' }, 'Branch'),
          h('th', { scope: 'col' }, 'Connection'),
          h('th', { scope: 'col' }, 'Capabilities'),
          h('th', { scope: 'col' }, renderSortButton('status', 'Status')),
          h('th', { scope: 'col' }, renderSortButton('opened', 'Last opened')),
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
              h('small', { class: 'hint' }, [row.projectLabel, row.formatLabel].filter(Boolean).join(' \u00b7 '))
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
              row.branch ? h('code', {}, row.branch) : h('span', { class: 'hint' }, '\u2014')
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
              renderStatus(row.status)
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
