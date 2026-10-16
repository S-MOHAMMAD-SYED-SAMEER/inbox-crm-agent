import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GOLD_LABEL, GOLD_PROVENANCE, goldBanner } from '../src/eval/provenance.ts';

// Who wrote the data the evaluations are scored against, and that every place a number appears says so.

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');
const read = (...parts: string[]) => fs.readFileSync(path.join(...parts), 'utf8');

test('the label says AI-written and not human-reviewed, and the banner carries it', () => {
  assert.match(GOLD_LABEL, /AI-written/);
  assert.match(GOLD_LABEL, /not yet human-reviewed/);
  assert.match(GOLD_PROVENANCE, /written by Claude/);
  assert.deepEqual(goldBanner(), [`  Gold data: ${GOLD_LABEL}`]);
});

test('every evaluation dataset says who wrote it', () => {
  for (const name of ['understand', 'resolve', 'decide']) {
    const dataset = JSON.parse(read(SERVER_ROOT, 'eval', `${name}.dataset.json`)) as { provenance?: string };
    assert.match(dataset.provenance ?? '', /written by Claude/, `${name}.dataset.json has no provenance`);
    assert.match(dataset.provenance ?? '', /not human-reviewed/);
  }
});

test('every demo email, and the CRM seed, says who wrote it', () => {
  const emails = JSON.parse(read(SERVER_ROOT, 'data', 'demo', 'emails.json')) as Array<{ providerMessageId: string; provenance?: string }>;
  assert.equal(emails.length, 10);
  for (const email of emails) {
    assert.match(email.provenance ?? '', /AI-written/, `${email.providerMessageId} has no provenance`);
    assert.match(email.provenance ?? '', /mockUnderstanding and mockDraft/);
  }
  const seed = JSON.parse(read(SERVER_ROOT, 'data', 'demo', 'crm-seed.json')) as { _note: string[] };
  assert.ok(seed._note.some((line) => /AI-written/.test(line)));
  assert.match(read(SERVER_ROOT, 'data', 'demo', 'PROVENANCE.md'), /not human-reviewed|No person has reviewed/);
});

test('the specification and the two other docs carry the same statement', () => {
  for (const doc of ['PROJECT2_INBOX_CRM_SPEC.md', 'PROJECT2_SYSTEM_AUDIT.md', 'PROJECT2_DEMO_SCRIPT.md']) {
    const head = read(REPO_ROOT, 'docs', doc).split('\n').slice(0, 5).join('\n');
    assert.match(head, /Provenance:.*written by Claude.*Not human-reviewed/, `${doc} is not labelled`);
  }
});

test('every evaluation script prints the label, and the README explains it', () => {
  for (const script of ['understand', 'resolve', 'decide', 'execute', 'revise', 'outbound', 'real']) {
    assert.match(read(SERVER_ROOT, 'scripts', `eval-${script}.ts`), /goldBanner|GOLD_LABEL/, `eval-${script} does not print the label`);
  }
  assert.match(read(REPO_ROOT, 'README.md'), /scored against AI-written gold \(Claude-written, not yet human-reviewed\)/);
});

test('npm run eval:real is a dry run unless told --go, and refuses --go without a key', () => {
  const env = { ...process.env, GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '' };
  const dry = spawnSync(process.execPath, ['scripts/eval-real.ts'], { cwd: SERVER_ROOT, env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /REAL-MODEL evaluation: gemini, model gemini-3\.5-flash-lite, temperature 1/);
  assert.match(dry.stdout, /Expected requests: 10 to read the emails and up to 3 to draft replies: about 13 requests, up to 23/);
  assert.match(dry.stdout, /DRY RUN: nothing was called/);
  assert.match(dry.stdout, /scored against AI-written gold/);

  const go = spawnSync(process.execPath, ['scripts/eval-real.ts', '--go'], { cwd: SERVER_ROOT, env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(go.status, 1);
  assert.match(go.stderr, /Not starting: the gemini API key is not set/);
  assert.ok(!/Report saved/.test(go.stdout));
});
