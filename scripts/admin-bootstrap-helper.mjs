export async function bootstrapAdmin(db, inputEmail) {
  if (typeof inputEmail !== "string") throw new Error("Explicit email required");
  const email = inputEmail.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Invalid email");
  return db.$transaction(async tx => {
    // Share the admin-set lock with web role/block changes.
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(726873, 1)`;
    const [account] = await tx.$queryRaw`
      SELECT "id", "email", "role", "disabledAt" FROM "User" WHERE "email" = ${email} FOR UPDATE
    `;
    if (!account || account.disabledAt) throw new Error("Active account required");
    const changed = account.role !== "ADMIN";
    if (changed) {
      await tx.user.update({ where: { id: account.id }, data: { role: "ADMIN" } });
      await tx.session.deleteMany({ where: { userId: account.id } });
      await tx.passwordResetToken.deleteMany({ where: { userId: account.id } });
    }
    return { email: account.email, role: "ADMIN", changed };
  });
}
