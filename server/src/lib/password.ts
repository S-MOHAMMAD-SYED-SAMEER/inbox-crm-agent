import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// Password hashing, on Node's own crypto.
//
// WHY scrypt AND NOT bcrypt OR argon2
//
// Both would be the fourth server dependency in a project that has three, and
// `crypto.scrypt` is a memory-hard KDF built into the runtime. For one operator
// password guarding a demo, the marginal security of argon2id over a
// well-parameterised scrypt is far smaller than the cost of taking on an
// authentication dependency — which is a supply-chain surface for the exact
// thing it protects.
//
// THE FORMAT IS SELF-DESCRIBING
//
//   scrypt$N$r$p$<salt-base64>$<hash-base64>
//
// Parameters travel with the hash, so raising the cost later does not
// invalidate existing hashes: an old hash still verifies with the parameters it
// was made with. A bare hex digest with the cost baked into the code is how you
// end up unable to change the cost.

const NAME = 'scrypt';

/**
 * N=2^15 with r=8, p=1 — roughly 32 MB and ~100 ms on this machine.
 *
 * Deliberately slow. A login is a once-a-session cost paid by a human, and the
 * same slowness is what makes an offline guess against a leaked hash expensive.
 */
const PARAMS = { N: 32_768, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

// scrypt's default maxmem (32 MB) is exactly at the limit for N=2^15, and Node
// throws rather than rounding. Asking for more removes a failure that would
// otherwise appear only on the first real login.
const MAX_MEM = 128 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, { ...PARAMS, maxmem: MAX_MEM });

  return [
    NAME,
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Checks a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash: a misconfigured
 * `OPERATOR_PASSWORD_HASH` must fail closed — nobody logs in — rather than
 * producing a 500 that distinguishes "bad configuration" from "wrong password"
 * to whoever is guessing.
 *
 * The comparison is `timingSafeEqual`, so the answer takes the same time
 * whether the first byte is wrong or only the last one is.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== NAME) return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] as string, 'base64');
    expected = Buffer.from(parts[5] as string, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(password, salt, expected.length, { N, r, p, maxmem: MAX_MEM });
  } catch {
    // Absurd parameters in a malformed hash would otherwise throw here.
    return false;
  }

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
