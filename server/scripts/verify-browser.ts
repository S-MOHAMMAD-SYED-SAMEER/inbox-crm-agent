import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `npm run verify:browser`
//
// Signs in to the real app in a real headless Chrome, the way the README tells a
// visitor to: it starts `npm run demo`'s server (scripts/demo.ts), opens
// http://localhost:<port>, types the printed password, and then runs one action
// that changes something (ingest the demo inbox).
//
// WHY THIS EXISTS. A browser sends an `Origin` header on a same-origin POST; no
// test that uses Node's `fetch` does. The server once refused its own dashboard's
// sign-in with a 403, and the unit tests, the 153-check walkthrough and the
// evaluations all passed. Only a real browser finds that class of fault.
//
// NO DEPENDENCY. It speaks the Chrome DevTools Protocol over Node's built-in
// WebSocket, so it needs Chrome (or Chromium) installed and nothing from npm.
// Set CHROME_PATH to use a specific binary. The dashboard must be built first
// (`npm run build --prefix ../web`).

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD = path.resolve(SERVER_ROOT, '../web/dist/index.html');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((candidate): candidate is string => Boolean(candidate));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class CheckFailed extends Error {}

function fail(message: string): never {
  console.error(`\nFAIL  ${message}`);
  throw new CheckFailed(message);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

function stop(child: ChildProcess | undefined): void {
  if (!child?.pid || child.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

/** A minimal Chrome DevTools Protocol client: send a command, get its result. */
function connect(url: string): Promise<{ send(method: string, params?: object): Promise<any>; close(): void }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let nextId = 1;
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (message.id === undefined) return;
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result);
    });
    socket.addEventListener('error', () => reject(new Error('Could not connect to Chrome DevTools.')));
    socket.addEventListener('open', () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const id = nextId++;
            pending.set(id, { resolve: res, reject: rej });
            socket.send(JSON.stringify({ id, method, params }));
          }),
        close: () => socket.close(),
      }),
    );
  });
}

const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!chromePath) {
  console.error('No Chrome or Chromium found. Install one, or set CHROME_PATH to its executable.');
  process.exit(2);
}
if (!existsSync(DASHBOARD)) {
  console.error('The dashboard is not built. Run: npm run build --prefix ../web');
  process.exit(2);
}

const port = await freePort();
const profile = mkdtempSync(path.join(tmpdir(), 'icrm-chrome-'));
let server: ChildProcess | undefined;
let chrome: ChildProcess | undefined;
let exitCode = 0;

try {
  // --- the app, exactly as `npm run demo` starts it ---------------------------
  let serverOutput = '';
  server = spawn(process.execPath, ['scripts/demo.ts'], {
    cwd: SERVER_ROOT,
    env: { ...process.env, PORT: String(port) },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (chunk) => (serverOutput += chunk));
  server.stderr?.on('data', (chunk) => (serverOutput += chunk));

  const started = Date.now();
  while (!/Listening on port/.test(serverOutput)) {
    if (Date.now() - started > 60_000) fail(`The app did not start within 60 s.\n${serverOutput.slice(-600)}`);
    await sleep(250);
  }
  const password = /made for this run, local only\): ([0-9a-f]+)/.exec(serverOutput)?.[1];
  if (!password) fail('The app did not print a sign-in password.');
  console.log(`PASS  the app started on port ${port} and printed a sign-in password`);

  // --- the browser ------------------------------------------------------------
  let chromeOutput = '';
  chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      'about:blank',
    ],
    { detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'] },
  );
  chrome.stderr?.on('data', (chunk) => (chromeOutput += chunk));
  const devtoolsStarted = Date.now();
  let devtoolsPort: string | undefined;
  while (!(devtoolsPort = /127\.0\.0\.1:(\d+)\/devtools\/browser/.exec(chromeOutput)?.[1])) {
    if (Date.now() - devtoolsStarted > 30_000) fail(`Chrome did not open DevTools.\n${chromeOutput.slice(-400)}`);
    await sleep(200);
  }

  const targets = (await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json()) as Array<{
    type: string;
    webSocketDebuggerUrl: string;
  }>;
  const page = targets.find((target) => target.type === 'page');
  if (!page) fail('Chrome has no page to drive.');
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const evaluate = async (expression: string): Promise<unknown> => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async (expression: string, what: string, timeoutMs = 15_000): Promise<void> => {
    const begun = Date.now();
    while (Date.now() - begun < timeoutMs) {
      if (await evaluate(expression)) return;
      await sleep(250);
    }
    const visible = String(await evaluate('document.body.innerText.replace(/\\s+/g, " ").slice(0, 300)'));
    fail(`${what} (waited ${timeoutMs / 1000} s). The page says: "${visible}"`);
  };

  const viewport = (width: number, height: number, mobile: boolean) =>
    cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  const go = async (hash: string, ready: string, what: string) => {
    await cdp.send('Page.navigate', { url: `http://localhost:${port}/${hash}` });
    await waitFor(ready, what);
  };
  /** The page may not scroll sideways: the document is no wider than the window. */
  const noSidewaysScroll = async (what: string, width: number) => {
    const wide = Number(await evaluate('document.documentElement.scrollWidth'));
    if (wide > width) fail(`${what}: the page scrolls sideways (${wide} px of content in a ${width} px window)`);
  };

  // The URL the README tells a visitor to open.
  await cdp.send('Page.navigate', { url: `http://localhost:${port}/` });
  await waitFor('!!document.querySelector("input[type=password]")', 'The sign-in form did not appear');
  console.log('PASS  the sign-in form is shown at http://localhost');

  // React-controlled input: set the value through the native setter, then fire `input`.
  await evaluate(`(() => {
    const input = document.querySelector('input[type=password]');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, ${JSON.stringify(password)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('button')].find((b) => /sign in/i.test(b.textContent)).click();
  })()`);
  await waitFor('document.body.innerText.includes("Signed in as")', 'Signing in did not work');
  console.log('PASS  signing in with the printed password works (a same-origin POST carrying an Origin header)');

  // One request that changes something, so the CSRF-protected path is exercised too.
  await cdp.send('Page.navigate', { url: `http://localhost:${port}/#/inbox` });
  await waitFor(
    '[...document.querySelectorAll("button")].some((b) => /ingest new email/i.test(b.textContent))',
    'The Inbox did not load',
  );
  await evaluate('[...document.querySelectorAll("button")].find((b) => /ingest new email/i.test(b.textContent)).click()');
  await waitFor('document.querySelectorAll("a[href^=\\"#/inbox/\\"]").length >= 10', 'Ingesting the demo inbox did not show the ten emails');
  console.log('PASS  ingesting the demo inbox works and shows the ten emails');

  // The rest of the pipeline, then a look at what is drawn. A "needs a person" state used to print its
  // whole reason inside a rounded pill, which wrapped into a small oval with overlapping lines; no
  // unit test can see that, so the check is made on the real layout: every state chip must be one
  // line high, and its reason must sit outside it.
  // The analyse button says how many emails it will read before it is clicked: each is a model request with a real model.
  const analyseLabel = String(
    await evaluate('[...document.querySelectorAll("button")].map((b) => b.textContent).find((text) => /analyse waiting/i.test(text)) ?? ""'),
  );
  if (!/analyse waiting emails \(10\)/i.test(analyseLabel)) fail(`The analyse button says "${analyseLabel}" instead of naming the ten emails it will read`);
  console.log(`PASS  the analyse button names what it will read: "${analyseLabel}"`);
  const subjectLinks = Number(await evaluate('document.querySelectorAll("tbody tr a[href^=\\"#/inbox/\\"]").length'));
  if (subjectLinks < 20) fail(`Only ${subjectLinks} links in the Inbox rows: the subject is not a link as well as the sender`);
  console.log('PASS  the subject is a link as well as the sender');

  for (const label of ['analyse waiting email', 'match to crm', 'decide']) {
    await evaluate(
      `[...document.querySelectorAll("button")].find((b) => b.textContent.toLowerCase().includes(${JSON.stringify(label)})).click()`,
    );
    await sleep(1500);
  }
  await waitFor(
    'document.querySelectorAll("[data-state-reason]").length >= 3',
    'The emails that need a person (a conflict, an ambiguous one and the injection) did not show a reason',
  );
  const tallest = Number(
    await evaluate('Math.max(...[...document.querySelectorAll("[data-state-chip]")].map((el) => el.getBoundingClientRect().height))'),
  );
  if (!(tallest > 0 && tallest <= 32)) fail(`A state chip is ${tallest} px tall: its text is wrapping inside the pill`);
  const reasonInsideChip = await evaluate('!!document.querySelector("[data-state-chip] [data-state-reason]")');
  if (reasonInsideChip) fail('A review reason is drawn inside the state chip again');
  console.log(`PASS  every state chip is one line high (${tallest} px) and the reason sits under it`);

  // The emails handed to a person are listed where a person looks for work, and each offers what the server allows: archive for
  // all of them, "continue" only for the ambiguous one, and never for the one that tried to give the assistant orders.
  await cdp.send('Page.navigate', { url: `http://localhost:${port}/#/approvals` });
  await waitFor('!!document.querySelector("[data-needs-person-tab]")', 'The Approvals page has no "Needs a person" tab');
  await evaluate('document.querySelector("[data-needs-person-tab]").click()');
  await waitFor('document.querySelectorAll("[data-needs-person-list] section").length >= 3', 'The Needs a person list did not show the three emails handed to a person');
  const continueButtons = Number(await evaluate('[...document.querySelectorAll("[data-needs-person-list] button")].filter((b) => /continue to crm matching/i.test(b.textContent)).length'));
  if (continueButtons !== 1) fail(`${continueButtons} emails offer "Continue to CRM matching"; only the ambiguous one should`);
  const archiveButtons = Number(await evaluate('[...document.querySelectorAll("[data-needs-person-list] button")].filter((b) => /^archive$/i.test(b.textContent.trim())).length'));
  if (archiveButtons < 3) fail(`Only ${archiveButtons} emails offer Archive`);
  console.log('PASS  Needs a person lists the three emails; Archive for each, Continue only for the ambiguous one');
  await evaluate('[...document.querySelectorAll("[data-needs-person-list] button")].find((b) => /continue to crm matching/i.test(b.textContent)).click()');
  await waitFor(
    'document.body.innerText.includes("Continued.") && document.body.innerText.includes("the plan is waiting for approval")',
    'Continuing the ambiguous email did not say what it did and end with its plan waiting for approval',
  );
  console.log('PASS  Continue on the ambiguous email says what it did, and ends with its plan waiting for approval');

  // The email that stopped on a match conflict: "Choose the record" lists the candidates and offers "None of these".
  await waitFor('!!document.querySelector("[data-needs-person-list] [data-choose-the-record]")', 'The email stopped on a match conflict offers no "Choose the record"');
  await evaluate('document.querySelector("[data-needs-person-list] [data-choose-the-record]").click()');
  await waitFor('!!document.querySelector("[data-choose-record]")', '"Choose the record" showed no candidates');
  const chooser = String(await evaluate('document.querySelector("[data-choose-record]").innerText'));
  if (!/none of these/i.test(chooser)) fail('"Choose the record" offers no "None of these \u2014 create new records"');
  if (!/choose this record/i.test(chooser)) fail('"Choose the record" offers no candidate to choose');
  for (let pick = 0; pick < 3 && !String(await evaluate('document.body.innerText')).includes('The plan is waiting for approval'); pick += 1) {
    await evaluate('[...document.querySelectorAll("[data-choose-record] button")].find((b) => /choose this record/i.test(b.textContent)).click()');
    await sleep(1200);
  }
  await waitFor('document.body.innerText.includes("Record chosen. The plan is waiting for approval.")', 'Choosing a candidate did not leave a plan waiting for approval');
  console.log('PASS  Choose the record: the candidates are listed with "None of these"; choosing one leaves a plan waiting for approval');

  // V-3 the Inbox table at 1280 and 1440, V-4 the phone, V-1 the owner's status cards: all in the real layout.
  await go('#/overview', '/sending replies/i.test(document.body.innerText) && /language model/i.test(document.body.innerText)', 'The Overview did not load');
  const ownerCards = String(await evaluate('document.body.innerText.replace(/\\s+/g, " ")'));
  if (!ownerCards.includes('Every screen and every action requires a signed-in operator')) fail('The owner Overview no longer says that sign-in is required');
  if (/Guest demo\. No sign-in/.test(ownerCards)) fail('The owner Overview shows the guest wording');
  console.log('PASS  the owner Overview keeps its own status cards');

  // The table is measured twice: in the page's own font, and in a wide fallback (what a machine without that font draws, such as the
  // Linux machine CI runs on). A layout that fits only in the narrower font would pass here and fail there.
  for (const [fontName, fontCss] of [
    ['the page font', ''],
    ['a wide fallback font', '* { font-family: Verdana, "DejaVu Sans", sans-serif !important; }'],
  ] as const) {
    await viewport(1280, 900, false);
    await go('#/inbox', 'document.querySelectorAll("tbody tr").length >= 10', 'The Inbox did not load at 1280 px');
    await evaluate(`(() => { document.getElementById('stress-font')?.remove(); const style = document.createElement('style'); style.id = 'stress-font'; style.textContent = ${JSON.stringify(fontCss)}; document.head.appendChild(style); })()`);
    await sleep(300);
    const layout = (await evaluate(`(() => {
      const table = document.querySelector('table');
      const card = table.parentElement;
      const heads = [...table.querySelectorAll('thead th')].map((th) => ({ text: th.textContent.trim(), width: th.getBoundingClientRect().width, shown: getComputedStyle(th).display !== 'none' }));
      const pills = [...table.querySelectorAll('.rounded-pill')].filter((el) => el.getBoundingClientRect().width > 0).map((el) => el.getBoundingClientRect().height);
      return { tableWidth: table.scrollWidth, cardWidth: card.clientWidth, heads, tallestPill: Math.max(...pills) };
    })()`)) as { tableWidth: number; cardWidth: number; heads: Array<{ text: string; width: number; shown: boolean }>; tallestPill: number };
    const widths = layout.heads.filter((h) => h.shown).map((h) => `${h.text} ${Math.round(h.width)}`).join(', ');
    if (layout.tableWidth > layout.cardWidth) fail(`At 1280 px, in ${fontName}, the table is ${layout.tableWidth} px wide inside a ${layout.cardWidth} px card: it scrolls sideways (${widths})`);
    await noSidewaysScroll(`The Inbox at 1280 px in ${fontName}`, 1280);
    const head = (name: string) => layout.heads.find((h) => h.text === name);
    if ((head('Subject')?.width ?? 0) < 260) fail(`At 1280 px, in ${fontName}, the Subject column is ${head('Subject')?.width} px wide (260 px at least)`);
    if ((head('From')?.width ?? 999) > 175) fail(`At 1280 px, in ${fontName}, the From column is ${head('From')?.width} px wide (it should be narrow)`);
    if (head('Confidence')?.shown) fail('At 1280 px Confidence is still a column of its own: it should be folded into Read as');
    if (layout.tallestPill > 30) fail(`At 1280 px, in ${fontName}, a pill is ${layout.tallestPill} px tall: its text wraps`);
    const foldedConfidence = Number(await evaluate('[...document.querySelectorAll("tbody tr")].filter((tr) => /\\b(high|medium|low)\\s+0\\.\\d\\d/i.test(tr.cells[2].innerText)).length'));
    if (foldedConfidence < 5) fail(`At 1280 px only ${foldedConfidence} rows show the confidence inside Read as`);
    const fullAddress = Number(await evaluate('[...document.querySelectorAll("tbody tr td:first-child p[title]")].filter((p) => p.title.includes("@")).length'));
    if (fullAddress < 5) fail('The From cell does not carry the full address on hover');
    console.log(`PASS  the Inbox at 1280 px in ${fontName}: no sideways scroll (${Math.round(layout.tableWidth)} of ${layout.cardWidth} px), Subject ${Math.round(head('Subject')?.width ?? 0)} px, From ${Math.round(head('From')?.width ?? 0)} px, Confidence folded into Read as, pills on one line`);

    await viewport(1440, 900, false);
    await sleep(300);
    const wide = (await evaluate(`[...document.querySelectorAll('thead th')].map((th) => th.textContent.trim() + ':' + (getComputedStyle(th).display !== 'none'))`)) as string[];
    if (!wide.includes('Confidence:true')) fail('At 1440 px Confidence is not its own column');
    await noSidewaysScroll(`The Inbox at 1440 px in ${fontName}`, 1440);
    const wideLayout = (await evaluate(`(() => { const table = document.querySelector('table'); return { table: table.scrollWidth, card: table.parentElement.clientWidth }; })()`)) as { table: number; card: number };
    if (wideLayout.table > wideLayout.card) fail(`At 1440 px, in ${fontName}, the table (${wideLayout.table} px) is wider than its card (${wideLayout.card} px)`);
    console.log(`PASS  at 1440 px in ${fontName} Confidence is its own column again, with no sideways scroll`);
    await evaluate("document.getElementById('stress-font')?.remove()");
  }

  await viewport(375, 800, true);
  for (const route of ['overview', 'inbox', 'approvals', 'deals', 'audit']) {
    await go(`#/${route}`, 'document.body.innerText.length > 200', `The ${route} page did not load at 375 px`);
    await sleep(500);
    await noSidewaysScroll(`The ${route} page at 375 px`, 375);
  }
  const navShown = await evaluate('getComputedStyle(document.querySelector("#sections")).display !== "none"');
  if (navShown) fail('At 375 px the navigation list is still open: it should be behind a menu button');
  await evaluate('document.querySelector("[data-menu-button]").click()');
  await waitFor('getComputedStyle(document.querySelector("#sections")).display !== "none"', 'The menu button did not open the navigation');
  await evaluate('[...document.querySelectorAll("#sections a")].find((a) => /^Deals$/.test(a.textContent.trim())).click()');
  await waitFor('getComputedStyle(document.querySelector("#sections")).display === "none"', 'Choosing a section did not close the menu');
  console.log('PASS  at 375 px the navigation is behind a menu button, opens, and closes when a section is chosen; no page scrolls sideways');
  await viewport(1280, 900, false);

  // ---- the guest demo, in the same real browser, as a different visitor (cookies cleared) --------------------------------------------------
  // "Try the demo" -> ingest -> analyse -> match -> decide -> approve one plan -> "Start over" -> back at the start.
  await cdp.send('Network.clearBrowserCookies');
  await viewport(1280, 900, false);
  await cdp.send('Page.navigate', { url: `http://localhost:${port}/#/inbox` });
  await waitFor('!!document.querySelector("[data-try-demo]")', 'The sign-in page does not offer "Try the demo"');
  const entryText = String(await evaluate('document.querySelector("[data-guest-entry]").innerText'));
  if (!/no model is called/i.test(entryText)) fail('The guest entry does not say that no model is called');
  await evaluate('document.querySelector("[data-try-demo]").click()');
  await waitFor('!!document.querySelector("[data-guest-banner]")', 'Starting the guest demo did not show the guest banner');
  const banner = String(await evaluate('document.querySelector("[data-guest-banner]").innerText'));
  if (!banner.includes('Model answers are replayed from a recorded real run of gemini-3.5-flash-lite (2026-10-17, 1 of 3 runs)')) fail(`The banner says: ${banner}`);
  if (!/Resets in \d+ min/.test(banner)) fail('The banner shows no time left');
  const disabledOwnerOnly = Number(await evaluate('document.querySelectorAll("[data-owner-only]").length'));
  if (disabledOwnerOnly < 2) fail('The owner-only sections are not shown disabled');
  console.log('PASS  "Try the demo" starts a guest session; the banner names the recorded run and the time left; owner-only sections are disabled');

  await waitFor('[...document.querySelectorAll("button")].some((b) => /ingest new email/i.test(b.textContent))', 'The guest Inbox did not load');
  await evaluate('[...document.querySelectorAll("button")].find((b) => /ingest new email/i.test(b.textContent)).click()');
  await waitFor('document.querySelectorAll("a[href^=\\"#/inbox/\\"]").length >= 10', 'A guest ingesting did not show the ten emails');
  for (const label of ['analyse waiting email', 'match to crm', 'decide']) {
    await evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent.toLowerCase().includes(${JSON.stringify(label)})).click()`);
    await sleep(1500);
  }
  await waitFor('document.body.innerText.includes("Waiting for approval")', 'A guest running the pipeline reached no plan waiting for approval');
  console.log('PASS  a guest can ingest, analyse, match and decide the ten emails');

  // V-1: the guest's Overview says what is true of the guest.
  await go('#/overview', '/language model/i.test(document.body.innerText) && /sending replies/i.test(document.body.innerText)', "The guest's Overview did not load");
  const guestCards = String(await evaluate('document.body.innerText.replace(/\\s+/g, " ")'));
  for (const sentence of [
    'Replay of a recorded real run of gemini-3.5-flash-lite (2026-10-17). No live model calls.',
    'Guest demo. No sign-in, private sandbox.',
    'Always off in the guest demo.',
  ]) {
    if (!guestCards.includes(sentence)) fail(`The guest Overview does not say: "${sentence}"`);
  }
  for (const untrue of ['Live model calls, with every reply', 'requires a signed-in operator', 'until sending is turned on']) {
    if (guestCards.includes(untrue)) fail(`The guest Overview still says: "${untrue}"`);
  }
  console.log('PASS  the guest Overview says it is a replay, that there is no sign-in, and that sending is always off');

  // V-2 as a guest: Continue on the ambiguous email (E-04) finds two Harborview records. The result is shown, and the guest chooses.
  await go('#/approvals', '!!document.querySelector("[data-needs-person-tab]")', 'The guest has no "Needs a person" tab');
  await evaluate('document.querySelector("[data-needs-person-tab]").click()');
  await waitFor('document.querySelectorAll("[data-needs-person-list] section").length >= 1', 'The guest has nothing under "Needs a person"');
  // E-04 (Mark Doyle, Harborview Group) is the one whose matching also finds the existing Harborview Digital.
  await evaluate(
    '[...document.querySelectorAll("[data-needs-person-list] section")].find((row) => /Reporting work for Harborview/.test(row.innerText)).querySelectorAll("button").forEach((b) => { if (/continue to crm matching/i.test(b.textContent)) b.click(); })',
  );
  await waitFor(
    '!!document.querySelector("[data-row-note]") && document.querySelector("[data-row-note]").innerText.includes("choose one")',
    'After Continue on the ambiguous email the guest was not told that matching found more than one possible record',
  );
  console.log('PASS  as a guest, Continue on E-04 says: "Continued. CRM matching found more than one possible record; choose one."');
  await waitFor('!!document.querySelector("[data-choose-record]")', 'The guest was not shown the candidates to choose from');
  const guestChoices = String(await evaluate('document.querySelector("[data-choose-record]").innerText'));
  if (!/Harborview/.test(guestChoices)) fail('The candidates for E-04 do not name Harborview');
  for (let pick = 0; pick < 3 && !String(await evaluate('document.body.innerText')).includes('The plan is waiting for approval'); pick += 1) {
    await evaluate('[...document.querySelectorAll("[data-choose-record] button")].find((b) => /choose this record/i.test(b.textContent)).click()');
    await sleep(1200);
  }
  await waitFor('document.body.innerText.includes("Record chosen. The plan is waiting for approval.")', 'The guest choosing a record did not leave a plan waiting for approval');
  console.log('PASS  as a guest, choosing one of the Harborview records leaves a plan waiting for approval');

  // Out of the Approvals page and back in, so it opens on the plans waiting for approval rather than on the list it was left on.
  await go('#/inbox', 'document.querySelectorAll("tbody tr").length >= 10', 'The guest Inbox did not load');
  await cdp.send('Page.navigate', { url: `http://localhost:${port}/#/approvals` });
  await waitFor('[...document.querySelectorAll("button")].some((b) => /approve and carry out/i.test(b.textContent))', 'The guest has no plan to approve');
  const guestApprovals = String(await evaluate('document.body.innerText'));
  if (/\d+h \d+m left/.test(guestApprovals)) fail('A guest approval still shows an owner-style "23h 59m left" timer');
  if (!/Demo ends in/.test(guestApprovals)) fail('A guest approval shows no sandbox time left');
  console.log('PASS  a guest approval shows how long the demo has left, not a 24-hour timer');
  await evaluate('[...document.querySelectorAll("button")].find((b) => /approve and carry out/i.test(b.textContent)).click()');
  await waitFor('/Approved and carried out \\d+ actions?\\./.test(document.body.innerText)', 'Approving a plan as a guest did not carry it out');
  if (/action\(s\)/.test(String(await evaluate('document.body.innerText')))) fail('The approval message still says "action(s)"');
  console.log('PASS  a guest can approve a plan and it is carried out (in the sandbox; nothing is sent)');

  // V-5: Start over asks first. Cancelling changes nothing.
  await evaluate('document.querySelector("[data-guest-start-over]").click()');
  await waitFor('!!document.querySelector("[data-guest-confirm]")', 'Start over did not ask first');
  if (!String(await evaluate('document.querySelector("[data-guest-confirm]").innerText')).includes('Start over? Your changes in this demo will be lost.')) fail('The Start over question is not the agreed one');
  await evaluate('document.querySelector("[data-guest-confirm-no]").click()');
  await waitFor('!document.querySelector("[data-guest-confirm]")', 'Cancel did not close the Start over question');
  await go('#/inbox', 'document.querySelectorAll("tbody tr").length >= 10', 'Cancelling Start over lost the emails');
  console.log('PASS  Start over asks "Start over? Your changes in this demo will be lost."; Cancel keeps everything');

  // V-4 as a guest on a phone: one compact line, the full text behind Details, both controls reachable, nothing scrolls sideways.
  await viewport(375, 800, true);
  await go('#/inbox', 'document.querySelectorAll("tbody tr").length >= 10 && !!document.querySelector("[data-guest-banner]")', 'The guest Inbox did not load at 375 px');
  await sleep(500);
  const phone = (await evaluate(`(() => {
    const b = document.querySelector('[data-guest-banner]').getBoundingClientRect();
    const reach = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= window.innerWidth; };
    const menu = document.querySelector('[data-menu-button]').getBoundingClientRect();
    return { bannerHeight: b.height, startOver: reach('[data-guest-start-over]'), leave: reach('[data-guest-leave]'), details: reach('[data-guest-details]'), menuTop: menu.top, text: document.querySelector('[data-guest-banner]').innerText };
  })()`)) as { bannerHeight: number; startOver: boolean; leave: boolean; details: boolean; menuTop: number; text: string };
  if (phone.bannerHeight > 64) fail(`At 375 px the guest banner is ${Math.round(phone.bannerHeight)} px tall: it should be one compact line`);
  if (!(phone.startOver && phone.leave && phone.details)) fail('At 375 px Start over, Leave or Details is not reachable on screen');
  if (phone.menuTop > 140) fail(`At 375 px the page starts ${Math.round(phone.menuTop)} px down: the banner and navigation still fill the first screen`);
  if (phone.text.includes('Model answers are replayed')) fail('At 375 px the full banner text is shown without asking for Details');
  await evaluate('document.querySelector("[data-guest-details]").click()');
  await waitFor('document.querySelector("[data-guest-details-text]")?.innerText.includes("Model answers are replayed from a recorded real run")', 'Details did not show the full banner text');
  await noSidewaysScroll('The guest Inbox at 375 px', 375);
  console.log(`PASS  at 375 px the guest banner is one line (${Math.round(phone.bannerHeight)} px), the full text is behind Details, Start over and Leave are reachable`);
  await viewport(1280, 900, false);
  await go('#/inbox', '!!document.querySelector("[data-guest-banner]")', 'The guest Inbox did not come back at 1280 px');

  await evaluate('document.querySelector("[data-guest-start-over]").click()');
  await waitFor('!!document.querySelector("[data-guest-confirm-yes]")', 'Start over did not ask first');
  await evaluate('document.querySelector("[data-guest-confirm-yes]").click()');
  await sleep(1200);
  await waitFor('!!document.querySelector("[data-guest-banner]")', 'After "Start over" the guest banner is gone');
  await waitFor('document.body.innerText.includes("No email yet")', 'After "Start over" the inbox is not back at the start');
  console.log('PASS  "Start over" puts the sandbox back at the beginning');

  await go('#/approvals', '!!document.querySelector("[data-needs-person-tab]")', 'The guest Approvals page did not load before leaving');
  await evaluate('document.querySelector("[data-guest-leave]").click()');
  await waitFor('!!document.querySelector("[data-try-demo]") && !document.querySelector("[data-guest-banner]")', 'Leaving the demo did not return to the sign-in page');
  const here = String(await evaluate('location.pathname + location.hash'));
  if (here !== '/') fail(`After leaving the demo the address is "${here}" instead of "/"`);
  console.log('PASS  leaving the demo returns to the sign-in page at "/" (the #/approvals deep link is gone)');

  cdp.close();
  console.log('\nRESULT: the documented first run works in a real browser.');
} catch (error) {
  exitCode = 1;
  if (!(error instanceof CheckFailed)) console.error(error);
} finally {
  stop(chrome);
  stop(server);
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chrome may still hold a file for a moment; a temporary folder is harmless.
  }
}
process.exit(exitCode);
