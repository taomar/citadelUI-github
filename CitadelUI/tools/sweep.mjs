/*
   Breakpoint sweep helper.

   Emits one self-contained expression per area so a browser driver can run the
   same overlap assertion at every size without re-deriving the navigation.
*/

export const GOTO = {
  deploy: String.raw`
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const hit = [...document.querySelectorAll('.nav-item, button')]
    .find((n) => /^Azure Deployment/.test(n.textContent || ''));
  if (hit) hit.click();
  await wait(2200);
  return document.querySelectorAll('.prow').length;
})()
`,
  llm: String.raw`
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const hit = [...document.querySelectorAll('.nav-item, button')]
    .find((n) => /^LLM Onboarding/.test(n.textContent || ''));
  if (hit) hit.click();
  await wait(2400);
  return document.querySelectorAll('.lb-card, .lb-head').length;
})()
`,
  policy: String.raw`
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const hit = [...document.querySelectorAll('.nav-item, button')]
    .find((n) => /^Access Contracts/.test(n.textContent || ''));
  if (hit) hit.click();
  await wait(1800);
  const first = document.querySelector('.contract-item');
  if (first) first.click();
  await wait(2400);
  const tabs = [...document.querySelectorAll('.tab')];
  const tab = tabs.find((t) => /Policy/i.test(t.textContent));
  if (tab) tab.click();
  await wait(1800);
  return document.querySelectorAll('.pnav-link').length;
})()
`,
};

export const SIZES = [
  [1280, 800],
  [1440, 900],
  [1850, 1000],
  [2560, 1400],
];
