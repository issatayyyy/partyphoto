import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { db } from "@/lib/db";
import { storage, storageBucket } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const checks = await Promise.allSettled([
    db.$transaction(async tx => { await tx.$queryRaw`SELECT 1`; }, { maxWait: 2000, timeout: 3000 }),
    Promise.resolve().then(() => storage().send(new HeadBucketCommand({ Bucket: storageBucket() }), { abortSignal: AbortSignal.timeout(3000) })),
  ]);
  const ready = checks.every(check => check.status === "fulfilled");
  return Response.json({
    status: ready ? "ready" : "unavailable",
    database: checks[0].status === "fulfilled" ? "ok" : "unavailable",
    storage: checks[1].status === "fulfilled" ? "ok" : "unavailable",
  }, { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
