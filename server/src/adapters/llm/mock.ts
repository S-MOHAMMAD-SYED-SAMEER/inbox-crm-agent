import { stableHash } from '../../lib/ids.ts';
import type { LlmProvider, LlmRequest, LlmResponse } from './types.ts';

// The mock provider — the default (D3), and the reason the whole demo runs for
// ₹0 with no API key (NFR-1, NFR-2).
//
// DETERMINISM IS THE POINT, and it is enforced by three specific choices:
//
//   1. `latencyMs` is always 0. Real elapsed time is the most common way a
//      "deterministic" fixture quietly stops being deterministic — two runs
//      differ, a snapshot test flickers, and someone spends an afternoon on it.
//   2. Responses are deep-cloned on the way out. A caller that mutates what it
//      receives cannot poison the next lookup.
//   3. An unregistered request THROWS. It does not invent a plausible answer,
//      and it does not return an empty object. A mock that quietly fabricates
//      output would let a broken pipeline pass its own tests, which is worse
//      than no mock at all.
//
// Lookup order: an explicit `metadata.fixtureId` first (how the demo dataset
// binds a canned response to an email), then a stable hash of the request (how
// a test pins one without inventing an id).

export class MockResponseNotFoundError extends Error {
  readonly requestHash: string;
  readonly fixtureId: string | undefined;

  constructor(request: LlmRequest, requestHash: string) {
    const fixtureId = request.metadata?.fixtureId;
    super(
      `The mock LLM provider has no response registered for purpose "${request.purpose}" ` +
        `(fixtureId: ${fixtureId ?? 'none'}, requestHash: ${requestHash.slice(0, 12)}). ` +
        'Register one before running this path — the mock never invents output.',
    );
    this.name = 'MockResponseNotFoundError';
    this.requestHash = requestHash;
    this.fixtureId = fixtureId;
  }
}

export type MockResponse = {
  toolInput: Record<string, unknown>;
  model?: string;
  stopReason?: string;
};

export type MockCall = {
  purpose: string;
  promptVersion: string;
  fixtureId: string | undefined;
  requestHash: string;
  toolName: string;
};

export type MockLlmProvider = LlmProvider & {
  /** Binds a response to a fixture id (used by the demo dataset). */
  register(fixtureId: string, response: MockResponse): void;
  /** Binds a response to this exact request (used by tests). */
  registerForRequest(request: LlmRequest, response: MockResponse): void;
  /** Every call made, in order — lets a test assert what the pipeline asked for. */
  readonly calls: readonly MockCall[];
  reset(): void;
};

/**
 * Hashes the parts of a request that determine the answer. `metadata` is
 * excluded on purpose: it carries routing hints, not content, so adding a
 * fixture id must not change which hash a request has.
 */
export function hashRequest(request: LlmRequest): string {
  return stableHash({
    purpose: request.purpose,
    promptVersion: request.promptVersion,
    systemPrompt: request.systemPrompt,
    messages: request.messages,
    toolName: request.tool.name,
  });
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

export function createMockLlmProvider(
  initial: Record<string, MockResponse> = {},
): MockLlmProvider {
  const byFixture = new Map<string, MockResponse>(Object.entries(initial));
  const byHash = new Map<string, MockResponse>();
  const calls: MockCall[] = [];

  return {
    name: 'mock',
    configured: true,

    register(fixtureId: string, response: MockResponse): void {
      byFixture.set(fixtureId, deepClone(response));
    },

    registerForRequest(request: LlmRequest, response: MockResponse): void {
      byHash.set(hashRequest(request), deepClone(response));
    },

    get calls(): readonly MockCall[] {
      return calls;
    },

    reset(): void {
      byFixture.clear();
      byHash.clear();
      calls.length = 0;
    },

    async complete(request: LlmRequest): Promise<LlmResponse> {
      const requestHash = hashRequest(request);
      const fixtureId = request.metadata?.fixtureId;

      calls.push({
        purpose: request.purpose,
        promptVersion: request.promptVersion,
        fixtureId,
        requestHash,
        toolName: request.tool.name,
      });

      const found = (fixtureId !== undefined ? byFixture.get(fixtureId) : undefined) ?? byHash.get(requestHash);
      if (!found) throw new MockResponseNotFoundError(request, requestHash);

      return {
        toolInput: deepClone(found.toolInput),
        model: found.model ?? 'mock',
        latencyMs: 0,
        stopReason: found.stopReason ?? 'tool_use',
      };
    },
  };
}
