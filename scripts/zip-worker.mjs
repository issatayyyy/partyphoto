import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, ListMultipartUploadsCommand, AbortMultipartUploadCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import yazl from "yazl";

const leaseMs = 600000;
const heartbeatMs = 30000;
const maxAttempts = 3;
class ZipFailure extends Error { constructor(code) { super(code); this.code = code; } }
class LostLease extends Error {}

function settings(options) {
  const maxBytes = Number(options.maxBytes ?? process.env.MAX_ZIP_BYTES ?? 1073741824);
  const maxPhotos = Number(options.maxPhotos ?? process.env.MAX_ZIP_PHOTOS ?? 10000);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxPhotos) || maxPhotos < 1 || maxPhotos > 10000) throw new ZipFailure("ZIP_LIMIT_CONFIG_INVALID");
  return { maxBytes, maxPhotos, clock: () => options.now ? new Date(options.now) : new Date() };
}
function archivePrefix(job) { return `events/${job.eventId}/archives/${job.id}/`; }
function owns(job) { return { id: job.id, kind: "ZIP", status: "RUNNING", lockToken: job.lockToken }; }

// A crashed multipart upload is not an S3 object yet: abort its parts as well.
async function abortParts(s3, bucket, prefix, exact = false) {
  let KeyMarker;
  let UploadIdMarker;
  do {
    const page = await s3.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: prefix, KeyMarker, UploadIdMarker }));
    for (const upload of page.Uploads ?? []) {
      if (upload.Key && upload.UploadId && (exact ? upload.Key === prefix : upload.Key.startsWith(prefix))) {
        try { await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: upload.Key, UploadId: upload.UploadId })); }
        catch (error) { if (error.name !== "NoSuchUpload" && error.$metadata?.httpStatusCode !== 404) throw error; }
      }
    }
    if (!page.IsTruncated) break;
    KeyMarker = page.NextKeyMarker;
    UploadIdMarker = page.NextUploadIdMarker;
    if (!KeyMarker) throw new Error("Invalid multipart pagination");
  } while (true);
}
async function deleteArchiveKey(s3, bucket, key) {
  await abortParts(s3, bucket, key, true);
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
async function deleteJobArchives(s3, bucket, job) {
  const prefix = archivePrefix(job);
  await abortParts(s3, bucket, prefix);
  if (job.resultKey) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: job.resultKey }));
  let ContinuationToken;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken }));
    for (const object of page.Contents ?? []) if (object.Key?.startsWith(prefix)) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
    if (!page.IsTruncated) break;
    ContinuationToken = page.NextContinuationToken;
    if (!ContinuationToken) throw new Error("Invalid object pagination");
  } while (true);
}

export async function cleanupExpiredZipJobs(db, s3, bucket, options = {}) {
  const { clock } = settings(options);
  const now = clock();
  const eventId = options.eventId ?? null;
  const jobId = options.jobId ?? null;
  const candidates = await db.$queryRaw`
    SELECT j.* FROM "MediaJob" j JOIN "Event" e ON e."id" = j."eventId"
    WHERE j."kind" = 'ZIP'
    AND (${eventId}::text IS NULL OR j."eventId" = ${eventId})
    AND (${jobId}::text IS NULL OR j."id" = ${jobId})
    AND ((j."expiresAt" <= ${now} AND (j."lastError" IS DISTINCT FROM 'ZIP_EXPIRED_CLEANED' OR j."resultKey" IS NOT NULL))
      OR (j."status" = 'FAILED' AND j."resultKey" IS NOT NULL)
      OR (j."status" = 'DONE' AND j."resultKey" IS NOT NULL AND (
        e."deletedAt" IS NOT NULL OR e."expiresAt" <= ${now}
        OR j."payload"->>'mediaVersion' IS DISTINCT FROM e."mediaVersion"::text
        OR j."payload"->>'accessVersion' IS DISTINCT FROM e."accessVersion"::text)))
    ORDER BY j."updatedAt" ASC LIMIT 100
  `;
  let removed = 0;
  let failed = 0;
  for (const candidate of candidates) {
    try {
      const job = await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "MediaJob" WHERE "id" = ${candidate.id} FOR UPDATE`;
        const current = await tx.mediaJob.findUnique({ where: { id: candidate.id } });
        if (!current || current.kind !== "ZIP") return null;
        const expired = current.expiresAt && current.expiresAt <= now;
        const event = await tx.event.findUnique({ where: { id: current.eventId } });
        const stale = current.status === "DONE" && current.resultKey && (!event || event.deletedAt || (event.expiresAt && event.expiresAt <= now)
          || current.payload?.mediaVersion !== event.mediaVersion || current.payload?.accessVersion !== event.accessVersion);
        if (!expired && !stale && !(current.status === "FAILED" && current.resultKey)) return null;
        return tx.mediaJob.update({ where: { id: current.id }, data: { status: "FAILED", lockToken: null, lockedUntil: null, lastError: expired ? "ZIP_EXPIRED" : stale ? "STALE_SNAPSHOT" : current.lastError } });
      });
      if (!job) continue;
      await deleteJobArchives(s3, bucket, job);
      const expired = job.expiresAt && job.expiresAt <= now;
      const cleared = await db.mediaJob.updateMany({ where: { id: job.id, status: "FAILED", resultKey: job.resultKey, lockToken: null }, data: {
        resultKey: null, sizeBytes: 0n,
        lastError: expired ? "ZIP_EXPIRED_CLEANED" : job.lastError,
        ...(expired ? { payload: {} } : {}),
      } });
      removed += cleared.count;
    } catch { failed++; }
  }
  // Retain only a small expired-job tombstone briefly. Never discard a job
  // whose object or multipart cleanup has not been confirmed.
  await db.mediaJob.deleteMany({ where: {
    kind: "ZIP", status: "FAILED", lastError: "ZIP_EXPIRED_CLEANED", resultKey: null,
    expiresAt: { lt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) },
    ...(eventId ? { eventId } : {}), ...(jobId ? { id: jobId } : {}),
  } });
  return { removed, failed };
}

async function claimJob(db, options, clock) {
  const now = clock();
  const eventId = options.eventId ?? null;
  const jobId = options.jobId ?? null;
  return db.$transaction(async tx => {
    const [candidate] = await tx.$queryRaw`
      SELECT * FROM "MediaJob" WHERE "kind" = 'ZIP'
      AND (${eventId}::text IS NULL OR "eventId" = ${eventId})
      AND (${jobId}::text IS NULL OR "id" = ${jobId})
      AND ("expiresAt" IS NULL OR "expiresAt" > ${now})
      AND (("status" = 'QUEUED' AND "availableAt" <= ${now})
        OR ("status" = 'RUNNING' AND ("lockedUntil" IS NULL OR "lockedUntil" <= ${now})))
      ORDER BY "createdAt" ASC LIMIT 1 FOR UPDATE SKIP LOCKED
    `;
    if (!candidate) return null;
    const updated = await tx.mediaJob.update({ where: { id: candidate.id }, data: {
      status: "RUNNING", lockToken: randomUUID(), lockedUntil: new Date(now.getTime() + leaseMs),
      attempts: candidate.attempts < maxAttempts ? { increment: 1 } : undefined,
      processedPhotos: 0, lastError: null,
    } });
    return { ...updated, exhausted: candidate.attempts >= maxAttempts };
  });
}

function payloadFor(job, limits) {
  const payload = job.payload;
  if (!payload || !Number.isInteger(payload.mediaVersion) || !Number.isInteger(payload.accessVersion)
    || !Array.isArray(payload.photoIds) || !payload.photoIds.length || payload.photoIds.some(id => typeof id !== "string" || !id || id.length > 100)
    || new Set(payload.photoIds).size !== payload.photoIds.length) throw new ZipFailure("INVALID_SNAPSHOT");
  if (payload.photoIds.length > limits.maxPhotos) throw new ZipFailure("ZIP_LIMIT_EXCEEDED");
  return payload;
}
async function snapshot(tx, job, payload, limits, previous) {
  const now = limits.clock();
  const event = await tx.event.findUnique({ where: { id: job.eventId } });
  if (!event || event.deletedAt || (event.expiresAt && event.expiresAt <= now)
    || event.mediaVersion !== payload.mediaVersion || event.accessVersion !== payload.accessVersion
    || !job.expiresAt || job.expiresAt <= now) throw new ZipFailure("STALE_SNAPSHOT");
  const records = await tx.photo.findMany({ where: { eventId: event.id, id: { in: payload.photoIds }, status: "PUBLISHED" }, select: { id: true, originalKey: true, filename: true, sizeBytes: true, mimeType: true, createdAt: true } });
  if (records.length !== payload.photoIds.length) throw new ZipFailure("STALE_SNAPSHOT");
  const byId = new Map(records.map(photo => [photo.id, photo]));
  const photos = payload.photoIds.map(id => byId.get(id));
  const total = photos.reduce((sum, photo) => sum + photo.sizeBytes, 0n);
  if (total > BigInt(limits.maxBytes) || photos.some(photo => photo.sizeBytes < 1n || photo.sizeBytes > BigInt(Number.MAX_SAFE_INTEGER))) throw new ZipFailure("ZIP_LIMIT_EXCEEDED");
  if (previous && photos.some((photo, index) => photo.originalKey !== previous[index].originalKey || photo.sizeBytes !== previous[index].sizeBytes)) throw new ZipFailure("STALE_SNAPSHOT");
  return photos;
}

function safeName(filename, index, names) {
  let value = String(filename).toWellFormed().normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "_").replace(/\.{2,}/g, "_").replace(/^[. ]+|[. ]+$/g, "");
  if (!value) value = `photo-${index + 1}`;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value = `_${value}`;
  let truncated = "";
  for (const char of value) { if (Buffer.byteLength(truncated + char) > 200) break; truncated += char; }
  value = truncated;
  const dot = value.lastIndexOf(".");
  const base = dot > 0 ? value.slice(0, dot) : value;
  const extension = dot > 0 ? value.slice(dot) : "";
  let name = value;
  let duplicate = 1;
  while (names.has(name.toLowerCase())) name = `${base} (${++duplicate})${extension}`;
  names.add(name.toLowerCase());
  return name;
}

async function buildArchive(db, s3, bucket, job, photos, limits, externalSignal) {
  const Key = `${archivePrefix(job)}${job.lockToken}.zip`;
  const persisted = await db.mediaJob.updateMany({ where: owns(job), data: { resultKey: Key, totalPhotos: photos.length } });
  if (!persisted.count) throw new LostLease();
  job.resultKey = Key;
  const controller = new AbortController();
  const streams = new Set();
  const progressWrites = [];
  const archive = new yazl.ZipFile();
  let failure;
  let written = 0;
  let read = 0;
  let busyHeartbeat = false;
  const abort = error => { if (!failure) failure = error; controller.abort(); };
  const shutdown = () => abort(new Error("Worker stopped"));
  externalSignal?.addEventListener("abort", shutdown, { once: true });
  if (externalSignal?.aborted) shutdown();
  const heartbeat = setInterval(async () => {
    if (busyHeartbeat || controller.signal.aborted) return;
    busyHeartbeat = true;
    try {
      const now = limits.clock();
      const updated = await db.mediaJob.updateMany({ where: { ...owns(job), expiresAt: { gt: now } }, data: { lockedUntil: new Date(now.getTime() + leaseMs) } });
      if (!updated.count) abort(new LostLease());
    } catch (error) { abort(error); }
    finally { busyHeartbeat = false; }
  }, heartbeatMs);
  heartbeat.unref();
  const limiter = new Transform({ transform(chunk, _encoding, callback) {
    written += chunk.byteLength;
    if (written > limits.maxBytes + limits.maxPhotos * 1024 + 1024) callback(new ZipFailure("ZIP_LIMIT_EXCEEDED"));
    else callback(null, chunk);
  } });
  const upload = new Upload({ client: s3, params: { Bucket: bucket, Key, Body: limiter, ContentType: "application/zip" }, queueSize: 2, partSize: 5 * 1024 * 1024, leavePartsOnError: false });
  const cancel = () => { for (const stream of streams) stream.destroy(); archive.outputStream.destroy(); limiter.destroy(); upload.abort().catch(() => {}); };
  controller.signal.addEventListener("abort", cancel, { once: true });
  if (controller.signal.aborted) cancel();
  archive.on("error", abort);
  const pumping = pipeline(archive.outputStream, limiter, { signal: controller.signal });
  pumping.catch(() => {});
  const uploading = upload.done();
  uploading.catch(error => abort(error));
  const names = new Set();
  try {
    for (const [index, photo] of photos.entries()) {
      archive.addReadStreamLazy(safeName(photo.filename, index, names), { compress: false, size: Number(photo.sizeBytes), mtime: photo.createdAt, mode: 0o100644 }, callback => {
        (async () => {
          if (controller.signal.aborted) throw failure ?? new LostLease();
          const current = await db.mediaJob.count({ where: { ...owns(job), expiresAt: { gt: limits.clock() }, lockedUntil: { gt: limits.clock() } } });
          if (!current) throw new LostLease();
          const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: photo.originalKey }), { abortSignal: controller.signal });
          if (!object.Body || (object.ContentLength !== undefined && BigInt(object.ContentLength) !== photo.sizeBytes)) { object.Body?.destroy?.(); throw new ZipFailure("ZIP_SOURCE_CHANGED"); }
          const source = typeof object.Body.pipe === "function" ? object.Body : Readable.fromWeb(object.Body.transformToWebStream());
          const counted = new Transform({ transform(chunk, _encoding, done) {
            read += chunk.byteLength;
            done(read > limits.maxBytes ? new ZipFailure("ZIP_LIMIT_EXCEEDED") : null, chunk);
          } });
          streams.add(source); streams.add(counted);
          source.on("error", error => counted.destroy(error));
          counted.once("error", abort);
          counted.once("end", () => {
            streams.delete(source); streams.delete(counted);
            const progress = db.mediaJob.updateMany({ where: owns(job), data: { processedPhotos: { increment: 1 } } }).then(result => { if (!result.count) throw new LostLease(); });
            progressWrites.push(progress);
            progress.catch(abort);
          });
          source.pipe(counted);
          return counted;
        })().then(stream => callback(null, stream), error => { abort(error); callback(error); });
      });
    }
    archive.end({}, size => { if (size < 0 || size > limits.maxBytes + limits.maxPhotos * 1024 + 1024) abort(new ZipFailure("ZIP_LIMIT_EXCEEDED")); });
    await Promise.all([pumping, uploading]);
    await Promise.all(progressWrites);
    if (failure) throw failure;
    if (read !== photos.reduce((sum, photo) => sum + Number(photo.sizeBytes), 0)) throw new ZipFailure("ZIP_SOURCE_CHANGED");
    return { Key, sizeBytes: BigInt(written) };
  } catch (error) {
    abort(error);
    await Promise.allSettled([pumping, uploading]);
    await Promise.allSettled(progressWrites);
    throw failure ?? error;
  } finally {
    clearInterval(heartbeat);
    externalSignal?.removeEventListener("abort", shutdown);
    controller.signal.removeEventListener("abort", cancel);
  }
}

export async function processZipJob(db, s3, bucket, options = {}) {
  const limits = settings(options);
  const cleanup = await cleanupExpiredZipJobs(db, s3, bucket, options);
  if (options.signal?.aborted) return { processed: false, expired: cleanup.removed };
  const job = await claimJob(db, options, limits.clock);
  if (!job) return { processed: false, expired: cleanup.removed };
  let resultKey = job.resultKey;
  try {
    if (job.exhausted) throw new ZipFailure("ZIP_RETRY_EXHAUSTED");
    // Every reclaimed attempt has a unique key; remove the abandoned previous
    // attempt before replacing its persisted pointer.
    if (resultKey) { await deleteArchiveKey(s3, bucket, resultKey); resultKey = null; }
    const payload = payloadFor(job, limits);
    const photos = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${job.eventId} FOR UPDATE`;
      return snapshot(tx, job, payload, limits);
    });
    const archive = await buildArchive(db, s3, bucket, job, photos, limits, options.signal);
    resultKey = archive.Key;
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${job.eventId} FOR UPDATE`;
      await snapshot(tx, job, payload, limits, photos);
      const finalized = await tx.mediaJob.updateMany({ where: { ...owns(job), expiresAt: { gt: limits.clock() }, lockedUntil: { gt: limits.clock() } }, data: { status: "DONE", resultKey, sizeBytes: archive.sizeBytes, processedPhotos: photos.length, lockedUntil: null, lockToken: null, lastError: null } });
      if (!finalized.count) throw new LostLease();
    });
    return { processed: true, expired: cleanup.removed, jobId: job.id, status: "DONE" };
  } catch (error) {
    // buildArchive persists its output key before any S3 writes.
    resultKey = job.resultKey ?? resultKey;
    let deleted = false;
    if (resultKey) { try { await deleteArchiveKey(s3, bucket, resultKey); deleted = true; } catch { /* Retain pointer for the next cleanup pass. */ } }
    if (error instanceof LostLease) return { processed: true, expired: cleanup.removed, jobId: job.id, status: "LOST" };
    const retryable = !(error instanceof ZipFailure) && job.attempts < maxAttempts;
    const status = retryable ? "QUEUED" : "FAILED";
    await db.mediaJob.updateMany({ where: owns(job), data: {
      status, lockedUntil: null, lockToken: null,
      resultKey: deleted ? null : resultKey,
      availableAt: new Date(limits.clock().getTime() + Math.min(300000, 5000 * 2 ** Math.max(0, job.attempts - 1))),
      lastError: error instanceof ZipFailure ? error.code : retryable ? "ZIP_STORAGE_ERROR" : "ZIP_RETRY_EXHAUSTED",
      sizeBytes: 0n,
    } });
    return { processed: true, expired: cleanup.removed, jobId: job.id, status };
  }
}
