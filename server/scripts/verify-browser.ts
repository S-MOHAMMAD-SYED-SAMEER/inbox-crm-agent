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
