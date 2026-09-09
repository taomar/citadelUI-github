import { h } from './dom.mjs';
import { showDialog, dismissDialog, confirmDialog } from './dialog.mjs';
import { DEFAULT_REPOSITORY_SOURCE, parseRepositorySource } from '../../shared/repository-source.mjs';
import { validateLocalPath, localPathMatchesHandle, localChildDisplayPath } from '../../shared/local-path.mjs';
import { validateLocalFolderName } from '../../shared/repository-snapshot.mjs';
import { createLocalSourceClient } from './local-source-client.mjs';
import { LocalSourceCopy } from './local-source-copy.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const field = (id, label, control, hint = null) => h('label', { class: 'catalog-field', for: id },
  h('span', { class: 'catalog-field-label' }, label), control, hint ? h('small', { class: 'hint' }, hint) : null);
const row = (label, value) => h('div', { class: 'catalog-summary-row' }, h('dt', {}, label), h('dd', {}, value));

function progressRegion() {
  const heading = h('p', { class: 'stage stage-active', role: 'status', 'aria-live': 'polite' },
    h('span', { class: 'stage-mark', 'aria-hidden': 'true' }), h('strong'));
  const count = h('p', { role: 'status', 'aria-live': 'polite' });
  const meter = h('progress', { class: 'repository-progress-meter', 'aria-label': 'Local import file progress' });
  const path = h('code', { class: 'repository-progress-item' });
  const root = h('section', { class: 'repository-progress', hidden: true, 'aria-label': 'Local source import progress' },
    heading, count, meter, path);
  return {
    root,
    update(message, progress = null, running = true) {
      root.hidden = false;
      heading.className = `stage ${running ? 'stage-active' : 'stage-pending'}`;
      heading.children[1].textContent = message;
      const measured = Number.isSafeInteger(progress?.total) && progress.total > 0;
      meter.hidden = !measured;
      count.hidden = !measured;
      path.hidden = !progress?.currentPath;
      path.textContent = progress?.currentPath || '';
      if (measured) {
        meter.max = progress.total;
        meter.value = progress.completed;
        count.textContent = `${progress.completed} of ${progress.total} files`;
      }
    },
  };
}

/** One local import journey, shared by Settings > New project and the catalog. */
export function openLocalSourceImport(options) {
  const {
    projects = [], scan, attach, onDraft = () => {}, onContext = () => {},
    pickFolder = () => globalThis.showDirectoryPicker({ mode: 'readwrite' }),
    client = createLocalSourceClient(), pollDelay = 750,
  } = options;
  const values = {
    projectId: options.projectId || '',
    projectLabel: options.projectLabel || '',
    environmentLabel: options.environmentLabel || 'Development',
    localPath: options.localPath || '',
    folderName: options.folderName || '',
  };
  let folderNameEdited = Boolean(options.folderName);
  let sourceUrl = DEFAULT_REPOSITORY_SOURCE;
  let key = null;
  let operation = null;
  let prepared = null;
  let copy = null;
  let busy = false;
  let closing = false;
  let closed = false;
  let presented = false;
  let allowDismiss = false;
  let pauseRequested = false;
  let downloadController = null;
  let refresh = () => {};
  let notice = null;
  let progress = null;
  let resolve;
  const promise = new Promise((done) => { resolve = done; });

  const say = (message = '') => {
    notice.textContent = message;
    notice.hidden = !message;
  };
  function finish(result) {
    if (closed) return;
    closed = true;
    resolve(result || null);
  }
  async function releaseSource() {
    if (!key) return;
    try { await client.release(key); }
    catch (error) { if (error.code !== 'LOCAL_IMPORT_EXPIRED') throw error; }
    key = null;
  }
  async function close() {
    if (busy || closing || closed) return;
    closing = true;
    try {
      if (copy?.root && !(await confirmDialog({
        title: 'Keep the partial local folder?',
        message: `The folder "${copy.parent.name}/${copy.childName}" is retained. Workspace registration has not been confirmed. Closing loses this import's in-memory retry state; nothing will be deleted.`,
        confirmLabel: 'Keep folder and close', cancelLabel: 'Return to import',
      }))) return;
      await releaseSource();
      allowDismiss = true;
      dismissDialog(false);
      finish(null);
    } catch (error) { say(`Could not close the source preparation: ${error.message} Retry closing; the source cache expires automatically.`); }
    finally { closing = false; }
  }
  function present(title, body, buttons, focus) {
    showDialog(title, h('div', { class: 'catalog-dialog local-source-import' }, body),
      buttons, {
        stack: Boolean(options.stack && !presented),
        replaceTop: Boolean(options.stack && presented),
        initialFocus: focus,
        preventDismiss: () => {
          if (allowDismiss) return false;
          if (busy) {
            say(copy?.state === 'registering'
              ? 'Saving the verified workspace. Wait for registration to finish or report its recovery result.'
              : 'An import step is running. Use Pause to stop at a safe checkpoint.');
            return true;
          }
          if (key || copy?.root) { void close(); return true; }
          return false;
        },
        onDismiss: (result) => { if (result !== true) finish(null); },
      });
    presented = true;
  }
  function controls() {
    notice = h('p', { class: 'catalog-error', role: 'alert', hidden: true });
    progress = progressRegion();
  }
  async function run(action) {
    if (busy || closed) return;
    busy = true;
    say();
    refresh();
    try { await action(); }
    catch (error) {
      say(error?.name === 'AbortError' ? 'Source transfer paused. No folder was changed; retry this same preparation.' : error.message);
      progress.update(copy?.root ? 'Import stopped; the partial folder is retained.' : 'Preparation stopped; no local files were written.', null, false);
    } finally {
      busy = false;
      if (!closed) refresh();
    }
  }
  function cancelButton() {
    return h('button', { class: 'btn', type: 'button', onclick: close }, copy?.root ? 'Keep folder and close' : 'Cancel');
  }
  function sourceSummary() {
    const source = prepared?.snapshot.source || operation?.source;
    if (!source) return null;
    return h('dl', { class: 'catalog-summary' },
      row('Read-only source', h('code', {}, source.fullName)),
      row('Source revision', h('code', {}, source.ref)),
      row('Resolved commit', h('code', {}, source.commit)),
      row('Snapshot', `${source.fileCount} files / ${(source.totalBytes / 1024 / 1024).toFixed(1)} MiB`));
  }
  function announceContext() {
    const label = values.projectId ? projects.find((project) => project.id === values.projectId)?.label : values.projectLabel;
    onContext({ sourceKind: 'local', projectLabel: label || 'New local project',
      environmentLabel: values.environmentLabel, repository: null, branch: null, account: null });
  }
  function sourceStep() {
    controls();
    announceContext();
    const input = h('input', { id: 'local-import-source', class: 'ctl', type: 'url', value: sourceUrl, spellcheck: false });
    const selected = h('p', { class: 'hint' });
    const updateRef = () => {
      sourceUrl = input.value;
      try {
        const parsed = parseRepositorySource(sourceUrl);
        selected.textContent = `Read-only source: ${parsed.fullName} / ${parsed.ref || 'repository default branch (resolved during preparation)'}`;
      } catch (error) { selected.textContent = error.message; }
    };
    input.addEventListener('input', updateRef);
    updateRef();
    const summary = h('div', {}, sourceSummary());
    const next = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => run(async () => {
      if (prepared) { destinationStep(); return; }
      pauseRequested = false;
      downloadController = new AbortController();
      if (!key) {
        sourceUrl = parseRepositorySource(input.value).url;
        key = crypto.randomUUID();
        operation = await client.prepare({ sourceUrl, operationKey: key });
      } else {
        try { operation = await client.status(key); }
        catch (error) {
          if (error.code === 'LOCAL_IMPORT_EXPIRED') {
            key = null;
            operation = null;
            throw new Error('The prepared source expired or the server restarted. Prepare again to resolve and review a new commit.');
          }
          throw error;
        }
        if (!operation.running && operation.state !== 'ready') operation = await client.resume(key);
      }
      while (operation.running || operation.state === 'preparing') {
        progress.update(operation.stage, operation.progress);
        summary.replaceChildren(...[sourceSummary()].filter(Boolean));
        if (pauseRequested) { operation = await client.cancel(key); break; }
        await wait(pollDelay);
        operation = await client.status(key);
      }
      summary.replaceChildren(...[sourceSummary()].filter(Boolean));
      if (pauseRequested || operation.state !== 'ready') {
        const retry = operation.retryAt ? ` Retry after ${new Date(operation.retryAt).toLocaleTimeString()}.` : '';
        throw new Error((operation.error?.message || 'Source preparation paused. Retry this same attempt.') + retry);
      }
      progress.update('Transferring the verified snapshot to this browser.');
      prepared = await client.download(key, {
        source: operation.source, signal: downloadController.signal,
        onProgress: (count) => progress.update('Transferring and verifying every source file in this browser.', count),
      });
      copy = new LocalSourceCopy(prepared);
      destinationStep();
    }) }, 'Prepare source and continue');
    const pause = h('button', { class: 'btn', type: 'button', onclick: () => {
      pauseRequested = true;
      downloadController?.abort();
      say('Pausing after the current source request. No local folder has been changed.');
      refresh();
    } }, 'Pause');
    const change = h('button', { class: 'btn', type: 'button', onclick: () => run(async () => {
      await releaseSource();
      operation = prepared = copy = null;
      sourceStep();
    }) }, 'Change source');
    const cancel = cancelButton();
    refresh = () => {
      input.disabled = busy || Boolean(key) || Boolean(prepared);
      next.disabled = busy;
      next.textContent = prepared ? 'Continue to destination' : key ? 'Retry source preparation' : 'Prepare source and continue';
      pause.hidden = !busy;
      pause.disabled = pauseRequested;
      change.hidden = !key && !prepared;
      change.disabled = busy;
      cancel.disabled = busy;
    };
    refresh();
    present('Create local from Citadel source', h('div', { class: 'catalog-form' },
      h('p', {}, 'Download a complete public source snapshot, then copy it to a new local project folder. No GitHub token, new GitHub repository or Git history is needed.'),
      field('local-import-source', 'GitHub source URL', input,
        'Default: citadel-v1. Use a repository root, /tree/ref, or the published /blob/ref/ root link. A slash in a ref is not treated as a subfolder.'),
      selected, summary, progress.root, notice),
    [cancel, change, pause, next], prepared ? next : input);
  }

  function destinationStep() {
    controls();
    const projectSelect = h('select', { id: 'local-import-project', class: 'ctl', value: values.projectId },
      h('option', { value: '' }, 'New project'),
      projects.map((project) => h('option', { value: project.id, selected: project.id === values.projectId }, project.label)));
    const project = h('input', { id: 'local-import-project-label', class: 'ctl', value: values.projectLabel, maxlength: 160 });
    const environment = h('input', { id: 'local-import-environment', class: 'ctl', value: values.environmentLabel, maxlength: 160 });
    const localPath = h('input', { id: 'local-import-path', class: 'ctl', value: values.localPath, maxlength: 1024, placeholder: 'C:\\source\\new-citadel' });
    const folderName = h('input', { id: 'local-import-folder-name', class: 'ctl', value: values.folderName, spellcheck: false });
    const projectRow = field('local-import-project-label', 'Project label', project);
    projectRow.hidden = Boolean(values.projectId);
    const chosen = h('p', { class: 'hint' });
    const capture = (persist = true) => {
      values.projectId = projectSelect.value || '';
      values.projectLabel = project.value.trim();
      values.environmentLabel = environment.value.trim();
      values.localPath = localPath.value;
      if (!folderNameEdited) {
        const suggestion = values.projectId ? projects.find((item) => item.id === values.projectId)?.label : values.projectLabel;
        try { folderName.value = validateLocalFolderName(suggestion); }
        catch (error) {
          if (error.code !== 'LOCAL_IMPORT_INVALID_FOLDER_NAME') throw error;
          folderName.value = '';
        }
      }
      values.folderName = folderName.value;
      projectRow.hidden = Boolean(values.projectId);
      announceContext();
      updateFolder();
      if (persist) {
        try { onDraft({ ...values }); }
        catch (error) {
          say(`Could not retain the project form: ${error.message} Your entries remain in this dialog. Restore browser storage, then retry.`);
          return false;
        }
      }
      return true;
    };
    for (const control of [project, environment, localPath]) control.addEventListener('input', () => capture());
    projectSelect.addEventListener('change', () => capture());
    folderName.addEventListener('input', () => { folderNameEdited = true; capture(); });
    const updateFolder = () => {
      chosen.textContent = copy.parent ? `Selected parent: ${copy.parent.name}. New project folder: ${values.folderName || '(enter a folder name)'}` : 'No folder selected. Nothing has been written.';
    };
    capture(false);
    const choose = h('button', { class: 'btn', type: 'button', onclick: () => run(async () => {
      let handle;
      try { handle = await pickFolder(); }
      catch (error) {
        if (error.name === 'AbortError') { say('Folder selection cancelled. No local files were changed.'); return; }
        throw error;
      }
      await copy.chooseFolder(handle);
      updateFolder();
    }) }, copy.parent ? 'Choose a different empty folder' : 'Choose empty parent folder');
    const next = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => run(async () => {
      if (!capture()) return;
      if ((!values.projectId && !values.projectLabel) || !values.environmentLabel ||
          values.projectLabel.length > 160 || values.environmentLabel.length > 160) throw new Error('Enter a project and workspace label, each at most 160 characters.');
      values.localPath = validateLocalPath(values.localPath);
      copy.nameFolder(values.folderName);
      if (!copy.parent) throw new Error('Choose an empty parent folder before continuing.');
      if (!localPathMatchesHandle(values.localPath, copy.parent.name) && !(await confirmDialog({
        title: 'Local path differs from folder',
        message: `The display-only parent path does not match "${copy.parent.name}". Only this browser-selected folder grants access; the path is not sent to the source importer.`,
        confirmLabel: 'Use this folder',
      }))) return;
      reviewStep();
    }) }, 'Review local import');
    const back = h('button', { class: 'btn', type: 'button', onclick: () => { if (capture()) sourceStep(); } }, 'Back');
    const cancel = cancelButton();
    refresh = () => {
      for (const control of [projectSelect, project, environment, localPath, folderName, choose, next, back, cancel]) control.disabled = busy;
    };
    refresh();
    present('Name the new local project', h('div', { class: 'catalog-form' },
      projects.length ? field('local-import-project', 'Project', projectSelect) : null,
      projectRow,
      field('local-import-environment', options.environmentFieldLabel || 'Workspace name', environment),
      field('local-import-path', 'Local path of the empty parent folder', localPath,
        'Display only. The browser-selected handle is authoritative; the server cannot access this path.'),
      field('local-import-folder-name', 'New project folder name', folderName,
        'One Windows-safe name, at most 160 characters. No .azure/.env names, automatic truncation, renaming or suffix. Existing children, even empty ones, are never adopted.'),
      h('div', { class: 'catalog-form-actions' }, choose), chosen,
      h('p', { class: 'hint' }, 'Citadel creates the named project subfolder inside this empty parent. That new subfolder, not its parent, becomes the workspace.'),
      notice), [cancel, back, next], values.projectId ? projectSelect : project);
  }

  function reviewStep() {
    const destination = localChildDisplayPath(values.localPath, copy.childName);
    controls();
    const agree = h('input', { id: 'local-import-confirm', type: 'checkbox' });
    const approval = h('label', { class: 'catalog-check', for: 'local-import-confirm' },
      agree, h('span', {}, 'Import this complete snapshot into the new folder shown above. I will keep that folder untouched until the import finishes.'));
    const next = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => {
      if (!agree.checked) return;
      return run(async () => {
        await releaseSource();
        const workspace = await copy.run({
          scan,
          attach: (verified) => attach({ ...verified, ...values, localPath: destination }),
          onProgress: (count) => {
            const titles = {
              source: 'Rechecking the complete browser snapshot.',
              copy: 'Copying source files to the new local folder.',
              verify: 'Verifying every copied file and folder.',
              compatibility: 'Checking the local folder for Citadel support.',
              register: 'Saving the verified local workspace.',
              complete: 'Local workspace created.',
            };
            progress.update(titles[count.phase], count);
            refresh();
          },
        });
        allowDismiss = true;
        dismissDialog(true);
        finish(workspace);
      });
    } }, 'Import and open workspace');
    const pause = h('button', { class: 'btn', type: 'button', onclick: () => {
      if (copy.cancel()) say('Pausing the local copy. Completed files and any partial folder will be retained.');
      refresh();
    } }, 'Pause');
    const back = h('button', { class: 'btn', type: 'button', onclick: destinationStep }, 'Back');
    const another = h('button', { class: 'btn', type: 'button', onclick: async () => {
      if (busy || !(await confirmDialog({
        title: 'Keep this folder and use another?',
        message: `Nothing in "${copy.parent.name}/${copy.childName}" will be removed. A different empty parent gets a new import folder and confirmation.`,
        confirmLabel: 'Choose another destination',
      }))) return;
      copy = new LocalSourceCopy(prepared);
      destinationStep();
    } }, 'Choose another destination');
    const cancel = cancelButton();
    agree.addEventListener('change', () => refresh());
    refresh = () => {
      agree.disabled = busy || Boolean(copy.root);
      next.disabled = busy || !agree.checked;
      next.textContent = copy.root ? 'Retry verified import' : 'Import and open workspace';
      pause.hidden = !busy;
      pause.disabled = copy.state === 'registering' || copy.cancelled;
      back.hidden = Boolean(copy.root);
      back.disabled = busy;
      another.hidden = !copy.root;
      another.disabled = busy;
      cancel.disabled = busy;
      cancel.textContent = copy.root ? 'Keep folder and close' : 'Cancel';
    };
    refresh();
    present('Review local import', h('div', { class: 'catalog-form' },
      sourceSummary(),
      h('dl', { class: 'catalog-summary' },
        row('Project', values.projectId ? projects.find((item) => item.id === values.projectId)?.label : values.projectLabel),
        row('Workspace', values.environmentLabel),
        row('Selected parent', h('code', {}, copy.parent.name)),
        row('New project folder', h('code', {}, copy.childName)),
        row('Destination (display only)', h('code', {}, destination))),
      h('p', { class: 'hint' }, 'Only this new local folder receives files. Existing local projects and GitHub repositories are not changed. The complete snapshot includes licenses, dotfiles and binary assets; no scripts or deployments run. No .git history or executable permissions are created.'),
      h('p', { class: 'hint' }, 'The browser rechecks permission, file identity and content before writes, then verifies the whole folder before registration. It cannot guarantee exclusive access against another program. Conflicts stop the import; partial files are kept, not silently removed.'),
      approval, progress.root, notice), [cancel, back, another, pause, next], agree);
  }

  sourceStep();
  return promise;
}
