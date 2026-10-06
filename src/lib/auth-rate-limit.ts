import "server-only";
import { createHash } from "node:crypto";
import { db } from "./db";
import { AuthError } from "./auth-http";

export async function consumeRateLimit(key: string, limit: number, seconds: number) {
  const [row] = await db.$queryRaw<{ attempts: number; resetAt: Date }[]>`
    INSERT INTO "AuthRateLimit" ("key", "attempts", "resetAt")
    VALUES (${key}, 1, CURRENT_TIMESTAMP + ${seconds} * INTERVAL '1 second')
    ON CONFLICT ("key") DO UPDATE SET
      "attempts" = CASE WHEN "AuthRateLimit"."resetAt" <= CURRENT_TIMESTAMP THEN 1
        ELSE LEAST("AuthRateLimit"."attempts"::bigint + 1, 2147483647)::integer END,
      "resetAt" = CASE WHEN "AuthRateLimit"."resetAt" <= CURRENT_TIMESTAMP
        THEN CURRENT_TIMESTAMP + ${seconds} * INTERVAL '1 second'
        ELSE "AuthRateLimit"."resetAt" END
    RETURNING "attempts", "resetAt"
  `;
  if (row.attempts > limit) {
    const retry = Math.max(1, Math.ceil((row.resetAt.getTime() - Date.now()) / 1000));
    throw new AuthError(429, "Слишком много попыток. Попробуйте позже.", retry);
  }
}

export async function limitAuthAttempt(action: "login" | "register", email: string) {
  // A shared cap protects hashing across app instances. Account keys are hashed;
  // untrusted X-Forwarded-For is deliberately not used as an identity.
  await consumeRateLimit("auth:global", 120, 60);
  if (action === "register") await consumeRateLimit("auth:registration", 60, 3600);
  const subject = createHash("sha256").update(email).digest("hex");
  await consumeRateLimit(`auth:${action}:${subject}`, action === "login" ? 10 : 5, action === "login" ? 900 : 3600);
  // Bound retention without deleting currently active counters.
  await db.authRateLimit.deleteMany({ where: { resetAt: { lt: new Date(Date.now() - 86400000) } } });
}
