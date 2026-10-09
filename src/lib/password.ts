import "server-only";
import * as argon2 from "argon2";
import { AuthError } from "./auth-http";
import { passwordConcurrencyLimit } from "./runtime-limits";

let active = 0;
// Bound Argon2 memory use per app process instead of building an unbounded queue.
async function withPasswordSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (active >= passwordConcurrencyLimit()) throw new AuthError(429, "Слишком много попыток. Подождите немного.", 5);
  active++;
  try { return await operation(); } finally { active--; }
}

const options = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
let dummyHash: Promise<string> | undefined;

export function hashPassword(password: string) {
  return withPasswordSlot(() => argon2.hash(password, options));
}

export function verifyPassword(password: string, encodedHash: string | null) {
  return withPasswordSlot(async () => {
    const hash = encodedHash ?? await (dummyHash ??= argon2.hash("Dummy credential; never used as a login", options).catch(error => {
      dummyHash = undefined;
      throw error;
    }));
    return (await argon2.verify(hash, password)) && encodedHash !== null;
  });
}
