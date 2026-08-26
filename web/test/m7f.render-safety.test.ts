import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeDecideBatch } from '../src/inbox/batchReport.ts';

// M7-F — the two frontend faults the first manual browser pass exposed.
//
// Both had been in the product since the freeze, and neither could be caught by
// anything here: there is no jsdom, Playwright or Cypress (NFR-9), so no test
// in this project renders a component. These tests close that gap in the only
// way available — by reading the source for the specific shapes that break a
// render, and by testing the message logic as a pure function.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const read = (relative: string): string => fs.readFileSync(path.join(SRC, relative), 'utf8');

// ================================================ hook order (React #310)

/**
 * Finds a hook called after an early return, which is React error #310.
 *
 * Written to be checkable on a fixture as well as on real files, because the
 * first version of this scan reported a clean result on code that was already
 * broken — see the negative control below.
 */
function hooksAfterEarlyReturn(source: string): Array<{ component: string; returnLine: number; hookLine: number }> {
  // Generics matter: `useState<string | null>(` puts `<...>` between the name
  // and the parenthesis, and a pattern that demands them adjacent silently
  // matches nothing.
  const HOOK = /\buse(?:State|Effect|Callback|Memo|Ref|Reducer|Context|Transition|DeferredValue|Id)\s*(?:<[^>]*>)?\s*\(/;
  const EARLY_RETURN = /^ {2}(?:if \(.*\)\s*)?return\b|^ {4}return\b/;
  const COMPONENT = /^export function ([A-Z][A-Za-z0-9]*)/;

  const found: Array<{ component: string; returnLine: number; hookLine: number }> = [];
  let component: string | null = null;
  let returnLine = 0;

  source.split('\n').forEach((line, index) => {
    const declaration = COMPONENT.exec(line);
    if (declaration) {
      component = declaration[1] ?? null;
      returnLine = 0;
      return;
    }
    if (component === null) return;

    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

    if (returnLine === 0 && EARLY_RETURN.test(line) && !line.trimEnd().endsWith('return (')) {
      returnLine = index + 1;
      return;
    }
    if (returnLine !== 0 && HOOK.test(line)) {
      found.push({ component, returnLine, hookLine: index + 1 });
      returnLine = 0;
    }
  });

  return found;
}

function componentFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.tsx')) found.push(full);
    }
  };
  walk(SRC);
  return found;
}

test('NEGATIVE CONTROL — the scan detects a hook after an early return', () => {
  // The exact shape that shipped: five hooks, an early return, then a sixth.
  // A scan that cannot fail is worse than no scan, and the first version of
  // this one reported zero findings against real broken code because its
  // pattern required `useState(` to be adjacent — which `useState<string |
  // null>(` is not.
  const broken = [
    'export function Broken({ id }: { id: string }): ReactNode {',
    "  const [state, setState] = useState<LoadState>({ status: 'loading' });",
    '  useEffect(() => { void load(); }, [load]);',
    "  if (state.status === 'loading') return <p>Loading…</p>;",
    '  const [refusal, setRefusal] = useState<string | null>(null);',
    '  return <div>{refusal}</div>;',
    '}',
  ].join('\n');

  const findings = hooksAfterEarlyReturn(broken);
  assert.equal(findings.length, 1, 'the scan missed a hook placed after an early return');
  assert.equal(findings[0]?.component, 'Broken');
  assert.equal(findings[0]?.returnLine, 4);
  assert.equal(findings[0]?.hookLine, 5);
});

test('NEGATIVE CONTROL — the scan accepts the same component once corrected', () => {
  const fixed = [
    'export function Fixed({ id }: { id: string }): ReactNode {',
    "  const [state, setState] = useState<LoadState>({ status: 'loading' });",
    '  const [refusal, setRefusal] = useState<string | null>(null);',
    '  useEffect(() => { void load(); }, [load]);',
    "  if (state.status === 'loading') return <p>Loading…</p>;",
    '  return <div>{refusal}</div>;',
    '}',
  ].join('\n');

  assert.deepEqual(hooksAfterEarlyReturn(fixed), []);
});

test('no component calls a hook after an early return', () => {
  const offenders: string[] = [];
  for (const file of componentFiles()) {
    for (const finding of hooksAfterEarlyReturn(fs.readFileSync(file, 'utf8'))) {
      offenders.push(
        `${path.relative(SRC, file).replace(/\\/g, '/')} — ${finding.component}() returns at line ` +
          `${finding.returnLine} then calls a hook at line ${finding.hookLine}`,
      );
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `React error #310 waiting to happen — a hook count that changes between renders:\n${offenders.join('\n')}`,
  );
});

test('EmailDetail declares every hook before its first return', () => {
  // The file that actually broke, guarded by name so a future edit that moves a
  // hook back down fails here rather than in front of a client.
  const source = read('screens/EmailDetail.tsx');
  const lines = source.split('\n');

  const componentLine = lines.findIndex((line) => line.startsWith('export function EmailDetail'));
  assert.ok(componentLine >= 0, 'EmailDetail is no longer declared as expected');

  const body = lines.slice(componentLine);
  const firstReturn = body.findIndex(
    (line) => /^ {2}(?:if \(.*\)\s*)?return\b/.test(line) && !line.trimEnd().endsWith('return ('),
  );
  assert.ok(firstReturn > 0, 'no early return found — the guard below would be meaningless');

  const HOOK = /\buse(?:State|Effect|Callback|Memo)\s*(?:<[^>]*>)?\s*\(/;
  const afterReturn = body.slice(firstReturn).filter((line) => HOOK.test(line) && !line.trim().startsWith('//'));

  assert.deepEqual(afterReturn.map((l) => l.trim()), [], 'a hook is declared after the early return again');

  // And the specific one that caused it is present, above the return.
  const beforeReturn = body.slice(0, firstReturn).join('\n');
  assert.match(beforeReturn, /const \[refusal, setRefusal\] = useState/);
});

// ============================================ batch reporting (silent failure)

test('a batch where everything failed does not read as a success', () => {
  // The exact production case: seven emails selected, seven threw, and the old
  // message said "Decided 0 email(s); 0 waiting for approval."
  const message = describeDecideBatch({ decided: 0, awaitingApproval: 0, noPlan: 0, failed: 7 });

  assert.match(message, /7/, 'the failure count is not shown');
  assert.match(message, /could not be decided/i);
  assert.ok(!message.startsWith('Decided 0'), 'it still opens with a zero count that reads as success');
});

test('nothing to do and everything failing produce different sentences', () => {
  // The distinction the old message could not make, and the reason a real
  // failure went unnoticed in production.
  const idle = describeDecideBatch({ decided: 0, awaitingApproval: 0, noPlan: 0, failed: 0 });
  const failed = describeDecideBatch({ decided: 0, awaitingApproval: 0, noPlan: 0, failed: 7 });

  assert.notEqual(idle, failed);
  assert.match(idle, /nothing was waiting/i);
});

test('a fully successful batch still reads plainly', () => {
  const message = describeDecideBatch({ decided: 7, awaitingApproval: 5, noPlan: 0, failed: 0 });

  assert.equal(message, 'Decided 7 email(s); 5 waiting for approval.');
  // No zero-valued noise.
  assert.ok(!/0 /.test(message));
});

test('partial failure is reported alongside the successes', () => {
  const message = describeDecideBatch({ decided: 5, awaitingApproval: 3, noPlan: 2, failed: 1 });

  assert.match(message, /Decided 5/);
  assert.match(message, /3 waiting for approval/);
  assert.match(message, /2 had no valid plan/);
  assert.match(message, /1 could not be decided/);
});

test('the Inbox renders the decide result through the reporter', () => {
  const source = read('screens/Inbox.tsx');

  assert.match(source, /describeDecideBatch\(result\)/, 'the Inbox no longer uses the reporter');
  // The old hand-built string must not come back.
  assert.ok(
    !/`Decided \$\{result\.decided\}/.test(source),
    'the Inbox is building the decide message inline again, which is how failures got hidden',
  );
});
