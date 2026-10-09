import { mkdir, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { issuePasswordReset } from "./password-reset.mjs";

const usage = "npm run admin:reset-password -- --email owner@example.com [--output-file .data/recovery/reset-link.txt]";

function argumentsFor(values) {
  if (values.length === 1 && values[0] === "--help") return { help: true };
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const option = values[index];
    const value = values[index + 1];
    if (!["--email", "--output-file"].includes(option) || !value || value.startsWith("--") || result[option]) throw new Error("Invalid arguments");
    result[option] = value;
  }
  if (!result["--email"]) throw new Error("Explicit email required");
  return { email: result["--email"], outputFile: result["--output-file"] };
}

function resetOrigin() {
  if (!process.env.APP_URL) throw new Error("Missing app URL");
  const url = new URL(process.env.APP_URL);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || (url.protocol === "http:" && !loopback)
    || (process.env.NODE_ENV === "production" && url.protocol !== "https:")) throw new Error("Invalid app URL");
  return url.origin;
}

let db;
let output;
let outputFile;
let written = false;
try {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) console.log(usage);
  else {
    const origin = resetOrigin();
    if (options.outputFile) {
      if (/[\u0000-\u001f\u007f]/.test(options.outputFile)) throw new Error("Invalid output path");
      outputFile = resolve(options.outputFile);
      await mkdir(dirname(outputFile), { recursive: true, mode: 0o700 });
      // Never follow a symlink or overwrite an existing recovery file.
      output = await open(outputFile, "wx", 0o600);
    }
    db = new PrismaClient();
    const reset = await issuePasswordReset(db, options.email);
    const link = `${origin}/reset-password#token=${reset.token}`;
    if (output) {
      await output.writeFile(`${link}\n`, "utf8");
      await output.sync();
      written = true;
      console.log(`Ссылка сохранена: ${outputFile}`);
      console.log(`Действует до: ${reset.expiresAt.toISOString()}`);
    } else {
      console.log(link);
      console.log(`Действует до: ${reset.expiresAt.toISOString()}`);
    }
  }
} catch {
  console.error("Не удалось создать ссылку восстановления. Проверьте email, APP_URL, путь файла и доступ к БД.");
  process.exitCode = 1;
} finally {
  if (output) {
    await output.close().catch(() => {});
    if (!written) await unlink(outputFile).catch(() => {});
  }
  if (db) await db.$disconnect().catch(() => {});
}
