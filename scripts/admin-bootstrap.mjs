import { PrismaClient } from "@prisma/client";
import { bootstrapAdmin } from "./admin-bootstrap-helper.mjs";

const usage = "npm run admin:bootstrap -- --email owner@example.com";
let db;
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") console.log(usage);
  else {
    if (args.length !== 2 || args[0] !== "--email" || !args[1]) throw new Error("Explicit email required");
    db = new PrismaClient();
    const result = await bootstrapAdmin(db, args[1]);
    console.log(`Суперадминистратор: ${result.email}`);
    console.log(result.changed ? "Права назначены. Войдите заново." : "Права уже назначены.");
  }
} catch {
  console.error("Не удалось назначить суперадминистратора. Проверьте email активного аккаунта и доступ к БД.");
  process.exitCode = 1;
} finally {
  if (db) await db.$disconnect().catch(() => {});
}
