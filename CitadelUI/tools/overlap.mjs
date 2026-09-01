import { pathToFileURL } from 'node:url';

/*
   Sibling-overlap detector.

   Two elements that share a parent and sit in normal flow must never paint on
   top of one another. Overlap is how "a mess" looks from the outside, so this
   is an assertion rather than a review note.

   Run it inside the page: paste `OVERLAP_SOURCE` into an evaluate() call, or
   import it and call `findOverlaps(document)`.
*/

export const OVERLAP_SOURCE = String.raw`
(() => {
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'HEAD', 'META', 'LINK', 'TITLE', 'BR', 'HR', 'OPTION']);

  // Overlays are supposed to sit above the page; that is their whole job.
  const OVERLAY = '.explain, .mp-panel, .modal, .modal-card, .modal-back, .status, .scrim, dialog';

  const inFlow = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (cs.position === 'absolute' || cs.position === 'fixed' || cs.position === 'sticky') return false;
    if (parseFloat(cs.opacity) === 0) return false;
    if (cs.float !== 'none') return false;
    if (el.closest(OVERLAY)) return false;
    if (el.matches(OVERLAY)) return false;
    return true;
  };

  const area = (r) => r.width * r.height;

  const overlap = (a, b) => {
    const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return x > 1 && y > 1 ? x * y : 0;
  };

  const findings = [];
  const parents = [document.body, ...document.body.querySelectorAll('*')];

  for (const parent of parents) {
    if (SKIP_TAGS.has(parent.tagName)) continue;
    const kids = [...parent.children].filter((el) => {
      if (SKIP_TAGS.has(el.tagName)) return false;
      if (!inFlow(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    });
    if (kids.length < 2) continue;

    // Multi-column and wrapping flex containers legitimately place siblings
    // beside one another; they still must not intersect, so they stay in.
    const rects = kids.map((el) => el.getBoundingClientRect());
    for (let i = 0; i < kids.length; i += 1) {
      for (let j = i + 1; j < kids.length; j += 1) {
        const hit = overlap(rects[i], rects[j]);
        if (!hit) continue;
        const share = hit / Math.min(area(rects[i]), area(rects[j]));
        findings.push({
          parent: describe(parent),
          a: describe(kids[i]),
          b: describe(kids[j]),
          px: Math.round(hit),
          share: Number(share.toFixed(3)),
        });
      }
    }
  }

  function describe(el) {
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
      : '';
    const r = el.getBoundingClientRect();
    return el.tagName.toLowerCase() + cls
      + ' [' + Math.round(r.left) + ',' + Math.round(r.top)
      + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ']';
  }

  return {
    width: window.innerWidth,
    height: window.innerHeight,
    scanned: parents.length,
    overlaps: findings.length,
    worst: findings.sort((p, q) => q.share - p.share).slice(0, 12),
  };
})()
`;

export const GRID_SOURCE = String.raw`
(() => {
  const mismatches = [];
  const targets = document.querySelectorAll(
    '.prow:not(.prow-full), .diff-line, .rec-row, .lm-row, .lp-row'
  );
  for (const element of targets) {
    if (!element.getClientRects().length) continue;
    const style = getComputedStyle(element);
    if (style.display !== 'grid') continue;
    const value = style.gridTemplateColumns;
    const tracks = value.startsWith('subgrid')
      ? Math.max(0, (value.match(/\[\]/g) || []).length - 1)
      : value.trim().split(/\s+/).filter(Boolean).length;
    if (tracks !== element.children.length) {
      mismatches.push({
        element: element.className,
        children: element.children.length,
        tracks,
        value,
      });
    }
  }

  const matrices = [];
  for (const table of document.querySelectorAll('.pol-matrix')) {
    if (!table.getClientRects().length) continue;
    const expected = table.rows[0] ? table.rows[0].cells.length : 0;
    for (const row of table.rows) {
      if (row.cells.length !== expected) {
        matrices.push({ expected, actual: row.cells.length });
      }
    }
  }
  return { mismatches, matrices };
})()
`;

export const SCROLL_SOURCE = String.raw`
(() => {
  const selectors = '.rec, .lb-models, .lb-panel-routing, .pol-matrix';
  const overflows = [];
  for (const element of document.querySelectorAll(selectors)) {
    if (!element.getClientRects().length) continue;
    const parentWidth = element.parentElement ? element.parentElement.clientWidth : element.clientWidth;
    const escapesParent =
      element.matches('.pol-matrix') &&
      element.getBoundingClientRect().width > parentWidth + 1;
    if (
      element.scrollWidth > element.clientWidth + 1 ||
      escapesParent
    ) {
      overflows.push({
        element: element.className,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        parentWidth,
      });
    }
  }
  return overflows;
})()
`;

export const DOCUMENT_SOURCE = String.raw`
(() => {
  const root = document.documentElement;
  const unanchored = [...document.querySelectorAll('*')].filter((element) => {
    if (getComputedStyle(element).position !== 'absolute') return false;
    let parent = element.parentElement;
    while (parent) {
      const style = getComputedStyle(parent);
      if (
        style.position !== 'static' ||
        style.transform !== 'none' ||
        style.filter !== 'none'
      ) {
        return false;
      }
      parent = parent.parentElement;
    }
    return true;
  });
  return {
    clientHeight: root.clientHeight,
    scrollHeight: root.scrollHeight,
    scrollable: root.scrollHeight > root.clientHeight + 2,
    unanchored: unanchored.map((element) => ({
      tag: element.tagName,
      className: element.className,
      parent: element.parentElement && element.parentElement.className,
    })),
  };
})()
`;

export const PICKER_SOURCE = String.raw`
(async (selector) => {
  const inputs = [...document.querySelectorAll(selector)].filter((input) => input.getClientRects().length);
  const results = [];
  const clipped = (value) => /^(auto|scroll|hidden|clip)$/.test(value);
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  for (const [index, input] of inputs.entries()) {
    const scrollers = [];
    for (let ancestor = input.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (!clipped(style.overflowY) || ancestor.scrollHeight <= ancestor.clientHeight) continue;
      scrollers.push([ancestor, ancestor.style.scrollBehavior]);
      ancestor.style.scrollBehavior = 'auto';
    }
    input.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    for (const [ancestor] of scrollers) {
      const inputRect = input.getBoundingClientRect();
      const ancestorRect = ancestor.getBoundingClientRect();
      ancestor.scrollTop +=
        inputRect.top - ancestorRect.top - (ancestorRect.height - inputRect.height) / 2;
    }
    await frame();
    for (const [ancestor, scrollBehavior] of scrollers) ancestor.style.scrollBehavior = scrollBehavior;
    input.focus();
    input.click();
    await frame();

    const panels = [...document.body.children].filter((node) => node.matches('.mp-panel.mp-open'));
    const panel = panels[panels.length - 1];
    if (!panel) {
      results.push({ index, label: input.getAttribute('aria-label'), error: 'No open panel' });
      continue;
    }

    const rect = panel.getBoundingClientRect();
    const insideViewport =
      rect.left >= -1 &&
      rect.top >= -1 &&
      rect.right <= document.documentElement.clientWidth + 1 &&
      rect.bottom <= document.documentElement.clientHeight + 1;
    const clips = [];
    for (let ancestor = panel.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const bounds = ancestor === document.body || ancestor === document.documentElement
        ? {
            left: 0,
            top: 0,
            right: document.documentElement.clientWidth,
            bottom: document.documentElement.clientHeight,
          }
        : ancestor.getBoundingClientRect();
      const clipsX = clipped(style.overflowX);
      const clipsY = clipped(style.overflowY);
      if (
        (clipsX && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1)) ||
        (clipsY && (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1))
      ) {
        clips.push({
          ancestor: ancestor.className || ancestor.tagName,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
        });
      }
    }

    results.push({
      index,
      label: input.getAttribute('aria-label') || input.placeholder,
      parent: panel.parentElement && panel.parentElement.tagName,
      position: getComputedStyle(panel).position,
      items: panel.querySelectorAll('.mp-item').length,
      insideViewport,
      clips,
      rect: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
      },
    });
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    input.blur();
    await frame();
  }

  const failures = results.filter(
    (result) =>
      result.error ||
      result.parent !== 'BODY' ||
      result.position !== 'fixed' ||
      !result.insideViewport ||
      result.clips.length ||
      result.items < 1
  );
  return { results, failures };
})
`;

async function runCli() {
  const { spawn } = await import('node:child_process');
  const { existsSync, rmSync } = await import('node:fs');
  const path = await import('node:path');

  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  if (!existsSync(chrome)) throw new Error(`Chrome not found at ${chrome}`);
  const qaUrl = process.env.CITADEL_QA_URL;
  if (!qaUrl || /^http:\/\/127\.0\.0\.1:4173(?:\/|$)/.test(qaUrl)) {
    throw new Error('Set CITADEL_QA_URL to an isolated non-production QA origin.');
  }
  const qaNamespace = process.env.CITADEL_QA_REGISTRY_NAMESPACE;
  if (!qaNamespace || qaNamespace === 'citadel-ui') {
    throw new Error('Set CITADEL_QA_REGISTRY_NAMESPACE to an isolated QA namespace.');
  }

  const port = 9333;
  const profile = path.resolve('tools/.overlap-chrome');
  rmSync(profile, { recursive: true, force: true });
  const child = spawn(chrome, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let socket;
  let sequence = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

  try {
    let page;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((res) => res.json());
        page = pages.find((item) => item.type === 'page');
        if (page) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!page) throw new Error('Chrome DevTools endpoint did not become ready');

    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const call = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message));
      else call.resolve(message.result);
    });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source:
        `globalThis.__CITADEL_TEST_RUNTIME__ = true;` +
        `globalThis.__CITADEL_REGISTRY_NAMESPACE__ = ${JSON.stringify(qaNamespace)};`,
    });
    await send('Page.navigate', { url: qaUrl });

    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    const waitFor = async (expression, timeout = 12000) => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        if (await evaluate(expression)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`Timed out waiting for ${expression}`);
    };
    await waitFor(`document.readyState === 'complete'`);

    const areas = {
      deploy: {
        open: `document.querySelectorAll('.area')[0].click()`,
        ready: `document.querySelectorAll('.prow').length > 90`,
        pickerSelector: `#param-aiFoundryModelsConfig .rec-entry .mp input`,
        pickerCount: 11,
      },
      llm: {
        open: `document.querySelectorAll('.area')[1].click()`,
        ready: `document.querySelectorAll('.lm-row').length > 1`,
        pickerSelector: `.lb[open] .lm-add .mp input`,
        pickerCount: 1,
      },
      policy: {
        open: `document.querySelectorAll('.area')[2].click()`,
        ready: `document.querySelectorAll('.contract-item').length > 0`,
        after: `
          document.querySelector('.contract-item').click();
          await new Promise(r => setTimeout(r, 500));
          [...document.querySelectorAll('.tab')].find(x => /Policy/.test(x.textContent)).click();
        `,
        afterReady: `document.querySelectorAll('.pnav-link').length === 12`,
        pickerSelector: `.policy-guided .mp input`,
        pickerCount: 2,
      },
    };
    const configs = [
      ...[[1280, 800], [1440, 900], [1850, 1000], [2560, 1400]]
        .map(([width, height]) => ({ name: `${width}x${height}`, width, height, zoom: 1, root: '16px' })),
      ...[0.8, 1.25, 1.5]
        .map((zoom) => ({ name: `zoom-${zoom * 100}`, width: 1440, height: 900, zoom, root: '16px' })),
      ...['12.8px', '16px', '24px']
        .map((root) => ({ name: `root-${root}`, width: 1440, height: 900, zoom: 1, root })),
    ];

    let failures = 0;
    for (const [area, route] of Object.entries(areas)) {
      await evaluate(`location.reload()`);
      await waitFor(`document.readyState === 'complete' && document.querySelectorAll('.area').length === 3`);
      await evaluate(route.open);
      await waitFor(route.ready);
      if (route.after) {
        await evaluate(`(async () => { ${route.after} })()`);
        await waitFor(route.afterReady);
      }
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await waitFor(
        `document.documentElement.clientWidth === 1280 && document.documentElement.clientHeight === 800`
      );
      await evaluate(`(() => {
        document.documentElement.style.zoom = '1';
        document.documentElement.style.fontSize = '16px';
      })()`);
      const pickerAudit = await evaluate(
        `${PICKER_SOURCE}(${JSON.stringify(route.pickerSelector)})`
      );
      const pickerFailed =
        pickerAudit.results.length !== route.pickerCount || pickerAudit.failures.length;
      if (pickerFailed) failures += 1;
      console.log(
        `${area.padEnd(7)} pickers     checked=${pickerAudit.results.length} `
        + `expected=${route.pickerCount} clipped=${pickerAudit.failures.length}`
      );
      if (pickerFailed) console.log(JSON.stringify(pickerAudit, null, 2));
      for (const config of configs) {
        // Browser zoom changes the CSS-pixel viewport; applying CSS `zoom` to
        // <html> instead would itself enlarge the root scroll box and create a
        // false document-scroll failure at 125/150%.
        await send('Emulation.setDeviceMetricsOverride', {
          width: Math.round(config.width / config.zoom),
          height: Math.round(config.height / config.zoom),
          deviceScaleFactor: config.zoom,
          mobile: false,
        });
        await evaluate(`(() => {
          document.documentElement.style.zoom = '1';
          document.documentElement.style.fontSize = ${JSON.stringify(config.root)};
        })()`);
        const overlap = await evaluate(OVERLAP_SOURCE);
        const grid = await evaluate(GRID_SOURCE);
        const scroll = await evaluate(SCROLL_SOURCE);
        const documentAudit = await evaluate(DOCUMENT_SOURCE);
        const failed =
          overlap.overlaps ||
          grid.mismatches.length ||
          grid.matrices.length ||
          scroll.length ||
          documentAudit.scrollable ||
          documentAudit.unanchored.length;
        if (failed) failures += 1;
        console.log(
          `${area.padEnd(7)} ${config.name.padEnd(11)} overlaps=${overlap.overlaps} `
          + `grids=${grid.mismatches.length} matrices=${grid.matrices.length} `
          + `scroll=${scroll.length} document=${documentAudit.scrollHeight}/${documentAudit.clientHeight} `
          + `icb=${documentAudit.unanchored.length}`
        );
        if (scroll.length) console.log(JSON.stringify(scroll));
        if (documentAudit.scrollable || documentAudit.unanchored.length) {
          console.log(JSON.stringify(documentAudit));
        }
      }
    }
    console.log(failures
      ? `FAIL: ${failures} viewport checks reported layout defects.`
      : `PASS: 30 viewport checks and 14 picker checks; zero clipping, overlaps, grid/matrix mismatches, table overflows, document scroll, and ICB-positioned elements.`);
    process.exitCode = failures ? 1 : 0;
  } finally {
    if (socket) socket.close();
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) await runCli();
