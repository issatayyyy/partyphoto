import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import { S3Client, DeleteObjectCommand, ListObjectsV2Command, ListMultipartUploadsCommand, AbortMultipartUploadCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import yauzl from "yauzl";

const database = new URL(process.env.DATABASE_URL);
const endpoint = new URL(process.env.S3_ENDPOINT);
const loopback = ["localhost", "127.0.0.1", "[::1]"];
if (!loopback.includes(database.hostname) || !["postgres:", "postgresql:"].includes(database.protocol)
  || !loopback.includes(endpoint.hostname) || endpoint.protocol !== "http:" || endpoint.username || endpoint.password) {
  throw new Error("Demo smoke test requires local PostgreSQL and authenticated local S3");
}
for (const name of ["S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) {
  if (!process.env[name]) throw new Error("Demo smoke test requires local S3 configuration");
}
const schema = `partyphoto_test_${randomBytes(10).toString("hex")}`;
assert.match(schema, /^partyphoto_test_[a-f0-9]{20}$/);
database.searchParams.set("schema", schema);
const origin = "https://demo.example.invalid";
const base = "http://127.0.0.1:3108";
const env = { ...process.env, DATABASE_URL: database.href, APP_URL: origin, PORT: "3108",
  PARTYPHOTO_DEMO_MODE: "true", MAX_UPLOAD_BYTES: "3145728", MAX_ZIP_BYTES: "41943040", MAX_ZIP_PHOTOS: "100" };
const db = new PrismaClient({ datasources: { db: { url: database.href } } });
const s3 = new S3Client({ endpoint: endpoint.href, region: env.S3_REGION, forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
  credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  requestHandler: { connectionTimeout: 5000, requestTimeout: 10000, socketTimeout: 10000, throwOnRequestTimeout: true } });
const ownEvents = new Set();
const ownKeys = new Set();

function cookie(response, name) {
  return response.headers.getSetCookie().find(value => value.startsWith(`${name}=`))?.split(";")[0];
}
async function request(path, { method = "GET", data, cookie: cookies } = {}) {
  const headers = {};
  if (cookies) headers.cookie = cookies;
  if (method !== "GET") { headers.origin = origin; headers["content-type"] = "application/json"; }
  return fetch(new URL(path, base), { method, headers, body: data === undefined ? undefined : JSON.stringify(data), redirect: "manual", signal: AbortSignal.timeout(10000) });
}
async function upload(slug, bytes, filename, cookies) {
  const body = new FormData();
  body.append("file", new Blob([bytes], { type: "image/jpeg" }), filename);
  return fetch(`${base}/api/albums/${slug}/photos`, { method: "POST", headers: { origin, cookie: cookies }, body, signal: AbortSignal.timeout(15000) });
}
async function expectStatus(response, status, message) {
  assert.equal(response.status, status, message);
  return response;
}
async function assertPortFree() {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once("error", () => reject(new Error("Demo smoke port 3108 is already in use"))); probe.listen(3108, "127.0.0.1", resolve); });
  await new Promise(resolve => probe.close(resolve));
}
async function waitReady(child) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Production demo supervisor stopped before readiness");
    try { const response = await request("/api/health"); if (response.status === 200) return; } catch { /* Migration/server startup is still in progress. */ }
    await delay(250);
  }
  throw new Error("Production demo did not become ready");
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const result = await Promise.race([exited, delay(12000).then(() => null)]);
  if (!result) { child.kill("SIGKILL"); await Promise.race([exited, delay(2000)]); }
}
async function zipEntries(bytes) {
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, value) => error ? reject(error) : resolve(value)));
  const entries = [];
  await new Promise((resolve, reject) => {
    zip.on("error", reject); zip.on("end", resolve);
    zip.on("entry", entry => zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const chunks = [];
      stream.on("data", chunk => chunks.push(chunk)); stream.on("error", reject);
      stream.on("end", () => { entries.push({ name: entry.fileName, bytes: Buffer.concat(chunks) }); zip.readEntry(); });
    }));
    zip.readEntry();
  });
  return entries;
}
async function cleanupObjects() {
  // Each prefix belongs to an event created in this test's private schema.
  for (const id of ownEvents) {
    const prefix = `events/${id}/`;
    let marker;
    let uploadMarker;
    do {
      const page = await s3.send(new ListMultipartUploadsCommand({ Bucket: env.S3_BUCKET, Prefix: prefix, KeyMarker: marker, UploadIdMarker: uploadMarker }));
      for (const upload of page.Uploads ?? []) if (upload.Key?.startsWith(prefix) && upload.UploadId) {
        await s3.send(new AbortMultipartUploadCommand({ Bucket: env.S3_BUCKET, Key: upload.Key, UploadId: upload.UploadId }));
      }
      if (!page.IsTruncated) break;
      marker = page.NextKeyMarker; uploadMarker = page.NextUploadIdMarker;
      if (!marker) throw new Error("Invalid fixture multipart pagination");
    } while (true);
    let continuation;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: env.S3_BUCKET, Prefix: prefix, ContinuationToken: continuation }));
      for (const object of page.Contents ?? []) if (object.Key?.startsWith(prefix)) ownKeys.add(object.Key);
      if (!page.IsTruncated) break;
      continuation = page.NextContinuationToken;
      if (!continuation) throw new Error("Invalid fixture object pagination");
    } while (true);
  }
  for (const key of ownKeys) {
    assert.ok([...ownEvents].some(id => key.startsWith(`events/${id}/`)), "Refusing to delete an unowned storage key");
    await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  }
}

test("production free-demo supervisor serves auth, bounded media and worker ZIP in an isolated schema", { timeout: 180000 }, async t => {
  let child;
  let created = false;
  try {
    await assertPortFree();
    await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    created = true;
    child = spawn(process.execPath, ["scripts/start-demo.mjs"], { cwd: new URL("../", import.meta.url), env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.resume(); child.stderr.resume(); // Never relay database/library diagnostics or environment values.
    await waitReady(child);
    const home = await expectStatus(await request("/"), 200, "Production homepage failed");
    const html = await home.text();
    const asset = html.match(/(?:src|href)="(\/_next\/static\/[^"?]+(?:\?[^\"]*)?)"/)?.[1]?.replaceAll("&amp;", "&");
    assert.ok(asset, "Production homepage omitted static assets");
    await expectStatus(await request(asset), 200, "Standalone static assets are unavailable");

    const registration = await expectStatus(await request("/api/auth/register", { method: "POST", data: {
      email: `${schema}@example.invalid`, name: "Course demo smoke", password: "Course-demo-12345!",
    } }), 201, "Production registration failed");
    const owner = cookie(registration, "partyphoto_session");
    assert.match(owner ?? "", /^partyphoto_session=[a-f0-9]{64}$/);
    assert.ok(registration.headers.getSetCookie().some(value => value.startsWith("partyphoto_session=") && /; Secure(?:;|$)/i.test(value)));
    const creation = await expectStatus(await request("/api/events", { method: "POST", cookie: owner, data: {
      title: "Course demo fixture", slug: `demo-${randomBytes(8).toString("hex")}`, allowGuestUploads: true,
      maxPhotos: 20, maxStorageMb: 200, maxUploadMb: 25,
    } }), 201, "Production event creation failed");
    const event = (await creation.json()).event;
    ownEvents.add(event.id);
    const initial = await expectStatus(await request(`/api/albums/${event.slug}/photos`), 200, "Guest gallery failed");
    const visitor = cookie(initial, "partyphoto_visitor");
    assert.match(visitor ?? "", /^partyphoto_visitor=[a-f0-9]{64}$/);
    const jpeg = await sharp({ create: { width: 120, height: 80, channels: 3, background: "#dc705b" } }).jpeg().toBuffer();
    const uploaded = await expectStatus(await upload(event.slug, jpeg, "course.jpg", visitor), 201, "Production guest upload failed");
    const photo = (await uploaded.json()).photo;
    assert.equal(photo.status, "PUBLISHED");
    const stored = await db.photo.findUniqueOrThrow({ where: { id: photo.id } });
    ownKeys.add(stored.originalKey); ownKeys.add(stored.thumbnailKey);
    const gallery = await expectStatus(await request(`/api/albums/${event.slug}/photos`, { cookie: visitor }), 200, "Guest list failed");
    assert.equal((await gallery.json()).photos.length, 1);
    const original = await expectStatus(await request(photo.downloadUrl, { cookie: visitor }), 200, "Original download failed");
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), jpeg);
    const liked = await expectStatus(await request(`/api/photos/${photo.id}/like`, { method: "PUT", cookie: visitor, data: { liked: true } }), 200, "Guest like failed");
    assert.deepEqual(await liked.json(), { liked: true, likeCount: 1 });

    await expectStatus(await upload(event.slug, Buffer.alloc(3145729, 1), "oversize.jpg", visitor), 413, "Demo accepted a file larger than 3 MiB");
    const huge = await sharp({ create: { width: 3000, height: 2100, channels: 3, background: "#eeeeee" } }).jpeg().toBuffer();
    assert.ok(huge.length < 3145728, "Pixel-limit fixture must fit the file-size cap");
    const rejected = await expectStatus(await upload(event.slug, huge, "huge.jpg", visitor), 400, "Demo accepted a compressed image larger than 6 MP");
    assert.match((await rejected.json()).error, /6 мегапикселей/);
    assert.equal(await db.photo.count({ where: { eventId: event.id } }), 1);

    const queued = await request(`/api/albums/${event.slug}/zip`, { method: "POST", cookie: visitor, data: {} });
    assert.ok([200, 202].includes(queued.status), "ZIP queue failed");
    const job = (await queued.json()).job;
    const deadline = Date.now() + 45000;
    let done;
    while (Date.now() < deadline) {
      const current = await db.mediaJob.findUniqueOrThrow({ where: { id: job.id } });
      if (current.resultKey) ownKeys.add(current.resultKey);
      if (current.status === "FAILED") throw new Error("Production demo ZIP worker failed");
      if (current.status === "DONE") { done = current; break; }
      await delay(250);
    }
    assert.ok(done, "Production supervisor did not process the queued ZIP");
    const archive = await expectStatus(await request(`/api/zip/${job.id}/download`, { cookie: visitor }), 200, "ZIP download failed");
    const entries = await zipEntries(Buffer.from(await archive.arrayBuffer()));
    assert.equal(entries.length, 1); assert.equal(entries[0].name, "course.jpg"); assert.deepEqual(entries[0].bytes, jpeg);
    if (process.platform === "linux") {
      try {
        const ids = (await readFile(`/proc/${child.pid}/task/${child.pid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean);
        const rss = await Promise.all(ids.map(async id => Number((await readFile(`/proc/${id}/status`, "utf8")).match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0)));
        t.diagnostic(`Local production web+worker RSS: ${Math.round(rss.reduce((sum, value) => sum + value, 0) / 1024)} MiB; hosted 512 MB behavior is not measured`);
      } catch { /* Resource reporting is optional; functional verification is required. */ }
    }
    await stop(child);
    assert.equal(child.exitCode, 0, "Demo supervisor did not shut down gracefully");
  } finally {
    await stop(child);
    try { await cleanupObjects(); }
    finally {
      if (created) {
        assert.match(schema, /^partyphoto_test_[a-f0-9]{20}$/);
        await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      }
      await db.$disconnect(); s3.destroy();
    }
  }
});
