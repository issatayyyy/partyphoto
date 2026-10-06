import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { S3Client, DeleteObjectsCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import argon2 from "argon2";
import sharp from "sharp";

// This suite exercises a local application, database and S3-compatible store.
const base = new URL(process.env.AUTH_TEST_URL ?? process.env.APP_URL);
const endpoint = new URL(process.env.S3_ENDPOINT);
for (const url of [base, endpoint]) {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.protocol !== "http:") {
    throw new Error("Media integration tests require local HTTP application and storage endpoints");
  }
}
const db = new PrismaClient();
const s3 = new S3Client({
  endpoint: endpoint.href, region: process.env.S3_REGION,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
});
const bucket = process.env.S3_BUCKET;
const namespace = `media-check-${randomUUID()}`;
const hash = value => createHash("sha256").update(value).digest("hex");
const users = {};
const eventIds = [];
const cookieFrom = response => response.headers.get("set-cookie")?.split(";")[0];

async function request(path, { method = "GET", data, cookie, origin = base.origin } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    if (origin !== null) headers.origin = origin;
  }
  return fetch(new URL(path, base), { method, headers, body: data === undefined ? undefined : JSON.stringify(data), redirect: "manual" });
}

async function upload(path, bytes, { cookie, origin = base.origin, filename = "party.jpg", mime = "image/jpeg", twice = false } = {}) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime }), filename);
  if (twice) form.append("file", new Blob([bytes], { type: mime }), `second-${filename}`);
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (origin !== null) headers.origin = origin;
  return fetch(new URL(path, base), { method: "POST", headers, body: form, redirect: "manual" });
}

async function seedUser(name, role, passwordHash) {
  const token = randomBytes(32).toString("hex");
  const user = await db.user.create({ data: {
    email: `${namespace}-${name}@example.invalid`, name: `Media test ${name}`, role, passwordHash,
    sessions: { create: { tokenHash: hash(token), expiresAt: new Date(Date.now() + 3600000) } },
  } });
  users[name] = { id: user.id, cookie: `partyphoto_session=${token}` };
}

async function seedEvent(name, data = {}) {
  const event = await db.event.create({ data: {
    ownerId: users.owner.id, title: `Media test ${name}`, slug: `${namespace}-${name}`,
    code: randomBytes(4).toString("hex").toUpperCase(), maxPhotos: 20,
    allowGuestUploads: true, moderateUploads: true, ...data,
  } });
  eventIds.push(event.id);
  return event;
}

function assertNoKeys(value) {
  const text = JSON.stringify(value);
  for (const key of ["originalKey", "thumbnailKey", "passwordHash", "tokenHash", "S3_ACCESS_KEY", "$argon2id$"]) {
    assert.equal(text.includes(key), false, `media response exposed ${key}`);
  }
}

async function assertMissing(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    assert.fail("deleted media object remains in storage");
  } catch (error) {
    if (error.code === "ERR_ASSERTION") throw error;
    assert.equal(error.$metadata?.httpStatusCode, 404);
  }
}

test("photo upload, access, moderation, quotas and physical storage over HTTP", async t => {
  let main;
  let protectedEvent;
  let photo;
  let guestPhoto;
  let guestCookie;
  let jpeg;
  let guestVisitor;
  try {
    const passwordHash = await argon2.hash(randomUUID(), { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    for (const [name, role] of [["owner", "ORGANIZER"], ["foreign", "ORGANIZER"], ["photographer", "PHOTOGRAPHER"], ["admin", "ADMIN"]]) {
      await seedUser(name, role, passwordHash);
    }
    main = await seedEvent("public");
    protectedEvent = await seedEvent("private", { passwordHash: await argon2.hash("abc", { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }) });
    await db.eventMember.create({ data: { eventId: main.id, userId: users.photographer.id, role: "PHOTOGRAPHER" } });
    jpeg = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: { r: 17, g: 125, b: 213 } } }).jpeg({ quality: 95 }).toBuffer();
    const staffPath = `/api/events/${main.id}/photos`;
    const guestPath = `/api/albums/${main.slug}/photos`;

    await t.test("upload and staff listing enforce origin and event membership", async () => {
      assert.equal((await request(staffPath)).status, 401);
      assert.equal((await request(staffPath, { cookie: users.foreign.cookie })).status, 404);
      assert.equal((await upload(staffPath, jpeg)).status, 401);
      assert.equal((await upload(staffPath, jpeg, { cookie: users.foreign.cookie })).status, 404);
      for (const origin of [null, "null", "https://foreign.example"]) {
        assert.equal((await upload(staffPath, jpeg, { cookie: users.owner.cookie, origin })).status, 403);
      }
      assert.equal(await db.photo.count({ where: { eventId: main.id } }), 0);
    });

    await t.test("decoded JPEG persists an unchanged original and a compressed bounded WebP preview", async () => {
      const response = await upload(staffPath, jpeg, { cookie: users.owner.cookie, filename: "праздник.jpg" });
      assert.equal(response.status, 201, await response.clone().text());
      photo = (await response.json()).photo;
      assert.equal(photo.filename, "праздник.jpg");
      assert.equal(photo.width, 1600);
      assert.equal(photo.height, 1000);
      assert.equal(photo.status, "PUBLISHED");
      assert.equal(photo.sizeBytes, String(jpeg.length));
      assert.equal(photo.thumbnailUrl, `/api/photos/${photo.id}/thumbnail`);
      assert.equal(photo.downloadUrl, `/api/photos/${photo.id}/original`);
      assertNoKeys(photo);
      const original = await request(photo.downloadUrl, { cookie: users.owner.cookie });
      assert.equal(original.status, 200);
      assert.equal(original.headers.get("content-type"), "image/jpeg");
      assert.match(original.headers.get("content-disposition"), /attachment/);
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), jpeg);
      const preview = await request(photo.thumbnailUrl, { cookie: users.owner.cookie });
      assert.equal(preview.status, 200);
      assert.equal(preview.headers.get("content-type"), "image/webp");
      const metadata = await sharp(Buffer.from(await preview.arrayBuffer())).metadata();
      assert.equal(metadata.format, "webp");
      assert.ok(metadata.width <= 1200 && metadata.height <= 1200);
      const stored = await db.photo.findUniqueOrThrow({ where: { id: photo.id } });
      const event = await db.event.findUniqueOrThrow({ where: { id: main.id } });
      assert.equal(event.usedStorageBytes, stored.sizeBytes + stored.thumbnailBytes);
      assert.equal(event.reservedBytes, 0n);
      assert.equal(event.downloadCount, 1n);
      assert.equal(stored.downloadCount, 1n);
    });

    await t.test("a long filename ending at an emoji boundary remains valid Unicode and downloads unchanged", async () => {
      const filename = `${"a".repeat(239)}😀.jpg`;
      const response = await upload(staffPath, jpeg, { cookie: users.owner.cookie, filename });
      assert.equal(response.status, 201, await response.clone().text());
      const uploaded = (await response.json()).photo;
      assert.equal(uploaded.filename, Array.from(filename).slice(0, 240).join(""));
      assert.equal(uploaded.filename.isWellFormed(), true);
      assert.equal(uploaded.filename.endsWith("😀"), true);
      const original = await request(uploaded.downloadUrl, { cookie: users.owner.cookie });
      assert.equal(original.status, 200);
      assert.match(original.headers.get("content-disposition"), /filename\*=UTF-8''/);
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), jpeg);
    });

    await t.test("PNG and WebP work; SVG, counterfeit media, multiple files and oversize files do not persist", async () => {
      const small = sharp({ create: { width: 100, height: 80, channels: 3, background: "#ef476f" } });
      const png = await small.clone().png().toBuffer();
      const webp = await small.clone().webp().toBuffer();
      for (const [bytes, mime, filename] of [[png, "image/png", "party.png"], [webp, "image/webp", "party.webp"]]) {
        assert.equal((await upload(staffPath, bytes, { cookie: users.owner.cookie, mime, filename })).status, 201);
      }
      const before = await db.photo.count({ where: { eventId: main.id } });
      for (const [bytes, mime, filename, status] of [
        [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "image/svg+xml", "unsafe.svg", 415],
        [Buffer.from("This is not a photograph"), "image/jpeg", "fake.jpg", 400],
        [png, "image/jpeg", "wrong-mime.jpg", 415],
      ]) {
        const response = await upload(staffPath, bytes, { cookie: users.owner.cookie, mime, filename });
        assert.equal(response.status, status);
      }
      assert.equal((await upload(staffPath, jpeg, { cookie: users.owner.cookie, twice: true })).status, 400);
      await db.event.update({ where: { id: main.id }, data: { maxUploadBytes: 1048576 } });
      const oversized = Buffer.concat([jpeg, Buffer.alloc(1048576)]);
      assert.equal((await upload(staffPath, oversized, { cookie: users.owner.cookie })).status, 413);
      await db.event.update({ where: { id: main.id }, data: { maxUploadBytes: 26214400 } });
      assert.equal(await db.photo.count({ where: { eventId: main.id } }), before);
      assert.equal((await db.event.findUniqueOrThrow({ where: { id: main.id } })).reservedBytes, 0n);
    });

    await t.test("oversized decoded dimensions are rejected despite a small compressed file", async () => {
      const huge = await sharp({ create: { width: 6400, height: 6400, channels: 3, background: "#ffffff" } }).png().toBuffer();
      assert.ok(huge.length < 1048576);
      const before = await db.photo.count({ where: { eventId: main.id } });
      const response = await upload(staffPath, huge, { cookie: users.owner.cookie, mime: "image/png", filename: "too-many-pixels.png" });
      assert.equal(response.status, 400);
      assert.equal(await db.photo.count({ where: { eventId: main.id } }), before);
    });

    await t.test("assigned photographers upload published photos and can moderate only the assigned event", async () => {
      const uploaded = await upload(staffPath, jpeg, { cookie: users.photographer.cookie, filename: "photographer.jpg" });
      assert.equal(uploaded.status, 201);
      const assignedPhoto = (await uploaded.json()).photo;
      assert.equal(assignedPhoto.status, "PUBLISHED");
      assert.equal((await request(staffPath, { cookie: users.photographer.cookie })).status, 200);
      assert.equal((await request(`/api/events/${main.id}/photos/moderate`, { method: "POST", cookie: users.photographer.cookie, data: { ids: [assignedPhoto.id], action: "hide" } })).status, 200);
      assert.equal((await db.photo.findUniqueOrThrow({ where: { id: assignedPhoto.id } })).status, "HIDDEN");
      assert.equal((await request(`/api/events/${protectedEvent.id}/photos`, { cookie: users.photographer.cookie })).status, 404);
      assert.equal((await request(`/api/events/${main.id}/photos/moderate`, { method: "POST", cookie: users.foreign.cookie, data: { ids: [photo.id], action: "hide" } })).status, 404);
    });

    await t.test("guest uploads require permission and publish immediately despite the legacy approval flag", async () => {
      await db.event.update({ where: { id: main.id }, data: { allowGuestUploads: false } });
      assert.equal((await upload(guestPath, jpeg)).status, 403);
      await db.event.update({ where: { id: main.id }, data: { allowGuestUploads: true } });
      const uploaded = await upload(guestPath, jpeg, { filename: "guest.jpg" });
      assert.equal(uploaded.status, 201);
      guestPhoto = (await uploaded.json()).photo;
      assert.equal(guestPhoto.status, "PUBLISHED");
      const stored = await db.photo.findUniqueOrThrow({ where: { id: guestPhoto.id } });
      assert.equal(stored.uploaderId, null);
      const guestList = await request(guestPath);
      assert.equal(guestList.status, 200);
      guestVisitor = cookieFrom(guestList);
      assert.match(guestVisitor, /^partyphoto_visitor=[a-f0-9]{64}$/);
      const listed = (await guestList.json()).photos;
      assert.ok(listed.every(item => item.status === "PUBLISHED"));
      assert.equal(listed.some(item => item.id === guestPhoto.id), true);
      assertNoKeys(listed);
      assert.equal((await request(`/api/photos/${guestPhoto.id}/thumbnail`)).status, 200);
      const original = await request(`/api/photos/${guestPhoto.id}/original`);
      assert.equal(original.status, 200);
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), jpeg);
      const liked = await request(`/api/photos/${guestPhoto.id}/like`, { method: "PUT", cookie: guestVisitor, data: { liked: true } });
      assert.equal(liked.status, 200);
      assert.deepEqual(await liked.json(), { liked: true, likeCount: 1 });
    });

    await t.test("download permissions and hidden state are rechecked for each media request", async () => {
      const before = await db.event.findUniqueOrThrow({ where: { id: main.id } });
      const downloaded = await request(`/api/photos/${guestPhoto.id}/original`);
      assert.equal(downloaded.status, 200);
      assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), jpeg);
      assert.equal((await db.event.findUniqueOrThrow({ where: { id: main.id } })).downloadCount, before.downloadCount + 1n);
      await db.event.update({ where: { id: main.id }, data: { allowDownloads: false } });
      const listed = (await (await request(guestPath)).json()).photos;
      assert.ok(listed.every(item => item.downloadUrl === null));
      assert.equal((await request(`/api/photos/${guestPhoto.id}/original`)).status, 403);
      assert.equal((await request(`/api/photos/${guestPhoto.id}/thumbnail`)).status, 200);
      assert.equal((await request(`/api/photos/${guestPhoto.id}/original`, { cookie: users.owner.cookie })).status, 200);
      await request(`/api/events/${main.id}/photos/moderate`, { method: "POST", cookie: users.owner.cookie, data: { ids: [guestPhoto.id], action: "hide" } });
      assert.equal((await request(`/api/photos/${guestPhoto.id}/thumbnail`)).status, 404);
      assert.equal((await request(`/api/photos/${guestPhoto.id}/original`)).status, 404);
      await request(`/api/events/${main.id}/photos/moderate`, { method: "POST", cookie: users.owner.cookie, data: { ids: [guestPhoto.id], action: "publish" } });
    });

    await t.test("private albums require an access token for upload, listing and both stored variants", async () => {
      const path = `/api/albums/${protectedEvent.slug}/photos`;
      assert.equal((await request(path)).status, 401);
      assert.equal((await upload(path, jpeg)).status, 401);
      const unlocked = await request(`/api/albums/${protectedEvent.slug}/unlock`, { method: "POST", data: { password: "abc" } });
      assert.equal(unlocked.status, 200);
      guestCookie = cookieFrom(unlocked);
      const uploaded = await upload(path, jpeg, { cookie: guestCookie, filename: "private-guest.jpg" });
      assert.equal(uploaded.status, 201);
      const privatePhoto = (await uploaded.json()).photo;
      assert.equal(privatePhoto.status, "PUBLISHED");
      assert.equal((await request(`/api/photos/${privatePhoto.id}/thumbnail`)).status, 401);
      assert.equal((await request(`/api/photos/${privatePhoto.id}/original`)).status, 401);
      assert.equal((await request(`/api/photos/${privatePhoto.id}/thumbnail`, { cookie: guestCookie })).status, 200);
      assert.equal((await request(`/api/photos/${privatePhoto.id}/original`, { cookie: guestCookie })).status, 200);
      const changed = await request(`/api/events/${protectedEvent.id}`, { method: "PATCH", cookie: users.owner.cookie, data: { password: "xyz" } });
      assert.equal(changed.status, 200);
      assert.equal((await request(path, { cookie: guestCookie })).status, 401);
      assert.equal((await upload(path, jpeg, { cookie: guestCookie })).status, 401);
      assert.equal((await request(`/api/photos/${privatePhoto.id}/thumbnail`, { cookie: guestCookie })).status, 401);
      await db.event.update({ where: { id: protectedEvent.id }, data: { expiresAt: new Date(0) } });
      assert.equal((await request(path, { cookie: guestCookie })).status, 404);
      assert.equal((await upload(path, jpeg, { cookie: guestCookie })).status, 404);
      assert.equal((await request(`/api/photos/${privatePhoto.id}/original`, { cookie: guestCookie })).status, 404);
    });

    await t.test("concurrent staff and guest uploads share photo and combined original/preview storage quotas", async () => {
      const countEvent = await seedEvent("count", { maxPhotos: 1 });
      const countResponses = await Promise.all([
        upload(`/api/events/${countEvent.id}/photos`, jpeg, { cookie: users.owner.cookie, filename: "race-staff.jpg" }),
        upload(`/api/albums/${countEvent.slug}/photos`, jpeg, { filename: "race-guest.jpg" }),
      ]);
      assert.equal(countResponses.filter(item => item.status === 201).length, 1);
      assert.ok(countResponses.filter(item => item.status !== 201).every(item => item.status === 409));
      assert.equal(await db.photo.count({ where: { eventId: countEvent.id } }), 1);
      assert.equal((await db.event.findUniqueOrThrow({ where: { id: countEvent.id } })).reservedBytes, 0n);
      const original = await db.photo.findUniqueOrThrow({ where: { id: photo.id } });
      const bytesForOne = original.sizeBytes + original.thumbnailBytes;
      const sizeEvent = await seedEvent("size", { maxStorageBytes: bytesForOne });
      const sizeResponses = await Promise.all([
        upload(`/api/events/${sizeEvent.id}/photos`, jpeg, { cookie: users.owner.cookie, filename: "size-staff.jpg" }),
        upload(`/api/albums/${sizeEvent.slug}/photos`, jpeg, { filename: "size-guest.jpg" }),
      ]);
      assert.equal(sizeResponses.filter(item => item.status === 201).length, 1);
      assert.ok(sizeResponses.filter(item => item.status !== 201).every(item => item.status === 409));
      const stored = await db.event.findUniqueOrThrow({ where: { id: sizeEvent.id } });
      assert.equal(await db.photo.count({ where: { eventId: sizeEvent.id } }), 1);
      assert.equal(stored.usedStorageBytes, bytesForOne);
      assert.equal(stored.reservedBytes, 0n);
    });

    await t.test("moderation rejects foreign photo ids and physical deletion releases quota", async () => {
      const other = await db.photo.findFirstOrThrow({ where: { eventId: protectedEvent.id } });
      const before = await db.photo.findUniqueOrThrow({ where: { id: photo.id } });
      const rejected = await request(`/api/events/${main.id}/photos/moderate`, { method: "POST", cookie: users.owner.cookie, data: { ids: [photo.id, other.id], action: "hide" } });
      assert.equal(rejected.status, 404);
      assert.equal((await db.photo.findUniqueOrThrow({ where: { id: photo.id } })).status, before.status);
      assert.equal((await request(`/api/events/${main.id}/photos/moderate`, { method: "POST", cookie: users.owner.cookie, data: { ids: [photo.id], action: "delete" }, origin: "https://foreign.example" })).status, 403);
      const storageBefore = await db.event.findUniqueOrThrow({ where: { id: main.id } });
      const deleted = await request(`/api/events/${main.id}/photos/moderate`, { method: "POST", cookie: users.admin.cookie, data: { ids: [photo.id], action: "delete" } });
      assert.equal(deleted.status, 200, await deleted.clone().text());
      assert.equal((await request(`/api/photos/${photo.id}/thumbnail`, { cookie: users.owner.cookie })).status, 404);
      assert.equal((await request(`/api/photos/${photo.id}/original`, { cookie: users.owner.cookie })).status, 404);
      await assertMissing(before.originalKey);
      await assertMissing(before.thumbnailKey);
      assert.equal((await db.event.findUniqueOrThrow({ where: { id: main.id } })).usedStorageBytes, storageBefore.usedStorageBytes - before.sizeBytes - before.thumbnailBytes);
    });
  } finally {
    // Query only this run's events before removing DB references to their keys.
    const photos = await db.photo.findMany({ where: { eventId: { in: eventIds } }, select: { originalKey: true, thumbnailKey: true } });
    const keys = photos.flatMap(item => [item.originalKey, item.thumbnailKey].filter(Boolean));
    if (keys.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map(Key => ({ Key })) } }));
    await db.photo.deleteMany({ where: { eventId: { in: eventIds } } });
    await db.mediaJob.deleteMany({ where: { eventId: { in: eventIds } } });
    await db.accessToken.deleteMany({ where: { eventId: { in: eventIds } } });
    await db.eventMember.deleteMany({ where: { eventId: { in: eventIds } } });
    await db.event.deleteMany({ where: { id: { in: eventIds } } });
    const userIds = Object.values(users).map(user => user.id);
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.authRateLimit.deleteMany({ where: { key: { in: [
      ...userIds.flatMap(id => [`event:create:${id}`, `event:update:${id}`]),
      ...userIds.map(id => `media:upload:${id}`),
      ...eventIds.flatMap(id => [`album:unlock:${id}`, `album:resolve:${id}`, `media:upload:${id}`, `media:moderate:${id}`, `like:event:${id}`]),
      ...(guestVisitor ? [`like:voter:${hash(`visitor:${guestVisitor.split("=")[1]}`)}`] : []),
    ] } } });
    await db.$disconnect();
    s3.destroy();
  }
});
