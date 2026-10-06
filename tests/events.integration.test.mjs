import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";

// These tests create isolated fixtures against this project's local dev server.
const base = new URL(process.env.AUTH_TEST_URL ?? process.env.APP_URL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) || base.protocol !== "http:") {
  throw new Error("Event integration tests require a local HTTP dev server");
}
const db = new PrismaClient();
const namespace = `event-check-${randomUUID()}`;
const hash = value => createHash("sha256").update(value).digest("hex");
const identities = {};
const password = "abc";
const cookieFrom = response => response.headers.get("set-cookie")?.split(";")[0];

async function request(path, { method = "GET", data, cookie, origin = base.origin, type = "application/json", raw } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (method !== "GET") {
    headers["content-type"] = type;
    if (origin !== null) headers.origin = origin;
  }
  return fetch(new URL(path, base), { method, headers, body: raw ?? (data === undefined ? undefined : JSON.stringify(data)), redirect: "manual" });
}

async function seedIdentity(name, role) {
  const token = randomBytes(32).toString("hex");
  const user = await db.user.create({ data: {
    email: `${namespace}-${name}@example.invalid`, name: `Event test ${name}`, role,
    passwordHash: await argon2.hash(randomUUID(), { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }),
    sessions: { create: { tokenHash: hash(token), expiresAt: new Date(Date.now() + 3600000) } },
  } });
  identities[name] = { id: user.id, cookie: `partyphoto_session=${token}` };
}

function assertNoSecrets(value) {
  const serialized = JSON.stringify(value);
  for (const forbidden of ["passwordHash", "tokenHash", "ownerId", "disabledAt", "$argon2id$"]) {
    assert.equal(serialized.includes(forbidden), false, `response exposed ${forbidden}`);
  }
}

test("events, permissions and protected guest albums over HTTP and PostgreSQL", async t => {
  let event;
  let guestCookie;
  try {
    for (const [name, role] of [["owner", "ORGANIZER"], ["foreign", "ORGANIZER"], ["photographer", "PHOTOGRAPHER"], ["admin", "ADMIN"]]) {
      await seedIdentity(name, role);
    }
    const owner = identities.owner.cookie;
    const admin = identities.admin.cookie;
    const foreign = identities.foreign.cookie;
    const photographer = identities.photographer.cookie;

    await t.test("anonymous users, photographers, CSRF and invalid settings cannot create events", async () => {
      assert.equal((await request("/api/events")).status, 401);
      assert.equal((await request("/api/events", { method: "POST", data: { title: "Test event" } })).status, 401);
      assert.equal((await request("/api/events", { method: "POST", data: { title: "Test event" }, cookie: photographer })).status, 403);
      for (const origin of [null, "null", "https://foreign.example"]) {
        assert.equal((await request("/api/events", { method: "POST", data: { title: "Test event" }, cookie: owner, origin })).status, 403);
      }
      assert.equal((await request("/api/events", { method: "POST", data: {}, cookie: owner, type: "text/plain" })).status, 415);
      assert.equal((await request("/api/events", { method: "POST", cookie: owner, raw: "x".repeat(8193) })).status, 413);
      for (const invalid of [
        { title: "x" }, { title: "Valid title", ownerId: identities.foreign.id },
        { title: "Valid title", role: "ADMIN" }, { title: "Valid title", slug: "Bad Slug!" },
        { title: "Valid title", slug: "resolve" },
        { title: "Valid title", maxPhotos: 0 }, { title: "Valid title", maxStorageMb: 9 },
        { title: "Valid title", maxUploadMb: 26 }, { title: "Valid title", password: "ab" },
        { title: "Valid title", expiresAt: "not-a-date" },
        { title: "Valid title", expiresAt: new Date(0).toISOString() },
        { title: "Valid title", startsAt: new Date(Date.now() + 172800000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() },
      ]) {
        assert.equal((await request("/api/events", { method: "POST", data: invalid, cookie: owner })).status, 400);
      }
      assert.equal(await db.event.count({ where: { ownerId: identities.owner.id } }), 0);
    });

    await t.test("creation persists settings, generates public identifiers and serializes large counters", async () => {
      const response = await request("/api/events", { method: "POST", cookie: owner, data: {
        title: "Test <event>", slug: `${namespace}-album`, description: "Private description used for access checks",
        startsAt: new Date(Date.now() + 86400000).toISOString(), expiresAt: new Date(Date.now() + 172800000).toISOString(),
        allowGuestUploads: true, moderateUploads: true, allowDownloads: false,
        maxPhotos: 25, maxStorageMb: 64, maxUploadMb: 5,
      } });
      assert.equal(response.status, 201, await response.clone().text());
      assert.equal(response.headers.get("cache-control"), "no-store");
      event = (await response.json()).event;
      assert.equal(event.title, "Test <event>");
      assert.equal(event.slug, `${namespace}-album`);
      assert.ok(event.code.length >= 6);
      assert.equal(event.hasPassword, false);
      assert.equal(event.canManage, true);
      assert.equal(new URL(event.url).pathname, `/e/${event.slug}`);
      assertNoSecrets(event);
      const stored = await db.event.findUniqueOrThrow({ where: { id: event.id } });
      assert.equal(stored.ownerId, identities.owner.id);
      assert.equal(stored.maxStorageBytes, 64n * 1024n * 1024n);
      assert.equal(stored.maxUploadBytes, 5 * 1024 * 1024);
      assert.equal(stored.maxPhotos, 25);
      assert.equal(stored.allowGuestUploads, true);
      assert.equal(stored.moderateUploads, false);
      assert.equal(event.moderateUploads, false);
      assert.equal(stored.allowDownloads, false);
      assert.equal(typeof event.usedStorageBytes, "string");
      await db.event.update({ where: { id: event.id }, data: { viewCount: 9007199254740993n, downloadCount: 9007199254740995n } });
      const get = await request(`/api/events/${event.id}`, { cookie: owner });
      assert.equal(get.status, 200);
      const dto = (await get.json()).event;
      assert.equal(dto.viewCount, "9007199254740993");
      assert.equal(dto.downloadCount, "9007199254740995");
      assertNoSecrets(dto);
    });

    await t.test("duplicate slugs fail and unspecified settings retain safe defaults", async () => {
      assert.equal((await request("/api/events", { method: "POST", cookie: owner, data: { title: "Collision", slug: event.slug } })).status, 409);
      const response = await request("/api/events", { method: "POST", cookie: admin, data: { title: "Admin defaults" } });
      assert.equal(response.status, 201);
      const created = (await response.json()).event;
      const stored = await db.event.findUniqueOrThrow({ where: { id: created.id } });
      assert.equal(stored.ownerId, identities.admin.id);
      assert.equal(stored.maxPhotos, 1000);
      assert.equal(stored.maxStorageBytes, 10737418240n);
      assert.equal(stored.maxUploadBytes, 26214400);
      assert.equal(stored.allowGuestUploads, false);
      assert.equal(stored.moderateUploads, false);
      assert.equal(stored.allowDownloads, true);
      assert.notEqual(created.code, event.code);
      assert.notEqual(created.slug, event.slug);
    });

    await t.test("list, details and mutation respect owner, admin and assigned member permissions", async () => {
      const own = await request("/api/events", { cookie: owner });
      assert.ok((await own.json()).events.some(item => item.id === event.id));
      const others = await request("/api/events", { cookie: foreign });
      assert.equal((await others.json()).events.some(item => item.id === event.id), false);
      assert.equal((await request(`/api/events/${event.id}`, { cookie: foreign })).status, 404);
      assert.equal((await request(`/api/events/${event.id}`, { method: "PATCH", cookie: foreign, data: { title: "Unauthorized" } })).status, 404);
      assert.equal((await request(`/api/events/${event.id}`, { cookie: admin })).status, 200);
      await db.eventMember.create({ data: { eventId: event.id, userId: identities.photographer.id, role: "PHOTOGRAPHER" } });
      const assigned = await request(`/api/events/${event.id}`, { cookie: photographer });
      assert.equal(assigned.status, 200);
      assert.equal((await assigned.json()).event.canManage, false);
      const assignedList = await request("/api/events", { cookie: photographer });
      assert.ok((await assignedList.json()).events.some(item => item.id === event.id));
      assert.equal((await request(`/api/events/${event.id}`, { method: "PATCH", cookie: photographer, data: { title: "Unauthorized" } })).status, 403);
      assert.equal((await request(`/api/events/${event.id}`, { method: "PATCH", cookie: owner, data: { ownerId: identities.foreign.id } })).status, 400);
      assert.equal((await request(`/api/events/${event.id}`, { method: "PATCH", cookie: owner, data: { title: "Changed" }, origin: "https://foreign.example" })).status, 403);
      await db.eventMember.create({ data: { eventId: event.id, userId: identities.foreign.id, role: "ORGANIZER" } });
      const shared = await request(`/api/events/${event.id}`, { method: "PATCH", cookie: foreign, data: { title: "Shared organizer event" } });
      assert.equal(shared.status, 200);
      assert.equal((await shared.json()).event.canManage, true);
      const updated = await request(`/api/events/${event.id}`, { method: "PATCH", cookie: admin, data: { title: "Updated event", maxPhotos: 50 } });
      assert.equal(updated.status, 200);
      assert.equal((await updated.json()).event.title, "Updated event");
      assert.equal((await db.event.findUniqueOrThrow({ where: { id: event.id } })).ownerId, identities.owner.id);
    });

    await t.test("lowering quotas cannot exclude stored photos or reserved storage", async () => {
      await db.event.update({ where: { id: event.id }, data: { usedStorageBytes: 60n * 1048576n, reservedBytes: 10n * 1048576n } });
      assert.equal((await request(`/api/events/${event.id}`, { method: "PATCH", cookie: owner, data: { maxStorageMb: 64 } })).status, 400);
      await db.event.update({ where: { id: event.id }, data: { usedStorageBytes: 0n, reservedBytes: 0n } });
      await db.photo.createMany({ data: [1, 2].map(index => ({
        eventId: event.id, originalKey: `${namespace}/photo-${index}`, filename: `test-${index}.jpg`,
        mimeType: "image/jpeg", sizeBytes: 1024n, status: "PUBLISHED",
      })) });
      assert.equal((await request(`/api/events/${event.id}`, { method: "PATCH", cookie: owner, data: { maxPhotos: 1 } })).status, 400);
      assert.equal((await db.event.findUniqueOrThrow({ where: { id: event.id } })).maxPhotos, 50);
      await db.photo.deleteMany({ where: { eventId: event.id } });
    });

    await t.test("authorized QR export is a PNG; event codes resolve to a guest URL", async () => {
      assert.equal((await request(`/api/events/${event.id}/qr`)).status, 401);
      // The unassigned account has become a co-organizer above, so use an invalid id for obscurity.
      assert.equal((await request("/api/events/missing-event/qr", { cookie: owner })).status, 404);
      const qr = await request(`/api/events/${event.id}/qr`, { cookie: owner });
      assert.equal(qr.status, 200);
      assert.match(qr.headers.get("content-type"), /^image\/png/);
      assert.deepEqual([...new Uint8Array(await qr.arrayBuffer()).slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      const resolve = await request("/api/albums/resolve", { method: "POST", data: { code: event.code } });
      assert.equal(resolve.status, 200);
      assert.equal((await resolve.json()).url, `/e/${event.slug}`);
      let missingCode;
      do { missingCode = randomBytes(4).toString("hex").toUpperCase().replace(/[01]/g, "2"); }
      while (await db.event.findUnique({ where: { code: missingCode } }));
      assert.equal((await request("/api/albums/resolve", { method: "POST", data: { code: missingCode } })).status, 404);
      const open = await request(`/api/albums/${event.slug}`);
      assert.equal(open.status, 200);
      assertNoSecrets((await open.json()).event);
      const landing = await request(`/e/${event.slug}`);
      assert.equal(landing.status, 200);
      assert.match(await landing.text(), /Updated event/);
    });

    await t.test("password locks guest data; unlock stores only a hashed scoped access token", async () => {
      const updated = await request(`/api/events/${event.id}`, { method: "PATCH", cookie: owner, data: { password } });
      assert.equal(updated.status, 200);
      assert.equal((await updated.json()).event.hasPassword, true);
      const stored = await db.event.findUniqueOrThrow({ where: { id: event.id } });
      assert.ok(await argon2.verify(stored.passwordHash, password));
      assert.equal((await request(`/api/albums/${event.slug}`)).status, 401);
      const landing = await request(`/e/${event.slug}`);
      assert.equal(landing.status, 200);
      const html = await landing.text();
      assert.match(html, /Updated event/);
      assert.equal(html.includes("Private description used for access checks"), false);
      const unlockPath = `/api/albums/${event.slug}/unlock`;
      assert.equal((await request(unlockPath, { method: "POST", data: { password }, origin: "https://foreign.example" })).status, 403);
      assert.equal((await request(unlockPath, { method: "POST", data: { password: "ab" } })).status, 400);
      assert.equal((await request(unlockPath, { method: "POST", data: { password: "wrong-password" } })).status, 401);
      const unlocked = await request(unlockPath, { method: "POST", data: { password } });
      assert.equal(unlocked.status, 200);
      guestCookie = cookieFrom(unlocked);
      assert.match(guestCookie, new RegExp(`^partyphoto_event_${event.id}=[a-f0-9]{64}$`));
      assert.match(unlocked.headers.get("set-cookie"), /HttpOnly/i);
      assert.match(unlocked.headers.get("set-cookie"), /SameSite=lax/i);
      const token = guestCookie.split("=")[1];
      const access = await db.accessToken.findUniqueOrThrow({ where: { tokenHash: hash(token) } });
      assert.equal(access.eventId, event.id);
      assert.equal(access.accessVersion, stored.accessVersion);
      assert.notEqual(access.tokenHash, token);
      const open = await request(`/api/albums/${event.slug}`, { cookie: guestCookie });
      assert.equal(open.status, 200);
      assert.equal((await open.json()).event.description, "Private description used for access checks");
      assert.equal((await request(`/api/albums/${event.slug}`, { cookie: `partyphoto_event_${event.id}=forged` })).status, 401);
      await db.accessToken.update({ where: { id: access.id }, data: { expiresAt: new Date(0) } });
      assert.equal((await request(`/api/albums/${event.slug}`, { cookie: guestCookie })).status, 401);
      const refreshed = await request(unlockPath, { method: "POST", data: { password } });
      assert.equal(refreshed.status, 200);
      guestCookie = cookieFrom(refreshed);
    });

    await t.test("password omission preserves it, access changes revoke old tokens, and removal opens the album", async () => {
      const before = await db.event.findUniqueOrThrow({ where: { id: event.id } });
      assert.equal((await request(`/api/events/${event.id}`, { method: "PATCH", cookie: owner, data: { title: "Renamed private album" } })).status, 200);
      assert.equal((await db.event.findUniqueOrThrow({ where: { id: event.id } })).passwordHash, before.passwordHash);
      assert.equal((await request(`/api/albums/${event.slug}`, { cookie: guestCookie })).status, 200);
      const unchangedSettings = await request(`/api/events/${event.id}`, { method: "PATCH", cookie: owner, data: {
        title: "Renamed private album", startsAt: before.startsAt.toISOString(), expiresAt: before.expiresAt.toISOString(),
        allowGuestUploads: before.allowGuestUploads, allowDownloads: before.allowDownloads,
      } });
      assert.equal(unchangedSettings.status, 200);
      assert.equal((await db.event.findUniqueOrThrow({ where: { id: event.id } })).accessVersion, before.accessVersion);
      assert.equal((await request(`/api/albums/${event.slug}`, { cookie: guestCookie })).status, 200);
      const changed = await request(`/api/events/${event.id}`, { method: "PATCH", cookie: owner, data: { allowDownloads: true } });
      assert.equal(changed.status, 200);
      assert.ok((await db.event.findUniqueOrThrow({ where: { id: event.id } })).accessVersion > before.accessVersion);
      assert.equal((await request(`/api/albums/${event.slug}`, { cookie: guestCookie })).status, 401);
      const current = await request(`/api/albums/${event.slug}/unlock`, { method: "POST", data: { password } });
      assert.equal(current.status, 200);
      guestCookie = cookieFrom(current);
      assert.equal((await request(`/api/events/${event.id}`, { method: "PATCH", cookie: owner, data: { password: "" } })).status, 200);
      assert.equal((await db.event.findUniqueOrThrow({ where: { id: event.id } })).passwordHash, null);
      assert.equal((await request(`/api/albums/${event.slug}`)).status, 200);
    });

    await t.test("expired or deleted albums disappear from guest routes and code resolution", async () => {
      await db.event.update({ where: { id: event.id }, data: { expiresAt: new Date(0) } });
      const expiredSettings = await db.event.findUniqueOrThrow({ where: { id: event.id } });
      const edit = await request(`/api/events/${event.id}`, { method: "PATCH", cookie: owner, data: {
        title: "Edited expired album", startsAt: expiredSettings.startsAt.toISOString(), expiresAt: new Date(0).toISOString(),
      } });
      assert.equal(edit.status, 200);
      assert.equal((await request(`/api/albums/${event.slug}`, { cookie: guestCookie })).status, 404);
      assert.equal((await request(`/e/${event.slug}`)).status, 404);
      assert.equal((await request(`/api/albums/${event.slug}/unlock`, { method: "POST", data: { password } })).status, 404);
      assert.equal((await request("/api/albums/resolve", { method: "POST", data: { code: event.code } })).status, 404);
      assert.equal((await request(`/api/events/${event.id}`, { cookie: owner })).status, 200);
      await db.event.update({ where: { id: event.id }, data: { expiresAt: null, deletedAt: new Date() } });
      assert.equal((await request(`/api/albums/${event.slug}`)).status, 404);
      assert.equal((await request(`/e/${event.slug}`)).status, 404);
      assert.equal((await request("/api/albums/resolve", { method: "POST", data: { code: event.code } })).status, 404);
    });
  } finally {
    const userIds = Object.values(identities).map(identity => identity.id);
    const events = await db.event.findMany({ where: { ownerId: { in: userIds } }, select: { id: true } });
    const eventIds = events.map(item => item.id);
    await db.photo.deleteMany({ where: { eventId: { in: eventIds } } });
    await db.mediaJob.deleteMany({ where: { eventId: { in: eventIds } } });
    await db.eventMember.deleteMany({ where: { eventId: { in: eventIds } } });
    await db.accessToken.deleteMany({ where: { eventId: { in: eventIds } } });
    await db.event.deleteMany({ where: { id: { in: eventIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    // Remove album-specific counters only; keep shared application limits intact.
    await db.authRateLimit.deleteMany({ where: { key: { in: [
      ...userIds.flatMap(id => [`event:create:${id}`, `event:update:${id}`]),
      ...eventIds.flatMap(id => [`album:unlock:${id}`, `album:resolve:${id}`]),
    ] } } });
    await db.$disconnect();
  }
});
