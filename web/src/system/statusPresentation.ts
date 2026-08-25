import type { Health } from '../api/types.ts';

// How system status is described on the Overview screen (M6-E).
//
// Pure, so it can be tested without a browser — the same split the revision,
// outbox and CRM presentation modules use (NFR-9, no jsdom).
//
// WHY THIS FILE EXISTS
//
// The Overview used to print the health `adapters` object directly: a monospace
// list of `llmProvider: mock`, `crmTarget: local`, `database: sqlite`,
// `corsAllowedOrigins: 0`. That is a diagnostics panel, and it was the first
// thing anyone saw after signing in. Two problems, and the second is the real
// one:
//
//   1. It is internal vocabulary. `crmTarget: local` is not a sentence.
//   2. Read literally by someone who does not know the system, it *understates*
//      it — `llmProvider: mock` invites "so none of this is real?" at the worst
//      possible moment.
//
// The answer is not to hide any of it. Every fact below is the same fact the
// health endpoint reports; it is stated in a sentence instead of a key/value
// pair. Where a value would flatter the system, it is still stated plainly:
// demo mode says it is demo mode.
//
// WHAT IS DELIBERATELY NOT SHOWN
//
// - `autonomyLevel`. Health reads it from configuration, but the value that
//   actually governs the running system lives in the `settings` table, and the
//   two can disagree — the demo seed sets `assisted` while the config default
//   is `manual`. Showing the config value would be stating something the system
//   might contradict, which is exactly the failure this pass is fixing. Until a
//   Settings screen reads it from its real source, it is not reported here.
// - `migrationsApplied`, `corsAllowedOrigins`, `cookieSecure`, the database
//   driver name and the build version. All are operator detail with no meaning
//   to whoever is being shown the product. They remain in the health payload,
//   which is where an operator looks for them.

export type StatusTone = 'good' | 'bad' | 'neutral';

export type StatusFact = {
  label: string;
  value: string;
  /** One line saying what the value means. Never a restatement of the label. */
  detail: string;
  tone: StatusTone;
};

/** The one-line answer to "is this thing running?". */
export function connectionStatus(health: Health): StatusFact {
  const connected = health.status === 'ok' && health.database.reachable;
  return {
    label: 'System',
    value: connected ? 'Running' : 'Degraded',
    detail: connected
      ? 'The service is answering and its records are reachable.'
      : 'The service is answering but its records are not reachable.',
    tone: connected ? 'good' : 'bad',
  };
}

function bool(adapters: Health['adapters'], key: string): boolean {
  return adapters[key] === true;
}

function text(adapters: Health['adapters'], key: string): string {
  const value = adapters[key];
  return typeof value === 'string' ? value : '';
}

/**
 * The configuration facts worth stating to someone being shown the product.
 *
 * Ordered by what a person asks first. Outbound sending leads because it is the
 * one that changes what they think the system can do to their customers.
 */
export function systemFacts(health: Health): StatusFact[] {
  const { adapters } = health;
  const facts: StatusFact[] = [];

  // 1. The safety fact. "Off" is the reassuring answer here, so the tone is
  //    deliberately not `bad` — nothing is wrong, a lock is closed.
  const sending = bool(adapters, 'outboundSendEnabled');
  facts.push({
    label: 'Sending replies',
    value: sending ? 'On' : 'Off',
    detail: sending
      ? 'Approved replies are delivered to the recipient.'
      : 'Replies are written and held. Nothing reaches a customer until sending is turned on.',
    tone: sending ? 'neutral' : 'good',
  });

  // 2. Whether the door is locked.
  const auth = bool(adapters, 'authConfigured');
  facts.push({
    label: 'Sign-in',
    value: auth ? 'Required' : 'Not configured',
    detail: auth
      ? 'Every screen and every action requires a signed-in operator.'
      : 'No operator password is set, so the API is open. Not suitable for real data.',
    tone: auth ? 'good' : 'bad',
  });

  // 3. Where the email comes from. "Demo inbox" is the honest answer and also
  //    the one a client needs, because it explains why the same ten messages
  //    keep appearing.
  const source = text(adapters, 'emailSource');
  facts.push({
    label: 'Email source',
    value: source === 'demo' ? 'Demo inbox' : source === 'gmail' ? 'Gmail' : source || 'Not configured',
    detail:
      source === 'demo'
        ? 'A fixed set of sample messages, so the same walkthrough can be repeated.'
        : 'Messages are read from the connected mailbox.',
    tone: 'neutral',
  });

  // 4. Where the records go.
  const crm = text(adapters, 'crmTarget');
  facts.push({
    label: 'CRM',
    value: crm === 'local' ? 'Built in' : crm === 'hubspot' ? 'HubSpot' : crm || 'Not configured',
    detail:
      crm === 'local'
        ? 'Contacts, companies, deals and follow-ups are stored in this application.'
        : 'Records are written to the connected CRM.',
    tone: 'neutral',
  });

  // 5. The model. Saying "Demo mode" rather than "mock" is the difference
  //    between a status line and a piece of jargon — but it must still say that
  //    no live model is being called, because that is true and someone will ask.
  const provider = text(adapters, 'llmProvider');
  const configured = bool(adapters, 'llmConfigured');
  facts.push({
    label: 'Language model',
    value: provider === 'mock' ? 'Demo mode' : provider === 'anthropic' ? 'Claude' : provider || 'Not configured',
    detail:
      provider === 'mock'
        ? 'Running on recorded responses, so the walkthrough behaves identically every time.'
        : configured
          ? 'Live model calls, with every reply checked before it can be used.'
          : 'No API key is set, so the model cannot be called.',
    tone: 'neutral',
  });

  return facts;
}
