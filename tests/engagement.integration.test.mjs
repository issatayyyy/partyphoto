import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand, HeadObjectCommand, ListMultipartUploadsCommand } from "@aws-sdk/client-s3";
import argon2 from "argon2";
import sharp from "sharp";
import yauzl from "yauzl";
import { processZipJob, cleanupExpiredZipJobs } from "../scripts/zip-worker.mjs";

const base = new URL(process.env.AUTH_TEST_URL ?? process.env.APP_URL);
const endpoint = new URL(process.env.S3_ENDPOINT);
for (const url of [base, endpoint]) {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.protocol !== "http:") {
    throw new Error("Engagement integration tests require local application and S3 endpoints");
  }
}
const db = new PrismaClient();
const s3 = new S3Client({
  endpoint: endpoint.href, region: process.env.S3_REGION, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
  requestHandler: { connectionTimeout: 5000, requestTimeout: 30000, throwOnRequestTimeout: true },
});
const bucket = process.env.S3_BUCKET;
const namespace = `engagement-${randomUUID()}`;
const hash = value => createHash("sha256").update(value).digest("hex");
const eventIds = [];
const userIds = [];
const ownKeys = new Set();
const visitors = [];
const cookieFrom = response => response.headers.getSetCookie().find(cookie => cookie.startsWith("partyphoto_visitor="))?.split(";")[0];

async function request(path, { method = "GET", data, cookie, origin = base.origin } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    if (origin !== null) headers.origin = origin;
  }
  return fetch(new URL(path, base), { method, headers, body: data === undefined ? undefined : JSON.stringify(data), redirect: "manual" });
}

async function newVisitor(event) {
  const response = await request(`/api/albums/${event.slug}/photos`);
  assert.equal(response.status, 200);
  const cookie = cookieFrom(response);
  assert.match(cookie, /^partyphoto_visitor=[a-f0-9]{64}$/);
  const header = response.headers.getSetCookie().find(value => value.startsWith("partyphoto_visitor="));
  assert.match(header, /HttpOnly/i);
  assert.match(header, /SameSite=lax/i);
  assert.match(header, /Max-Age=31536000/i);
  visitors.push(cookie);
  return cookie;
}

async function seedEvent(ownerId, name, extra = {}) {
  const event = await db.event.create({ data: {
    ownerId, title: `Engagement ${name}`, slug: `${namespace}-${name}`, code: randomBytes(4).toString("hex").toUpperCase(), ...extra,
  } });
  eventIds.push(event.id);
  return event;
}

async function seedPhoto(event, bytes, name, status = "PUBLISHED") {
  const id = randomUUID();
  const metadata = await sharp(bytes).metadata();
  const mime = metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}`;
  const originalKey = `events/${event.id}/photos/${id}/original.${metadata.format}`;
  const thumbnailKey = `events/${event.id}/photos/${id}/thumbnail.webp`;
  ownKeys.add(originalKey); ownKeys.add(thumbnailKey);
  const thumbnail = await sharp(bytes).resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: originalKey, Body: bytes, ContentType: mime }));
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: thumbnailKey, Body: thumbnail, ContentType: "image/webp" }));
  const photo = await db.photo.create({ data: {
    id, eventId: event.id, originalKey, thumbnailKey, filename: name, status, mimeType: mime,
    sizeBytes: BigInt(bytes.length), thumbnailBytes: BigInt(thumbnail.length), width: metadata.width, height: metadata.height,
  } });
  await db.event.update({ where: { id: event.id }, data: { usedStorageBytes: { increment: BigInt(bytes.length + thumbnail.length) } } });
  return photo;
}

async function readZip(buffer) {
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, value) => error ? reject(error) : resolve(value)));
  const entries = [];
  await new Promise((resolve, reject) => {
    zip.on("error", reject);
    zip.on("end", resolve);
    zip.on("entry", entry => {
      zip.openReadStream(entry, (error, stream) => {
        if (error) return reject(error);
        const chunks = [];
        stream.on("data", chunk => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => { entries.push({ name: entry.fileName, bytes: Buffer.concat(chunks) }); zip.readEntry(); });
      });
    });
    zip.readEntry();
  });
  return entries;
}

async function completeJob(event, job) {
  await processZipJob(db, s3, bucket, { eventId: event.id, jobId: job.id });
  const stored = await db.mediaJob.findUniqueOrThrow({ where: { id: job.id } });
  if (stored.resultKey) ownKeys.add(stored.resultKey);
  assert.equal(stored.status, "DONE", stored.lastError ?? "ZIP worker did not finish");
  return stored;
}

async function assertArchiveMissing(key) {
  try { await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); assert.fail("Invalid archive still exists in storage"); }
  catch (error) { if (error.code === "ERR_ASSERTION") throw error; assert.equal(error.$metadata?.httpStatusCode, 404); }
}

test("idempotent photo likes and private ZIP archives over HTTP, PostgreSQL and S3", async t => {
  let main;
  let ownerCookie;
  let foreignCookie;
  let first;
  let second;
  let pending;
  let hidden;
  let guest;
  let done;
  try {
    const passwordHash = await argon2.hash("12345678", { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    for (const name of ["owner", "foreign"]) {
      const token = randomBytes(32).toString("hex");
      const user = await db.user.create({ data: {
        email: `${namespace}-${name}@example.invalid`, name: `Engagement ${name}`, passwordHash,
        sessions: { create: { tokenHash: hash(token), expiresAt: new Date(Date.now() + 3600000) } },
      } });
      userIds.push(user.id);
      if (name === "owner") ownerCookie = `partyphoto_session=${token}`;
      else foreignCookie = `partyphoto_session=${token}`;
    }
    main = await seedEvent(userIds[0], "public", { allowGuestUploads: true, moderateUploads: true });
    const jpegA = await sharp({ create: { width: 100, height: 80, channels: 3, background: "#e76040" } }).jpeg().toBuffer();
    const jpegB = await sharp({ create: { width: 100, height: 80, channels: 3, background: "#496add" } }).jpeg().toBuffer();
    first = await seedPhoto(main, jpegA, "воспоминания.jpg");
    second = await seedPhoto(main, jpegB, "воспоминания.jpg");
    pending = await seedPhoto(main, jpegA, "pending.jpg", "PENDING");
    hidden = await seedPhoto(main, jpegA, "hidden.jpg", "HIDDEN");

    await t.test("guest identity is established by gallery loading; like mutation validates origin and input", async () => {
      assert.equal((await request(`/api/photos/${first.id}/like`, { method: "PUT", data: { liked: true } })).status, 409);
      guest = await newVisitor(main);
      for (const origin of [null, "null", "https://foreign.example"]) {
        assert.equal((await request(`/api/photos/${first.id}/like`, { method: "PUT", cookie: guest, data: { liked: true }, origin })).status, 403);
      }
      assert.equal((await request(`/api/photos/${first.id}/like`, { method: "PUT", cookie: guest, data: { liked: "yes" } })).status, 400);
      for (const photo of [pending, hidden]) {
        assert.equal((await request(`/api/photos/${photo.id}/like`, { method: "PUT", cookie: guest, data: { liked: true } })).status, 404);
        assert.equal((await request(`/api/photos/${photo.id}/like`, { method: "PUT", cookie: ownerCookie, data: { liked: true } })).status, 404);
      }
    });

    await t.test("repeated and concurrent guest likes count once and unlike is idempotent", async () => {
      const before = await db.event.findUniqueOrThrow({ where: { id: main.id } });
      const responses = await Promise.all([1, 2, 3].map(() => request(`/api/photos/${first.id}/like`, { method: "PUT", cookie: guest, data: { liked: true } })));
      for (const response of responses) { assert.equal(response.status, 200); assert.deepEqual(await response.json(), { liked: true, likeCount: 1 }); }
      const list = await request(`/api/albums/${main.slug}/photos`, { cookie: guest });
      assert.equal(cookieFrom(list), undefined);
      const liked = (await list.json()).photos.find(photo => photo.id === first.id);
      assert.equal(liked.liked, true); assert.equal(liked.likeCount, 1);
      assert.equal((await db.event.findUniqueOrThrow({ where: { id: main.id } })).mediaVersion, before.mediaVersion);
      for (let attempt = 0; attempt < 2; attempt++) {
        const unliked = await request(`/api/photos/${first.id}/like`, { method: "PUT", cookie: guest, data: { liked: false } });
        assert.equal(unliked.status, 200); assert.deepEqual(await unliked.json(), { liked: false, likeCount: 0 });
      }
    });

    await t.test("independent visitors count separately while an account remains stable across sessions", async () => {
      const visitor2 = await newVisitor(main);
      assert.notEqual(visitor2, guest);
      for (const cookie of [guest, visitor2]) {
        const response = await request(`/api/photos/${first.id}/like`, { method: "PUT", cookie, data: { liked: true } });
        assert.equal(response.status, 200);
      }
      const logged = await request(`/api/photos/${first.id}/like`, { method: "PUT", cookie: ownerCookie, data: { liked: true } });
      assert.deepEqual(await logged.json(), { liked: true, likeCount: 3 });
      const anotherToken = randomBytes(32).toString("hex");
      await db.session.create({ data: { userId: userIds[0], tokenHash: hash(anotherToken), expiresAt: new Date(Date.now() + 3600000) } });
      const repeated = await request(`/api/photos/${first.id}/like`, { method: "PUT", cookie: `partyphoto_session=${anotherToken}`, data: { liked: true } });
      assert.deepEqual(await repeated.json(), { liked: true, likeCount: 3 });
      const foreign = await request(`/api/events/${main.id}/photos`, { cookie: foreignCookie });
      assert.equal(foreign.status, 404);
    });

    await t.test("concurrent staff/guest ZIP requests deduplicate one published-photo snapshot", async () => {
      const none = await request(`/api/events/${main.id}/zip`, { cookie: ownerCookie });
      assert.equal(none.status, 200); assert.equal((await none.json()).job, null);
      assert.equal((await request(`/api/events/${main.id}/zip`)).status, 401);
      assert.equal((await request(`/api/events/${main.id}/zip`, { cookie: foreignCookie })).status, 404);
      assert.equal((await request(`/api/albums/${main.slug}/zip`, { method: "POST", cookie: guest, data: {}, origin: "https://foreign.example" })).status, 403);
      const responses = await Promise.all([
        request(`/api/events/${main.id}/zip`, { method: "POST", cookie: ownerCookie, data: {} }),
        request(`/api/albums/${main.slug}/zip`, { method: "POST", cookie: guest, data: {} }),
      ]);
      assert.deepEqual(responses.map(response => response.status), [202, 202]);
      const jobs = await Promise.all(responses.map(response => response.json()));
      assert.equal(jobs[0].job.id, jobs[1].job.id);
      assert.equal(jobs[0].job.totalPhotos, 2);
      assert.equal(await db.mediaJob.count({ where: { eventId: main.id, kind: "ZIP" } }), 1);
      done = await completeJob(main, jobs[0].job);
      const current = await request(`/api/albums/${main.slug}/zip`, { cookie: guest });
      const dto = (await current.json()).job;
      assert.equal(dto.status, "DONE"); assert.equal(dto.processedPhotos, 2); assert.equal(dto.totalPhotos, 2);
      assert.equal(dto.downloadUrl, `/api/zip/${done.id}/download`);
      assert.equal(JSON.stringify(dto).includes("resultKey"), false);
      const archive = await request(dto.downloadUrl, { cookie: guest });
      assert.equal(archive.status, 200);
      assert.match(archive.headers.get("content-type"), /(?:application\/zip|application\/octet-stream)/);
      assert.match(archive.headers.get("content-disposition"), /attachment/);
      const entries = await readZip(Buffer.from(await archive.arrayBuffer()));
      assert.equal(entries.length, 2);
      assert.equal(new Set(entries.map(entry => entry.name)).size, 2);
      assert.ok(entries.every(entry => !entry.name.includes("/") && !entry.name.includes("\\") && !entry.name.includes("..")));
      assert.deepEqual(entries.map(entry => hash(entry.bytes)).sort(), [hash(jpegA), hash(jpegB)].sort());
      const cached = await request(`/api/events/${main.id}/zip`, { method: "POST", cookie: ownerCookie, data: {} });
      assert.equal(cached.status, 200); assert.equal((await cached.json()).job.id, done.id);
    });

    await t.test("an unpublished guest upload leaves the cached published ZIP valid", async () => {
      const before = await db.event.findUniqueOrThrow({ where: { id: main.id } });
      const form = new FormData();
      form.append("file", new Blob([jpegB], { type: "image/jpeg" }), "pending-new-upload.jpg");
      const uploaded = await fetch(new URL(`/api/albums/${main.slug}/photos`, base), { method: "POST", headers: { origin: base.origin, cookie: guest }, body: form });
      assert.equal(uploaded.status, 201, await uploaded.clone().text());
      assert.equal((await uploaded.json()).photo.status, "PENDING");
      assert.equal((await db.event.findUniqueOrThrow({ where: { id: main.id } })).mediaVersion, before.mediaVersion);
      const current = await request(`/api/albums/${main.slug}/zip`, { cookie: guest });
      assert.equal((await current.json()).job.id, done.id);
      const archive = await request(`/api/zip/${done.id}/download`, { cookie: guest });
      assert.equal(archive.status, 200);
      assert.equal((await readZip(Buffer.from(await archive.arrayBuffer()))).length, 2);
    });

    await t.test("published-set changes revoke and remove old archives; a refreshed ZIP excludes hidden photos", async () => {
      assert.equal((await request(`/api/events/${main.id}/photos/moderate`, { method: "POST", cookie: ownerCookie, data: { ids: [second.id], action: "hide" } })).status, 200);
      assert.equal((await request(`/api/zip/${done.id}/download`, { cookie: guest })).status, 409);
      const invalidArchive = done;
      await cleanupExpiredZipJobs(db, s3, bucket, { eventId: main.id, jobId: invalidArchive.id });
      await assertArchiveMissing(invalidArchive.resultKey);
      const cleaned = await db.mediaJob.findUniqueOrThrow({ where: { id: invalidArchive.id } });
      assert.equal(cleaned.status, "FAILED"); assert.equal(cleaned.resultKey, null); assert.equal(cleaned.sizeBytes, 0n);
      assert.equal((await request(`/api/zip/${invalidArchive.id}/download`, { cookie: guest })).status, 409);
      const latest = await request(`/api/albums/${main.slug}/zip`, { cookie: guest });
      assert.equal((await latest.json()).job, null);
      const queued = await request(`/api/events/${main.id}/zip`, { method: "POST", cookie: ownerCookie, data: {} });
      assert.equal(queued.status, 202);
      done = await completeJob(main, (await queued.json()).job);
      const archive = await request(`/api/zip/${done.id}/download`, { cookie: guest });
      assert.equal(archive.status, 200);
      const entries = await readZip(Buffer.from(await archive.arrayBuffer()));
      assert.equal(entries.length, 1); assert.deepEqual(entries[0].bytes, jpegA);
      const mediaBeforeLike = (await db.event.findUniqueOrThrow({ where: { id: main.id } })).mediaVersion;
      assert.equal((await request(`/api/photos/${first.id}/like`, { method: "PUT", cookie: guest, data: { liked: false } })).status, 200);
      assert.equal((await db.event.findUniqueOrThrow({ where: { id: main.id } })).mediaVersion, mediaBeforeLike);
      assert.equal((await request(`/api/albums/${main.slug}/zip`, { cookie: guest }).then(response => response.json())).job.id, done.id);
      assert.equal((await request(`/api/zip/${done.id}/download`, { cookie: guest })).status, 200);
    });

    await t.test("deleting a published photo invalidates its archive and removes its likes", async () => {
      assert.ok(await db.photoLike.count({ where: { photoId: first.id } }) > 0);
      const deleted = await request(`/api/events/${main.id}/photos/moderate`, { method: "POST", cookie: ownerCookie, data: { ids: [first.id], action: "delete" } });
      assert.equal(deleted.status, 200);
      assert.equal(await db.photoLike.count({ where: { photoId: first.id } }), 0);
      assert.equal((await request(`/api/zip/${done.id}/download`, { cookie: guest })).status, 409);
      assert.equal((await request(`/api/albums/${main.slug}/zip`, { cookie: guest }).then(response => response.json())).job, null);
      assert.equal((await request(`/api/photos/${first.id}/like`, { method: "PUT", cookie: guest, data: { liked: true } })).status, 404);
    });

    await t.test("download settings, private grants and album expiry are rechecked for ZIP and likes", async () => {
      assert.equal((await request(`/api/events/${main.id}`, { method: "PATCH", cookie: ownerCookie, data: { allowDownloads: false } })).status, 200);
      assert.equal((await request(`/api/zip/${done.id}/download`, { cookie: guest })).status, 403);
      assert.equal((await request(`/api/albums/${main.slug}/zip`, { method: "POST", cookie: guest, data: {} })).status, 403);
      const privateEvent = await seedEvent(userIds[0], "private", { passwordHash: await argon2.hash("abc", { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }) });
      const privatePhoto = await seedPhoto(privateEvent, jpegB, "private.jpg");
      const created = await request(`/api/events/${privateEvent.id}/zip`, { method: "POST", cookie: ownerCookie, data: {} });
      assert.equal(created.status, 202);
      const privateJob = await completeJob(privateEvent, (await created.json()).job);
      assert.equal((await request(`/api/zip/${privateJob.id}/download`, { cookie: guest })).status, 401);
      assert.equal((await request(`/api/photos/${privatePhoto.id}/like`, { method: "PUT", cookie: guest, data: { liked: true } })).status, 401);
      const unlocked = await request(`/api/albums/${privateEvent.slug}/unlock`, { method: "POST", data: { password: "abc" } });
      const grant = unlocked.headers.getSetCookie().find(cookie => cookie.startsWith(`partyphoto_event_${privateEvent.id}=`))?.split(";")[0];
      assert.ok(grant);
      const access = `${guest}; ${grant}`;
      assert.equal((await request(`/api/zip/${privateJob.id}/download`, { cookie: access })).status, 200);
      assert.equal((await request(`/api/photos/${privatePhoto.id}/like`, { method: "PUT", cookie: access, data: { liked: true } })).status, 200);
      assert.equal((await request(`/api/events/${privateEvent.id}`, { method: "PATCH", cookie: ownerCookie, data: { password: "xyz" } })).status, 200);
      assert.equal((await request(`/api/zip/${privateJob.id}/download`, { cookie: access })).status, 401);
      assert.equal((await request(`/api/photos/${privatePhoto.id}/like`, { method: "PUT", cookie: access, data: { liked: false } })).status, 401);
      await cleanupExpiredZipJobs(db, s3, bucket, { eventId: privateEvent.id, jobId: privateJob.id });
      await assertArchiveMissing(privateJob.resultKey);
      assert.equal((await db.mediaJob.findUniqueOrThrow({ where: { id: privateJob.id } })).resultKey, null);
      assert.equal((await request(`/api/zip/${privateJob.id}/download`, { cookie: access })).status, 401);
      assert.equal((await request(`/api/zip/${privateJob.id}/download`, { cookie: ownerCookie })).status, 409);
      await db.event.update({ where: { id: privateEvent.id }, data: { expiresAt: new Date(0) } });
      assert.equal((await request(`/api/zip/${privateJob.id}/download`, { cookie: access })).status, 404);
      assert.equal((await request(`/api/photos/${privatePhoto.id}/like`, { method: "PUT", cookie: access, data: { liked: false } })).status, 404);
    });

    await t.test("empty albums refuse ZIP and expired archive objects are deleted by scoped worker cleanup", async () => {
      const empty = await seedEvent(userIds[0], "empty");
      assert.equal((await request(`/api/events/${empty.id}/zip`, { method: "POST", cookie: ownerCookie, data: {} })).status, 400);
      const expires = await seedEvent(userIds[0], "expiry");
      await seedPhoto(expires, jpegA, "expiry.jpg");
      const queued = await request(`/api/events/${expires.id}/zip`, { method: "POST", cookie: ownerCookie, data: {} });
      assert.equal(queued.status, 202);
      const expiringJob = await completeJob(expires, (await queued.json()).job);
      const archiveKey = expiringJob.resultKey;
      await db.mediaJob.update({ where: { id: expiringJob.id }, data: { expiresAt: new Date(0) } });
      // Staff bypass guest download settings, so this isolates archive expiry.
      assert.equal((await request(`/api/zip/${expiringJob.id}/download`, { cookie: ownerCookie })).status, 410);
      await cleanupExpiredZipJobs(db, s3, bucket, { eventId: expires.id, jobId: expiringJob.id });
      await assertArchiveMissing(archiveKey);
      assert.equal((await request(`/api/events/${expires.id}/zip`, { cookie: ownerCookie }).then(response => response.json())).job, null);
    });

    await t.test("transient source errors queue a retry and the next attempt produces exact source bytes", async () => {
      const retryEvent = await seedEvent(userIds[0], "retry");
      const source = await seedPhoto(retryEvent, jpegA, "retry.jpg");
      const queued = await request(`/api/events/${retryEvent.id}/zip`, { method: "POST", cookie: ownerCookie, data: {} });
      assert.equal(queued.status, 202);
      const job = (await queued.json()).job;
      let injected = false;
      const failingOnce = new Proxy(s3, { get(target, key) {
        if (key === "send") return (command, ...args) => {
          if (!injected && command instanceof GetObjectCommand && command.input.Key === source.originalKey) {
            injected = true;
            return Promise.reject(Object.assign(new Error("Injected temporary source failure"), { name: "TimeoutError", $metadata: { httpStatusCode: 503 } }));
          }
          return target.send(command, ...args);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      await processZipJob(db, failingOnce, bucket, { eventId: retryEvent.id, jobId: job.id });
      assert.equal(injected, true);
      const failed = await db.mediaJob.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(failed.status, "QUEUED"); assert.equal(failed.attempts, 1);
      assert.equal(failed.resultKey, null); assert.equal(failed.lockToken, null);
      await processZipJob(db, s3, bucket, { eventId: retryEvent.id, jobId: job.id, now: new Date(failed.availableAt.getTime() + 1000) });
      const retried = await db.mediaJob.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(retried.status, "DONE"); assert.equal(retried.attempts, 2);
      ownKeys.add(retried.resultKey);
      const archive = await request(`/api/zip/${retried.id}/download`, { cookie: ownerCookie });
      assert.equal(archive.status, 200);
      const entries = await readZip(Buffer.from(await archive.arrayBuffer()));
      assert.equal(entries.length, 1); assert.deepEqual(entries[0].bytes, jpegA);
    });

    await t.test("a live worker lease is respected and stale leases can be reclaimed once", async () => {
      const leaseEvent = await seedEvent(userIds[0], "lease");
      await seedPhoto(leaseEvent, jpegB, "lease.jpg");
      const queued = await request(`/api/events/${leaseEvent.id}/zip`, { method: "POST", cookie: ownerCookie, data: {} });
      assert.equal(queued.status, 202);
      const job = (await queued.json()).job;
      const lockToken = randomUUID();
      await db.mediaJob.update({ where: { id: job.id }, data: { status: "RUNNING", lockToken, lockedUntil: new Date(Date.now() + 600000) } });
      const untouched = await processZipJob(db, s3, bucket, { eventId: leaseEvent.id, jobId: job.id });
      assert.equal(untouched.processed, false);
      assert.equal((await db.mediaJob.findUniqueOrThrow({ where: { id: job.id } })).lockToken, lockToken);
      await db.mediaJob.update({ where: { id: job.id }, data: { lockedUntil: new Date(0) } });
      const results = await Promise.all([1, 2].map(() => processZipJob(db, s3, bucket, { eventId: leaseEvent.id, jobId: job.id })));
      assert.equal(results.filter(result => result.processed).length, 1);
      const finished = await db.mediaJob.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(finished.status, "DONE"); assert.equal(finished.attempts, 1); assert.equal(finished.lockToken, null);
      ownKeys.add(finished.resultKey);
    });

    await t.test("worker caps reject excessive snapshots without leaving an archive object", async () => {
      const limited = await seedEvent(userIds[0], "limit");
      await seedPhoto(limited, jpegA, "first.jpg");
      await seedPhoto(limited, jpegB, "second.jpg");
      const queued = await request(`/api/events/${limited.id}/zip`, { method: "POST", cookie: ownerCookie, data: {} });
      assert.equal(queued.status, 202);
      const job = (await queued.json()).job;
      await processZipJob(db, s3, bucket, { eventId: limited.id, jobId: job.id, maxPhotos: 1 });
      const failed = await db.mediaJob.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(failed.status, "FAILED"); assert.equal(failed.lastError, "ZIP_LIMIT_EXCEEDED");
      assert.equal(failed.resultKey, null);
      const response = await request(`/api/events/${limited.id}/zip`, { cookie: ownerCookie });
      const dto = (await response.json()).job;
      assert.equal(dto.status, "FAILED"); assert.equal(dto.downloadUrl, null);
      assert.equal(dto.error.includes("ZIP_LIMIT_EXCEEDED"), false);
    });

    await t.test("large original photos produce an exact ZIP through S3 multipart upload without abandoned parts", async () => {
      const big = await seedEvent(userIds[0], "multipart");
      const width = 2048;
      const height = 1024;
      const largePng = await sharp(randomBytes(width * height * 4), { raw: { width, height, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer();
      assert.ok(largePng.length > 6 * 1024 * 1024);
      await seedPhoto(big, largePng, "large-original.png");
      const visitor = await newVisitor(big);
      const queued = await request(`/api/albums/${big.slug}/zip`, { method: "POST", cookie: visitor, data: {} });
      assert.equal(queued.status, 202);
      const finished = await completeJob(big, (await queued.json()).job);
      const object = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: finished.resultKey }));
      assert.ok(object.ContentLength > 5 * 1024 * 1024);
      assert.equal(BigInt(object.ContentLength), finished.sizeBytes);
      const response = await request(`/api/zip/${finished.id}/download`, { cookie: visitor });
      assert.equal(response.status, 200);
      const entries = await readZip(Buffer.from(await response.arrayBuffer()));
      assert.equal(entries.length, 1); assert.equal(entries[0].name, "large-original.png");
      assert.deepEqual(entries[0].bytes, largePng);
      const uploads = await s3.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: `events/${big.id}/archives/${finished.id}/` }));
      assert.equal(uploads.Uploads?.length ?? 0, 0);
    });
  } finally {
    const jobs = await db.mediaJob.findMany({ where: { eventId: { in: eventIds }, kind: "ZIP" }, select: { resultKey: true } });
    for (const job of jobs) if (job.resultKey) ownKeys.add(job.resultKey);
    const photos = await db.photo.findMany({ where: { eventId: { in: eventIds } }, select: { id: true, originalKey: true, thumbnailKey: true } });
    for (const photo of photos) { ownKeys.add(photo.originalKey); if (photo.thumbnailKey) ownKeys.add(photo.thumbnailKey); }
    if (ownKeys.size) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: [...ownKeys].map(Key => ({ Key })) } }));
    await db.photoLike.deleteMany({ where: { photoId: { in: photos.map(photo => photo.id) } } });
    await db.photo.deleteMany({ where: { eventId: { in: eventIds } } });
    await db.mediaJob.deleteMany({ where: { eventId: { in: eventIds } } });
    await db.accessToken.deleteMany({ where: { eventId: { in: eventIds } } });
    await db.eventMember.deleteMany({ where: { eventId: { in: eventIds } } });
    await db.event.deleteMany({ where: { id: { in: eventIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    const voters = [...userIds.map(id => hash(`user:${id}`)), ...visitors.map(cookie => hash(`visitor:${cookie.split("=")[1]}`))];
    await db.authRateLimit.deleteMany({ where: { key: { in: [
      ...voters.flatMap(voter => [`like:voter:${voter}`, `zip:create:${voter}`]),
      ...eventIds.flatMap(id => [`like:event:${id}`, `album:unlock:${id}`, `media:moderate:${id}`, `media:upload:${id}`]),
      ...userIds.map(id => `event:update:${id}`),
    ] } } });
    await db.$disconnect();
    s3.destroy();
  }
});
