import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `node scripts/build-replay-recording.ts <report.json> [out.json]`
//
// Turns a SAVED real-model evaluation report into the recording the guest demo replays. It reads a file that already exists and makes
// no request. Only successful replies are kept, keyed by email, step and PROMPT VERSION, with the model, temperature and date of the
// run they came from: the guest demo says where its answers come from, and this is where that statement is made true.
//
//   node scripts/build-replay-recording.ts ../docs/results/2026-10-17-real-eval-gemini-gemini-3.5-flash-lite-run1.json

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = process.argv[2];
const outPath = process.argv[3] ?? path.join(SERVER_ROOT, 'data', 'replay', 'recorded-run.json');

if (!reportPath) {
  console.error('usage: node scripts/build-replay-recording.ts <report.json> [out.json]');
  process.exit(1);
}

type Call = {
  purpose: string;
  promptVersion: string;
  fixtureId?: string;
  ok: boolean;
  response?: { toolInput: Record<string, unknown>; model: string; latencyMs: number; stopReason: string };
};

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as {
  kind: string;
  startedAt: string;
  settings: { provider: string; model: string; temperature: number };
  items: Array<{ calls: Call[] }>;
};
if (report.kind !== 'real-evaluation') throw new Error('this is not a real-model evaluation report');

const replies = report.items
  .flatMap((item) => item.calls)
  .filter((call) => call.ok && call.response && call.fixtureId)
  .map((call) => ({
    fixtureId: call.fixtureId as string,
    purpose: call.purpose,
    promptVersion: call.promptVersion,
    toolInput: (call.response as NonNullable<Call['response']>).toolInput,
    latencyMs: Math.round((call.response as NonNullable<Call['response']>).latencyMs),
    stopReason: (call.response as NonNullable<Call['response']>).stopReason,
  }));

const keys = new Set(replies.map((r) => `${r.fixtureId}|${r.purpose}|${r.promptVersion}`));
if (keys.size !== replies.length) throw new Error('two recorded replies share an email, step and prompt version');

const recording = {
  kind: 'recorded-model-run',
  provenance: {
    provider: report.settings.provider,
    model: report.settings.model,
    temperature: report.settings.temperature,
    recordedAt: report.startedAt.slice(0, 10),
    run: '1 of 3 (the first of three repeats of the ten-email evaluation)',
    sourceReport: path.relative(path.resolve(SERVER_ROOT, '..'), path.resolve(reportPath)).split(path.sep).join('/'),
    promptVersions: Object.fromEntries([...new Set(replies.map((r) => `${r.purpose}:${r.promptVersion}`))].map((entry) => entry.split(':') as [string, string])),
    note: 'Real replies from a real run, replayed unchanged. The code around the model (validation, the follow-up check, the injection detector, the rules and the draft checks) runs live on each one.',
  },
  replies,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(recording, null, 2)}\n`, 'utf8');
console.log(`Recorded ${replies.length} replies from ${recording.provenance.sourceReport} to ${path.relative(process.cwd(), outPath)}.`);
