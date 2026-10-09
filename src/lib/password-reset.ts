import "server-only";
import { z } from "zod";
import { db } from "./db";
import { tokenHash } from "./auth";
import { AuthError } from "./auth-http";
import { consumeRateLimit } from "./auth-rate-limit";
import { hashPassword } from "./password";

const inputSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  password: z.string().min(8).max(128),
}).strict();
const invalidLink = () => new AuthError(400, "Ссылка недействительна или срок её действия истёк. Получите новую ссылку восстановления.");

export async function resetPassword(input: unknown) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new AuthError(400, "Укажите действительную ссылку и пароль от 8 до 128 символов.");
  const token = tokenHash(parsed.data.token);
  await consumeRateLimit("password-reset:global", 60, 60);
  await consumeRateLimit(`password-reset:token:${token}`, 10, 900);
  // Reject unknown tokens before performing expensive password hashing.
  const [candidate] = await db.$queryRaw<{ userId: string }[]>`
    SELECT reset."userId" FROM "PasswordResetToken" reset
    JOIN "User" account ON account."id" = reset."userId"
    WHERE reset."tokenHash" = ${token} AND reset."expiresAt" > statement_timestamp()
      AND account."disabledAt" IS NULL
  `;
  if (!candidate) throw invalidLink();
  const passwordHash = await hashPassword(parsed.data.password);
  await db.$transaction(async tx => {
    // Login and token issuance use the same user lock. An old-password login
    // cannot create a surviving session after this transaction revokes them.
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${candidate.userId} FOR UPDATE`;
    // Check the database clock again after acquiring the lock, including time
    // spent waiting for a concurrent login or reset.
    const [current] = await tx.$queryRaw<{ id: string; email: string }[]>`
      SELECT account."id", account."email" FROM "PasswordResetToken" reset
      JOIN "User" account ON account."id" = reset."userId"
      WHERE reset."userId" = ${candidate.userId} AND reset."tokenHash" = ${token}
        AND reset."expiresAt" > statement_timestamp() AND account."disabledAt" IS NULL
    `;
    if (!current) throw invalidLink();
    await tx.user.update({ where: { id: current.id }, data: { passwordHash } });
    await tx.session.deleteMany({ where: { userId: current.id } });
    await tx.passwordResetToken.deleteMany({ where: { userId: current.id } });
    // A user who forgot their password may have exhausted their login attempts.
    await tx.authRateLimit.deleteMany({ where: { key: `auth:login:${tokenHash(current.email)}` } });
  });
  return { ok: true };
}
