import { createInterface } from 'node:readline/promises';
import { hashPassword } from '../src/lib/password.ts';

// `npm run hash-password`
//
// Produces the value for OPERATOR_PASSWORD_HASH.
//
// The password is read from stdin rather than taken as an argument, because an
// argument lands in shell history and in the process list where any other user
// on the machine can read it. It is never echoed and never written anywhere by
// this script — the only output is the hash.

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const password = (await rl.question('Operator password (not echoed to any file): ')).trim();
  rl.close();

  if (password.length < 12) {
    console.error('\nToo short. Use at least 12 characters — this is the only credential guarding the system.');
    process.exitCode = 1;
    return;
  }

  const hash = await hashPassword(password);

  console.log('\nAdd this to your .env (the hash is safe to store; the password is not):\n');
  console.log(`OPERATOR_PASSWORD_HASH=${hash}\n`);
}

main().catch((err: unknown) => {
  console.error('[hash-password] failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
