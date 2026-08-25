import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTONOMY_LEVELS, type AutonomyLevel } from '../domain/policy.ts';
import {
  MOCK_BEHAVIOURS,
  OUTBOUND_PROVIDERS,
  outboundSendingPossible,
  type MockBehaviour,
  type OutboundProviderName,
} from '../domain/outbound.ts';

// Configuration, validated once at import time.
//
// Project 1's split is reused deliberately, because it is the part that is easy
// to get wrong: the *operator* sees exactly which variable is missing, in a
// startup warning; the *user* sees a message that names nothing. An error
// response that says "ANTHROPIC_API_KEY is not set" tells a stranger what you
// are running and where the gap is.
//
// One dependency dropped versus Project 1: no `dotenv`. Node 24 ships
// `process.loadEnvFile()`, which does the same job for a file this simple, so
// the runtime dependency count stays at two (NFR-9).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '../..');

try {
  process.loadEnvFile(path.join(SERVER_ROOT, '.env'));
} catch {
  // No .env file is the normal case for tests and for a fresh clone: every
  // value below has a working default, and the demo runs with no keys at all
  // (NFR-1). A missing file is therefore not worth a warning.
}

export const LLM_PROVIDERS = ['mock', 'anthropic', 'gemini'] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

export const EMAIL_SOURCES = ['demo', 'gmail'] as const;
export type EmailSourceName = (typeof EMAIL_SOURCES)[number];

export const CRM_TARGETS = ['local', 'hubspot'] as const;
export type CrmTargetName = (typeof CRM_TARGETS)[number];

export const DB_DRIVERS = ['sqlite', 'postgres'] as const;
export type DbDriverName = (typeof DB_DRIVERS)[number];

function readString(key: string, fallback: string): string {
  const raw = process.env[key];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

function readEnum<T extends string>(key: string, allowed: readonly T[], fallback: T, problems: string[]): T {
  const raw = readString(key, fallback).toLowerCase();
  if (!(allowed as readonly string[]).includes(raw)) {
    problems.push(`${key} is "${raw}"; expected one of: ${allowed.join(', ')}. Using "${fallback}".`);
    return fallback;
  }
  return raw as T;
}

function readBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim().toLowerCase() === 'true';
}

function readInt(key: string, fallback: number, problems: string[]): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    problems.push(`${key} must be a positive integer; received "${raw}". Using ${fallback}.`);
    return fallback;
  }
  return parsed;
}

export type AppConfig = {
  port: number;
  databaseUrl: string | null;
  dbDriver: DbDriverName;
  sqlitePath: string;
  llmProvider: LlmProviderName;
  anthropicApiKey: string | null;
  anthropicModel: string;
  geminiApiKey: string | null;
  emailSource: EmailSourceName;
  crmTarget: CrmTargetName;
  allowOutboundSend: boolean;
  /** Which delivery provider to use. `none` (default) can never send. */
  outboundProvider: OutboundProviderName;
  /** Mock-provider behaviour, for demonstrating failure handling without a real provider. */
  outboundMockBehaviour: MockBehaviour;
  /**
   * scrypt-derived operator password (M5-A). Null means authentication cannot
   * succeed — the safe default for a machine that was never configured.
   */
  operatorPasswordHash: string | null;
  sessionTtlHours: number;
  /** Exact origins allowed to make credentialed cross-origin requests. */
  corsAllowedOrigins: string[];
  /** Whether session cookies carry `Secure`. Derived, never a bare toggle. */
  cookieSecure: boolean;
  approvalSlaHours: number;
  autonomyLevel: AutonomyLevel;
  demoDataDir: string;
  migrationsDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
};

export type ConfigResult = {
  config: AppConfig;
  /** Operator-facing. Logged at startup, never sent in a response. */
  problems: string[];
  ok: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const previous = process.env;
  // `readString` and friends read `process.env` so that the normal path stays
  // trivial; tests hand in their own object rather than mutating the real one.
  process.env = env;
  const problems: string[] = [];

  try {
    const databaseUrl = readString('DATABASE_URL', '') || null;

    // Driver selection is derived, not configured. A Postgres URL means
    // Postgres; no URL means the local SQLite file. That is what lets
    // `npm run migrate && npm run seed` work on a fresh clone with no
    // database server, no Docker, and no account (D1), while deploying to
    // Neon is nothing but setting DATABASE_URL.
    let dbDriver: DbDriverName = 'sqlite';
    if (databaseUrl !== null) {
      if (/^postgres(ql)?:\/\//i.test(databaseUrl)) {
        dbDriver = 'postgres';
      } else {
        problems.push('DATABASE_URL is set but is not a postgres:// URL. Falling back to local SQLite.');
      }
    }

    const llmProvider = readEnum('LLM_PROVIDER', LLM_PROVIDERS, 'mock', problems);
    const anthropicApiKey = readString('ANTHROPIC_API_KEY', '') || null;
    const geminiApiKey = readString('GEMINI_API_KEY', '') || null;

    if (llmProvider === 'anthropic' && anthropicApiKey === null) {
      problems.push('LLM_PROVIDER is "anthropic" but ANTHROPIC_API_KEY is not set.');
    }
    if (llmProvider === 'gemini' && geminiApiKey === null) {
      problems.push('LLM_PROVIDER is "gemini" but GEMINI_API_KEY is not set.');
    }

    const emailSource = readEnum('EMAIL_SOURCE', EMAIL_SOURCES, 'demo', problems);
    if (emailSource === 'gmail') {
      problems.push('EMAIL_SOURCE is "gmail", which is not implemented yet. Falling back to "demo".');
    }
    const crmTarget = readEnum('CRM_TARGET', CRM_TARGETS, 'local', problems);
    if (crmTarget === 'hubspot') {
      problems.push('CRM_TARGET is "hubspot", which is not implemented yet. Falling back to "local".');
    }

    // Outbound delivery needs BOTH locks turned, and both live here in the
    // process environment. No request body reaches this function, and nothing
    // downstream reads a "send: true" from anywhere else.
    const allowOutboundSend = readBool('ALLOW_OUTBOUND_SEND', false);
    const outboundProvider = readEnum('OUTBOUND_PROVIDER', OUTBOUND_PROVIDERS, 'none', problems);
    const outboundMockBehaviour = readEnum('OUTBOUND_MOCK_BEHAVIOUR', MOCK_BEHAVIOURS, 'success', problems);

    if (allowOutboundSend && outboundProvider === 'none') {
      problems.push(
        'ALLOW_OUTBOUND_SEND is true but OUTBOUND_PROVIDER is "none", so no mail can be sent. ' +
          'Both are required.',
      );
    }
    if (allowOutboundSend && outboundProvider === 'gmail') {
      problems.push('OUTBOUND_PROVIDER is "gmail", which is not implemented yet. No mail can be sent.');
    }
    if (allowOutboundSend && outboundProvider === 'mock') {
      // Loud on purpose, every single boot. This is the one configuration in
      // which the system can put a message in front of a customer, and an
      // operator should never discover that from a support ticket.
      problems.push(
        `OUTBOUND SENDING IS ENABLED via the "${outboundProvider}" provider. ` +
          'Approved replies will be delivered. Human approval is still required for every one.',
      );
    }
    if (!allowOutboundSend && outboundProvider !== 'none') {
      problems.push(
        `OUTBOUND_PROVIDER is "${outboundProvider}" but ALLOW_OUTBOUND_SEND is false, so nothing will be sent.`,
      );
    }

    // --- authentication (M5-A) ---------------------------------------------
    //
    // No default and no fallback: an unset hash means nobody can log in, which
    // is the only safe answer for a machine nobody has configured. The
    // alternative — a built-in default password — is how demo credentials end
    // up in production.
    const operatorPasswordHash = readString('OPERATOR_PASSWORD_HASH', '').trim() || null;
    if (operatorPasswordHash === null) {
      problems.push(
        'OPERATOR_PASSWORD_HASH is not set, so nobody can sign in. ' +
          'Generate one with `npm run hash-password`.',
      );
    } else if (!operatorPasswordHash.startsWith('scrypt$')) {
      problems.push('OPERATOR_PASSWORD_HASH is not a scrypt hash produced by `npm run hash-password`.');
    }

    // `Secure` cookies are refused by browsers over plain HTTP, which would make
    // localhost development impossible — so it is derived from how the app is
    // reached rather than being a flag someone can leave off in production.
    // Default true; explicitly false only for local HTTP.
    // --- CORS (M5-B) --------------------------------------------------------
    //
    // Empty by default, which means same-origin only — the correct posture for
    // an API that serves its own front end. A wildcard is refused outright
    // rather than silently downgraded: `*` cannot carry credentials, so anyone
    // who wrote it wanted something this application must not do.
    const corsAllowedOrigins = readString('CORS_ALLOWED_ORIGINS', '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);

    if (corsAllowedOrigins.includes('*')) {
      problems.push(
        'CORS_ALLOWED_ORIGINS contains "*", which cannot be combined with credentialed requests. ' +
          'It has been ignored — list exact origins instead.',
      );
    }
    for (const origin of corsAllowedOrigins) {
      if (origin !== '*' && !/^https?:\/\/[^/]+$/.test(origin)) {
        problems.push(`CORS_ALLOWED_ORIGINS entry "${origin}" is not a scheme://host origin and has been ignored.`);
      }
    }

    const cookieSecure = readBool('COOKIE_SECURE', true);
    if (!cookieSecure) {
      problems.push('COOKIE_SECURE is false, so session cookies will be sent over plain HTTP. Local development only.');
    }

    const config: AppConfig = {
      port: readInt('PORT', 3100, problems),
      databaseUrl: dbDriver === 'postgres' ? databaseUrl : null,
      dbDriver,
      sqlitePath: readString('SQLITE_PATH', path.join(SERVER_ROOT, 'data', 'inbox-crm.sqlite')),
      llmProvider,
      anthropicApiKey,
      anthropicModel: readString('ANTHROPIC_MODEL', 'claude-haiku-4-5-20251001'),
      geminiApiKey,
      emailSource: emailSource === 'gmail' ? 'demo' : emailSource,
      crmTarget: crmTarget === 'hubspot' ? 'local' : crmTarget,
      allowOutboundSend,
      outboundProvider,
      outboundMockBehaviour,
      operatorPasswordHash,
      sessionTtlHours: readInt('SESSION_TTL_HOURS', 12, problems),
      corsAllowedOrigins: corsAllowedOrigins.filter(
        (origin) => origin !== '*' && /^https?:\/\/[^/]+$/.test(origin),
      ),
      cookieSecure,
      approvalSlaHours: readInt('APPROVAL_SLA_HOURS', 24, problems),
      autonomyLevel: readEnum('AUTONOMY_LEVEL', AUTONOMY_LEVELS, 'manual', problems),
      demoDataDir: readString('DEMO_DATA_DIR', path.join(SERVER_ROOT, 'data', 'demo')),
      migrationsDir: readString('MIGRATIONS_DIR', path.join(SERVER_ROOT, 'migrations')),
      logLevel: readEnum('LOG_LEVEL', ['debug', 'info', 'warn', 'error'] as const, 'info', problems),
    };

    return { config, problems, ok: problems.length === 0 };
  } finally {
    process.env = previous;
  }
}

const loaded = loadConfig();

export const config: AppConfig = loaded.config;
export const configProblems: readonly string[] = loaded.problems;
export const isConfigured = loaded.ok;

/**
 * What `/api/health` and the Settings screen are allowed to know: whether each
 * dependency is configured, never *how* (FR-46). No key, no fragment of a key,
 * no connection string, not even a length.
 */
export function configSummary(cfg: AppConfig = config): Record<string, string | boolean | number> {
  return {
    llmProvider: cfg.llmProvider,
    llmConfigured:
      cfg.llmProvider === 'mock' ||
      (cfg.llmProvider === 'anthropic' && cfg.anthropicApiKey !== null) ||
      (cfg.llmProvider === 'gemini' && cfg.geminiApiKey !== null),
    emailSource: cfg.emailSource,
    crmTarget: cfg.crmTarget,
    database: cfg.dbDriver,
    // The real capability, not the raw flag: both locks must be turned, and
    // `gmail` is a declared name with no implementation behind it.
    outboundSendEnabled: outboundSendingPossible(cfg.allowOutboundSend, cfg.outboundProvider),
    // Whether sign-in is possible — never the hash, and never its length.
    authConfigured: cfg.operatorPasswordHash !== null,
    cookieSecure: cfg.cookieSecure,
    /** How many origins are allowed — never which, that is operator detail. */
    corsAllowedOrigins: cfg.corsAllowedOrigins.length,
    autonomyLevel: cfg.autonomyLevel,
  };
}
