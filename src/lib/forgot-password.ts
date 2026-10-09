import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { issuePasswordReset } from "../../scripts/password-reset.mjs";
import { AuthError } from "./auth-http";
import { db } from "./db";
import { getResetMailConfig, MailDeliveryError, sendPasswordResetEmail } from "./reset-email";

const inputSchema = z.object({ email: z.string().trim().toLowerCase().max(254).email() }).strict();
export const forgotPasswordMessage = "Если для этой почты есть активный аккаунт, мы отправим ссылку для смены пароля. Проверьте также папку «Спам».";

export function parseForgotPassword(input: unknown) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new AuthError(400, "Укажите корректный email.");
  return parsed.data;
}

export async function limitForgotPassword(email: string) {
  const subject = createHash("sha256").update(email).digest("hex");
  const limits = [
    ["forgot-password:global:minute", 20, 60],
    ["forgot-password:global:hour", 60, 3600],
    ["forgot-password:global:day", 200, 86400],
    [`forgot-password:email:${subject}:minute`, 1, 60],
    [`forgot-password:email:${subject}:hour`, 3, 3600],
  ] as const;
  await db.$transaction(async tx => {
    // Only this endpoint's expired counters are removed. Email addresses are
    // never stored in rate-limit keys, including for nonexistent accounts.
    await tx.$executeRaw`DELETE FROM "AuthRateLimit" WHERE "key" LIKE 'forgot-password:%' AND "resetAt" <= statement_timestamp()`;
    for (const [key, limit, seconds] of limits) {
      const [row] = await tx.$queryRaw<{ attempts: number; retryAfter: number }[]>`
        INSERT INTO "AuthRateLimit" ("key", "attempts", "resetAt")
        VALUES (${key}, 1, statement_timestamp() + ${seconds} * INTERVAL '1 second')
        ON CONFLICT ("key") DO UPDATE SET
          "attempts" = CASE WHEN "AuthRateLimit"."resetAt" <= statement_timestamp() THEN 1
            ELSE LEAST("AuthRateLimit"."attempts"::bigint + 1, 2147483647)::integer END,
          "resetAt" = CASE WHEN "AuthRateLimit"."resetAt" <= statement_timestamp()
            THEN statement_timestamp() + ${seconds} * INTERVAL '1 second'
            ELSE "AuthRateLimit"."resetAt" END
        RETURNING "attempts", GREATEST(1, CEIL(EXTRACT(EPOCH FROM "resetAt" - statement_timestamp())))::integer AS "retryAfter"
      `;
      if (row.attempts > limit) throw new AuthError(429, "Слишком много попыток. Попробуйте позже.", row.retryAfter);
    }
  });
}

// The configuration and trusted origin are captured before scheduling after().
// Neither lookup, token issuance nor provider latency affects the HTTP response.
export async function deliverForgotPassword(email: string, origin: string, config: ReturnType<typeof getResetMailConfig>) {
  let issuedHash: string | undefined;
  try {
    const account = await db.user.findUnique({ where: { email }, select: { id: true, disabledAt: true } });
    if (!account || account.disabledAt) return;
    const issued = await issuePasswordReset(db, email);
    issuedHash = createHash("sha256").update(issued.token).digest("hex");
    const url = new URL("/reset-password", origin);
    url.hash = `token=${issued.token}`;
    await sendPasswordResetEmail(config, { to: issued.email, resetUrl: url.href });
    console.info("Password reset email: accepted");
  } catch (error) {
    if (issuedHash) {
      try { await db.passwordResetToken.deleteMany({ where: { tokenHash: issuedHash } }); }
      catch { console.error("Password reset email: failed (internal)"); }
    }
    const category = error instanceof MailDeliveryError ? error.category : "internal";
    // Only fixed categories are logged; never a recipient, reset URL, token,
    // provider response, API key or raw exception.
    console.error(`Password reset email: failed (${category})`);
  }
}
