import { setTimeout } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import { S3Client } from "@aws-sdk/client-s3";
import { recoverMedia } from "./media-recovery.mjs";
import { processZipJob } from "./zip-worker.mjs";

const required = name => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
required("DATABASE_URL");
const bucket = required("S3_BUCKET");
const db = new PrismaClient();
const s3 = new S3Client({
  endpoint: required("S3_ENDPOINT"), region: required("S3_REGION"),
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials: { accessKeyId: required("S3_ACCESS_KEY_ID"), secretAccessKey: required("S3_SECRET_ACCESS_KEY") },
  requestHandler: { connectionTimeout: 5000, requestTimeout: 30000, socketTimeout: 30000, throwOnRequestTimeout: true },
});
const once = process.argv.includes("--once");
const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => shutdown.abort());

try {
  console.log("Media worker started (ZIP and cleanup)");
  let lastCleanup = 0;
  do {
    try {
      const zip = await processZipJob(db, s3, bucket, { signal: shutdown.signal });
      if (zip.processed || zip.expired || once) console.log(`ZIP: processed=${zip.processed}, status=${zip.status ?? "idle"}, expired=${zip.expired}`);
      if (once && zip.status === "FAILED") process.exitCode = 1;
      if (once || Date.now() - lastCleanup >= 30000) {
        const { removed, failed } = await recoverMedia(db, s3, bucket);
        lastCleanup = Date.now();
        if (removed || failed || once) console.log(`Media cleanup: removed=${removed}, retry=${failed}`);
        if (failed && once) process.exitCode = 1;
      }
    } catch {
      console.error("Media cleanup unavailable; retrying next cycle");
      if (once) process.exitCode = 1;
    }
    if (once || shutdown.signal.aborted) break;
    try { await setTimeout(2000, undefined, { signal: shutdown.signal }); }
    catch (error) { if (error.name !== "AbortError") throw error; }
  } while (!shutdown.signal.aborted);
} finally {
  await db.$disconnect();
  s3.destroy();
}
