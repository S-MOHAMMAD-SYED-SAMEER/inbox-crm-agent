import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GOLD_LABEL, GOLD_PROVENANCE, LEGACY_GOLD_LABEL, goldBanner } from '../src/eval/provenance.ts';

// Who wrote the data the evaluations are scored against, and that every place a number appears says so.

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');
const read = (...parts: string[]) => fs.readFileSync(path.join(...parts), 'utf8');

test('the label says who wrote the gold, that it was reviewed with AI help, and that it is not independent; the old label is kept for old results', () => {
  assert.match(GOLD_LABEL, /gold written by Claude/);
  assert.match(GOLD_LABEL, /reviewed with AI assistance \(Claude\)/);
  assert.match(GOLD_LABEL, /final decisions approved by Sameer/);
  assert.match(GOLD_LABEL, /not an independent human review/);
  assert.match(LEGACY_GOLD_LABEL, /AI-written/);
  assert.match(LEGACY_GOLD_LABEL, /not yet human-reviewed/);
  assert.match(GOLD_PROVENANCE, /written by Claude/);
  assert.match(GOLD_PROVENANCE, /not an independent human review/);
  assert.deepEqual(goldBanner(), [`  Gold data: ${GOLD_LABEL}`]);
});

test('every evaluation dataset says who wrote it', () => {
  for (const name of ['understand', 'resolve', 'decide']) {
    const dataset = JSON.parse(read(SERVER_ROOT, 'eval', `${name}.dataset.json`)) as { provenance?: string; goldLabel?: string; version?: string };
    assert.match(dataset.provenance ?? '', /written by Claude/, `${name}.dataset.json has no provenance`);
    assert.match(dataset.provenance ?? '', /reviewed with AI assistance/i);
    assert.match(dataset.provenance ?? '', /not an independent human review/i);
    assert.equal(dataset.goldLabel, GOLD_LABEL, `${name}.dataset.json declares a different label from the code`);
    assert.match(dataset.version ?? '', /-1\.[1-9]\.0$/, `${name}.dataset.json was not versioned after the review`);
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
  const readme = read(REPO_ROOT, 'README.md');
  assert.ok(readme.includes(GOLD_LABEL), 'the README does not carry the label of the gold it reports against');
  assert.match(readme, /not an independent human review/);
  assert.match(read(REPO_ROOT, 'docs', 'results', 'RESULTS_SUMMARY.md'), /not an independent human\s+review/);
});

test('npm run eval:real is a dry run unless told --go, and refuses --go without a key', () => {
  const env = { ...process.env, GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '' };
  const dry = spawnSync(process.execPath, ['scripts/eval-real.ts'], { cwd: SERVER_ROOT, env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /REAL-MODEL evaluation: gemini, model gemini-3\.5-flash-lite, temperature 1/);
  assert.match(dry.stdout, /Expected requests: 10 to read the emails and up to 3 to draft replies: about 13 requests, up to 23/);
  assert.match(dry.stdout, /DRY RUN: nothing was called/);
  assert.match(dry.stdout, /scored against gold written by Claude; reviewed with AI assistance/);

  const go = spawnSync(process.execPath, ['scripts/eval-real.ts', '--go'], { cwd: SERVER_ROOT, env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(go.status, 1);
  assert.match(go.stderr, /Not starting: the gemini API key is not set/);
  assert.ok(!/Report saved/.test(go.stdout));
});
