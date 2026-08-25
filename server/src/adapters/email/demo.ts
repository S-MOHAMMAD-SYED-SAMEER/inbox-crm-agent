import fs from 'node:fs';
import path from 'node:path';
import { ProblemCollector, requireEmail, requireIsoTimestamp, requireString, optionalString } from '../../lib/validate.ts';
import type { CanonicalEmail } from '../../domain/email.ts';
import type { EmailSource, FetchResult } from './types.ts';

// The demo email source: a JSON file on disk.
//
// It is the *only* source in this build, and it is what makes the demo
// deterministic and free — no OAuth consent screen on a client call, no
// mailbox to prepare, no network. Its fixtures are validated on load with the
// same strictness a real provider's payload would get, so a malformed fixture
// fails at the fixture rather than three stages downstream.
//
// `markProcessed` records ids in memory rather than writing to the file. The
// database already knows what has been ingested (FR-2 dedupe on
// provider_message_id), so persisting a second copy of that fact here would be
// two sources of truth for the same thing. A restart re-offers the messages and
// the database no-ops them — which is exactly the behaviour a real provider
// replaying its history would produce, and therefore the behaviour worth
// testing against.

export type DemoEmailFixture = CanonicalEmail & {
  /** Binds a canned model response to this message (see adapters/llm/mock.ts). */
  fixtureId?: string;
  /** Free-text note about what this fixture demonstrates. Ignored at runtime. */
  scenario?: string;
  /**
   * The canned model response for this email (spec §22). Read by
   * adapters/llm/fixtures.ts, never by the pipeline — the pipeline has no idea
   * fixtures exist.
   */
  mockUnderstanding?: Record<string, unknown>;
};

export function parseDemoFixtures(raw: unknown, sourceLabel: string): DemoEmailFixture[] {
  const problems = new ProblemCollector();

  if (!Array.isArray(raw)) {
    problems.add(`${sourceLabel} must contain a JSON array of messages`);
    problems.throwIfAny(`The demo email fixtures could not be loaded.`);
    return [];
  }

  const seen = new Set<string>();
  const messages: DemoEmailFixture[] = raw.map((entry, index) => {
    const where = `${sourceLabel}[${index}]`;
    const record = (entry ?? {}) as Record<string, unknown>;

    const providerMessageId = requireString(record.providerMessageId, `${where}.providerMessageId`, problems);
    if (providerMessageId !== '') {
      if (seen.has(providerMessageId)) {
        problems.add(`${where}: duplicate providerMessageId "${providerMessageId}"`);
      }
      seen.add(providerMessageId);
    }

    return {
      provider: 'demo',
      providerMessageId,
      threadId: optionalString(record.threadId, `${where}.threadId`, problems),
      fromName: optionalString(record.fromName, `${where}.fromName`, problems),
      fromEmail: requireEmail(record.fromEmail, `${where}.fromEmail`, problems),
      toEmail: requireEmail(record.toEmail, `${where}.toEmail`, problems),
      cc: optionalString(record.cc, `${where}.cc`, problems),
      subject: requireString(record.subject, `${where}.subject`, problems, { allowEmpty: true }),
      bodyText: requireString(record.bodyText, `${where}.bodyText`, problems, { maxLength: 100_000 }),
      headers: (record.headers ?? {}) as Record<string, string>,
      receivedAt: requireIsoTimestamp(record.receivedAt, `${where}.receivedAt`, problems),
      ...(typeof record.fixtureId === 'string' ? { fixtureId: record.fixtureId } : {}),
      ...(typeof record.scenario === 'string' ? { scenario: record.scenario } : {}),
      ...(record.mockUnderstanding && typeof record.mockUnderstanding === 'object'
        ? { mockUnderstanding: record.mockUnderstanding as Record<string, unknown> }
        : {}),
    };
  });

  problems.throwIfAny('The demo email fixtures are not valid.');

  // Oldest first — see the interface note on fetchNew.
  return messages.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}

export function createDemoEmailSource(options: { filePath?: string; fixtures?: DemoEmailFixture[] } = {}): EmailSource {
  const processed = new Set<string>();

  const load = (): DemoEmailFixture[] => {
    if (options.fixtures) return [...options.fixtures].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    const filePath = options.filePath;
    if (!filePath) throw new Error('createDemoEmailSource requires either `fixtures` or `filePath`.');
    if (!fs.existsSync(filePath)) {
      throw new Error(`Demo email fixtures not found at ${filePath}.`);
    }
    return parseDemoFixtures(JSON.parse(fs.readFileSync(filePath, 'utf8')), path.basename(filePath));
  };

  return {
    name: 'demo',

    async fetchNew(since: string, fetchOptions: { cursor?: string; limit?: number } = {}): Promise<FetchResult> {
      const limit = Math.min(Math.max(fetchOptions.limit ?? 50, 1), 200);
      const cursor = fetchOptions.cursor;

      const eligible = load().filter((message) => {
        if (processed.has(message.providerMessageId)) return false;
        // Resuming: the cursor carries receivedAt *and* id, so paging cannot
        // skip or repeat a message that shares a timestamp with another —
        // which is exactly the case a timestamp alone cannot resolve.
        if (cursor !== undefined) return `${message.receivedAt}|${message.providerMessageId}` > cursor;
        // Starting fresh: strictly after `since`, as the interface states.
        return message.receivedAt > since;
      });

      const page = eligible.slice(0, limit);
      const last = page[page.length - 1];
      const hasMore = eligible.length > page.length;

      const result: FetchResult = { messages: page.map(toCanonical) };
      if (hasMore && last) result.cursor = `${last.receivedAt}|${last.providerMessageId}`;
      return result;
    },

    async markProcessed(providerMessageId: string): Promise<void> {
      processed.add(providerMessageId);
    },

    // No `send`. Nothing in this build can deliver mail, and the interface
    // makes that a fact about the type rather than a promise in a comment.
  };
}

function toCanonical(fixture: DemoEmailFixture): CanonicalEmail {
  return {
    provider: fixture.provider,
    providerMessageId: fixture.providerMessageId,
    threadId: fixture.threadId,
    fromName: fixture.fromName,
    fromEmail: fixture.fromEmail,
    toEmail: fixture.toEmail,
    cc: fixture.cc,
    subject: fixture.subject,
    bodyText: fixture.bodyText,
    headers: fixture.headers,
    receivedAt: fixture.receivedAt,
  };
}
