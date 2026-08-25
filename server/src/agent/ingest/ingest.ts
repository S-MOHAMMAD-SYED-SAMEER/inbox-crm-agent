import { sanitiseEmailBody, MAX_BODY_LENGTH } from './sanitise.ts';
import type { EmailSource } from '../../adapters/email/types.ts';
import type { Repositories } from '../../db/repositories/index.ts';
import type { CanonicalEmail, EmailRecord } from '../../domain/email.ts';
import type { Logger } from '../../lib/logger.ts';
import { createLogger } from '../../lib/logger.ts';

// The ingestion stage (FR-1..FR-4).
//
// Pulls from whatever `EmailSource` is configured, sanitises, stores, and
// records an audit event per message. Everything it depends on is injected, so
// the whole stage can be exercised with an in-memory source and database — no
// network, no file, no credentials.
//
// TRIGGERING is explicit (spec §14): a call to `POST /api/emails/ingest`. There
// is no worker, queue, or cron, because there is nothing to deploy them onto
// yet and infrastructure with nothing running on it is just more surface.
//
// DEDUPE is the database's job, through the UNIQUE (provider,
// provider_message_id) constraint. A re-run is therefore a no-op rather than a
// second copy of yesterday's leads — which matters because the demo source
// re-offers everything it has after a restart, exactly as a real provider
// replaying its history would.

export type IngestResult = {
  ingested: EmailRecord[];
  duplicates: number;
  correlationIds: string[];
};

export type IngestDeps = {
  repos: Repositories;
  source: EmailSource;
  logger?: Logger;
  maxBodyLength?: number;
};

export async function ingestEmails(
  { repos, source, logger = createLogger('ingest'), maxBodyLength = MAX_BODY_LENGTH }: IngestDeps,
  options: { since?: string; limit?: number } = {},
): Promise<IngestResult> {
  const since = options.since ?? '1970-01-01T00:00:00.000Z';
  const fetched = await source.fetchNew(since, options.limit === undefined ? {} : { limit: options.limit });

  const ingested: EmailRecord[] = [];
  const correlationIds: string[] = [];
  let duplicates = 0;

  for (const message of fetched.messages) {
    const sanitised = sanitiseEmailBody(message.bodyText, { maxLength: maxBodyLength });

    // The sanitised text is what gets stored. The raw body is never persisted,
    // so no future screen can render unsanitised content by forgetting to ask.
    const canonical: CanonicalEmail = { ...message, bodyText: sanitised.text };

    const { email, created } = await repos.emails.insertIfNew(canonical, {
      bodyTruncated: sanitised.record.truncated,
    });

    if (!created) {
      duplicates++;
      await repos.audit.append({
        correlationId: email.correlationId,
        emailId: email.id,
        stage: 'ingest',
        eventType: 'email_received',
        actor: 'system',
        outcome: 'skipped',
        summary: 'Message already ingested; no duplicate created.',
        payload: { providerMessageId: email.providerMessageId, provider: email.provider },
      });
      continue;
    }

    await repos.audit.append({
      correlationId: email.correlationId,
      emailId: email.id,
      stage: 'ingest',
      eventType: 'email_received',
      actor: 'system',
      outcome: 'ok',
      // The summary names the sender's domain rather than the address: enough
      // to identify the message in a log, without copying an address into a
      // second place it will never be deleted from.
      summary: `Received "${email.subject}" from ${email.fromEmail.split('@')[1] ?? 'unknown'}.`,
      payload: { providerMessageId: email.providerMessageId, provider: email.provider },
    });

    // Sanitisation is audited only when it actually removed something —
    // otherwise every single email would carry a "nothing happened" event and
    // the log would be mostly noise.
    const { record } = sanitised;
    const removedSomething =
      record.removedHtml ||
      record.removedScripts > 0 ||
      record.removedRemoteImages > 0 ||
      record.removedHiddenCharacters > 0 ||
      record.truncated;

    if (removedSomething) {
      await repos.audit.append({
        correlationId: email.correlationId,
        emailId: email.id,
        stage: 'ingest',
        eventType: 'content_sanitised',
        actor: 'system',
        outcome: record.truncated ? 'blocked' : 'ok',
        summary: describeSanitisation(record),
        payload: { ...record },
      });
    }

    ingested.push(email);
    correlationIds.push(email.correlationId);
  }

  logger.info('Ingestion complete', {
    fetched: fetched.messages.length,
    ingested: ingested.length,
    duplicates,
  });

  return { ingested, duplicates, correlationIds };
}

function describeSanitisation(record: {
  removedHtml: boolean;
  removedScripts: number;
  removedRemoteImages: number;
  removedHiddenCharacters: number;
  truncated: boolean;
}): string {
  const parts: string[] = [];
  if (record.removedHtml) parts.push('converted HTML to text');
  if (record.removedScripts > 0) parts.push(`removed ${record.removedScripts} script/style block(s)`);
  if (record.removedRemoteImages > 0) parts.push(`removed ${record.removedRemoteImages} remote reference(s)`);
  if (record.removedHiddenCharacters > 0) {
    parts.push(`removed ${record.removedHiddenCharacters} hidden character(s)`);
  }
  if (record.truncated) parts.push('truncated the body for analysis');
  return `Sanitised the message: ${parts.join(', ')}.`;
}
