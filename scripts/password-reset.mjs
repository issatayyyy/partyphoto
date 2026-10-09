import { createHash, randomBytes } from "node:crypto";

// Operators issue links after independently verifying account ownership; the
// self-service flow delivers links only to the active account's stored email.
// Issuance does not change the password, role, or existing sessions.
export async function issuePasswordReset(db, email) {
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("Invalid account email");
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");

  return db.$transaction(async tx => {
    // Consumption takes the same user lock: replacing a link cannot race an
    // active reset into changing a password with an invalidated token.
    const [user] = await tx.$queryRaw`
      SELECT "id", "email", "disabledAt" FROM "User"
      WHERE "email" = ${normalized} FOR UPDATE
    `;
    if (!user || user.disabledAt) throw new Error("Account unavailable");
    const [{ now }] = await tx.$queryRaw`SELECT statement_timestamp() AS "now"`;
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000);
    await tx.passwordResetToken.upsert({
      where: { userId: user.id },
      create: { userId: user.id, tokenHash, expiresAt, createdAt: now },
      update: { tokenHash, expiresAt, createdAt: now },
    });
    return { token, expiresAt, email: user.email };
  });
}
