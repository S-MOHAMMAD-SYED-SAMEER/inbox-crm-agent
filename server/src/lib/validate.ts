import { ValidationError } from './errors.ts';

// Hand-written validation, no schema library.
//
// Project 1 made this call for its eval dataset and the reasoning holds here:
// for shapes this small and this stable, a validation library is a dependency,
// a bundle, and a DSL to learn, in exchange for something forty lines of
// TypeScript already do — while a hand-written validator can produce error
// messages written for the person reading them.
//
// The collector pattern (accumulate every problem, then throw once) is the part
// that matters. A validator that throws on the first problem makes fixing a
// malformed request an N-round-trip conversation.

export class ProblemCollector {
  private readonly problems: string[] = [];

  add(problem: string): void {
    this.problems.push(problem);
  }

  get count(): number {
    return this.problems.length;
  }

  list(): readonly string[] {
    return [...this.problems];
  }

  throwIfAny(message?: string): void {
    if (this.problems.length > 0) {
      throw message ? new ValidationError(this.problems, message) : new ValidationError(this.problems);
    }
  }
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function requireObject(value: unknown, field: string, problems: ProblemCollector): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    problems.add(`"${field}" must be an object (received ${typeOf(value)})`);
    return {};
  }
  return value as Record<string, unknown>;
}

export function requireString(
  value: unknown,
  field: string,
  problems: ProblemCollector,
  options: { maxLength?: number; allowEmpty?: boolean } = {},
): string {
  if (typeof value !== 'string') {
    problems.add(`"${field}" is required and must be a string (received ${typeOf(value)})`);
    return '';
  }
  if (!options.allowEmpty && value.trim() === '') {
    problems.add(`"${field}" must not be empty`);
    return '';
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    problems.add(`"${field}" must be at most ${options.maxLength} characters (received ${value.length})`);
  }
  return value;
}

export function optionalString(
  value: unknown,
  field: string,
  problems: ProblemCollector,
  options: { maxLength?: number } = {},
): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    problems.add(`"${field}" must be a string when present (received ${typeOf(value)})`);
    return null;
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    problems.add(`"${field}" must be at most ${options.maxLength} characters (received ${value.length})`);
  }
  return value;
}

export function requireOneOf<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  problems: ProblemCollector,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    problems.add(`"${field}" must be one of: ${allowed.join(', ')} (received ${JSON.stringify(value)})`);
    return allowed[0] as T;
  }
  return value as T;
}

export function optionalOneOf<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  problems: ProblemCollector,
): T | null {
  if (value === undefined || value === null || value === '') return null;
  return requireOneOf(value, field, allowed, problems);
}

// Deliberately permissive: one @, a dot in the domain, no whitespace. Stricter
// email regexes reject addresses that genuinely exist and genuinely send mail,
// and this validator's job is to catch "not an address at all", not to
// adjudicate RFC 5322.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function requireEmail(value: unknown, field: string, problems: ProblemCollector): string {
  const raw = requireString(value, field, problems);
  if (raw !== '' && !EMAIL_RE.test(raw.trim())) {
    problems.add(`"${field}" must be a valid email address`);
    return '';
  }
  return raw.trim().toLowerCase();
}

export function requireIsoTimestamp(value: unknown, field: string, problems: ProblemCollector): string {
  const raw = requireString(value, field, problems);
  if (raw === '') return '';
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    problems.add(`"${field}" must be an ISO-8601 timestamp`);
    return '';
  }
  return new Date(parsed).toISOString();
}

export function requireNumberInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
  problems: ProblemCollector,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.add(`"${field}" must be a finite number (received ${typeOf(value)})`);
    return min;
  }
  if (value < min || value > max) {
    problems.add(`"${field}" must be between ${min} and ${max} (received ${value})`);
    return min;
  }
  return value;
}

export function optionalInteger(
  value: unknown,
  field: string,
  problems: ProblemCollector,
  options: { min?: number; max?: number } = {},
): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    problems.add(`"${field}" must be an integer when present (received ${typeOf(value)})`);
    return null;
  }
  if (options.min !== undefined && value < options.min) {
    problems.add(`"${field}" must be at least ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    problems.add(`"${field}" must be at most ${options.max}`);
  }
  return value;
}
