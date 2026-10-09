import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { pruneAlbumViews, pruneViewRateLimits } from "../scripts/view-cleanup.mjs";

// Empty galleries keep these HTTP/PostgreSQL checks independent of S3.
const base = new URL(process.env.AUTH_TEST_URL ?? process.env.APP_URL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) || base.protocol !== "http:") {
  throw new Error("View integration tests require a local HTTP dev server");
}
const db = new PrismaClient();
const namespace = `view-check-${randomUUID()}`;
const eventIds = [];
const visitorHashes = new Set();
const extraRateKeys = [];
const hash = value => createHash("sha256").update(value).digest("hex");
const baseline = 9007199254740993n;

async function request(path, { method = "GET", data, cookie, origin = base.origin, type = "application/json", raw, headers: extraHeaders = {} } = {}) {
  const headers = { ...extraHeaders };
  if (cookie) headers.cookie = cookie;
  if (method !== "GET") {
    headers["content-type"] = type;
    if (origin !== null) headers.origin = origin;
  }
  return fetch(new URL(path, base), {
    method, headers, body: raw ?? (data === undefined ? undefined : JSON.stringify(data)), redirect: "manual",
  });
}

function responseCookie(response, name) {
  return response.headers.getSetCookie().find(value => value.startsWith(`${name}=`))?.split(";")[0];
}

async function visitor(event, cookie) {
  const response = await request(`/api/albums/${event.slug}/photos`, { cookie });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).photos, []);
  const issued = responseCookie(response, "partyphoto_visitor");
  assert.match(issued, /^partyphoto_visitor=[a-f0-9]{64}$/);
  assert.match(response.headers.getSetCookie().find(value => value.startsWith("partyphoto_visitor=")), /HttpOnly/i);
  const visitorHash = hash(`visitor:${issued.split("=")[1]}`);
  visitorHashes.add(visitorHash);
  return { cookie: issued, visitorHash };
}

async function postView(event, cookie, options = {}) {
  return request(`/api/albums/${event.slug}/view`, { method: "POST", data: {}, cookie, ...options });
}

async function expectCounted(response, counted) {
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { counted });
}

async function state(eventId) {
  return db.event.findUniqueOrThrow({ where: { id: eventId }, select: {
    viewCount: true, downloadCount: true, accessVersion: true, mediaVersion: true,
    usedStorageBytes: true, reservedBytes: true,
  } });
}

async function timestamp(offsetMs = 0) {
  const [row] = await db.$queryRaw`SELECT CURRENT_TIMESTAMP + ${offsetMs} * INTERVAL '1 millisecond' AS "now"`;
  return row.now;
}

test("guest album views count once per browser and rolling day with current access checks", async t => {
  let userId;
  let main;
  let first;
  let second;
  async function seedEvent(name, settings = {}) {
    const event = await db.event.create({ data: {
      ownerId: userId, title: `View test ${name}`, slug: `${namespace}-${name}`,
      code: randomBytes(4).toString("hex").toUpperCase(), ...settings,
    } });
    eventIds.push(event.id);
    return event;
  }
  try {
    const passwordHash = await argon2.hash("abc", { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const user = await db.user.create({ data: {
      email: `${namespace}@example.invalid`, name: "View test owner", passwordHash,
    } });
    userId = user.id;
    main = await seedEvent("public", { viewCount: baseline, downloadCount: 17n, accessVersion: 7, mediaVersion: 9 });

    await t.test("SSR, prefetch, GET metadata and empty photo pagination establish no views", async () => {
      const before = await state(main.id);
      const landing = await request(`/e/${main.slug}`);
      assert.equal(landing.status, 200);
      assert.match(await landing.text(), /View test public/);
      const prefetch = await request(`/e/${main.slug}`, { headers: { "next-router-prefetch": "1", purpose: "prefetch" } });
      assert.equal(prefetch.status, 200);
      await prefetch.arrayBuffer();
      assert.equal((await request(`/api/albums/${main.slug}`)).status, 200);
      first = await visitor(main);
      const refreshed = await request(`/api/albums/${main.slug}/photos`, { cookie: first.cookie });
      assert.equal(refreshed.status, 200);
      assert.equal(responseCookie(refreshed, "partyphoto_visitor"), undefined);
      assert.equal((await request(`/api/albums/${main.slug}/photos?cursor=`)).status, 200);
      assert.equal((await request(`/api/albums/${main.slug}/view`)).status, 405);
      assert.deepEqual(await state(main.id), before);
      assert.equal(await db.albumView.count({ where: { eventId: main.id } }), 0);
    });

    await t.test("origin, bounded strict JSON and visitor cookie failures never count", async () => {
      const before = await state(main.id);
      for (const origin of [null, "null", "https://foreign.example", `${base.origin}/`]) {
        assert.equal((await postView(main, first.cookie, { origin })).status, 403);
      }
      assert.equal((await postView(main, first.cookie, { type: "text/plain" })).status, 415);
      assert.equal((await postView(main, first.cookie, { raw: "x".repeat(8193) })).status, 413);
      assert.equal((await postView(main, first.cookie, { raw: "{" })).status, 400);
      for (const data of [null, [], "view", { counted: true }, { visitorHash: first.visitorHash }]) {
        assert.equal((await postView(main, first.cookie, { data })).status, 400);
      }
      for (const cookie of [undefined, "partyphoto_visitor=invalid", `partyphoto_visitor=${"a".repeat(63)}`, `partyphoto_visitor=${"A".repeat(64)}`]) {
        assert.equal((await postView(main, cookie)).status, 409);
      }
      assert.deepEqual(await state(main.id), before);
      assert.equal(await db.albumView.count({ where: { eventId: main.id } }), 0);
    });

    await t.test("simultaneous first visits to an empty album increment the BigInt total once", async () => {
      const before = await state(main.id);
      const responses = await Promise.all(Array.from({ length: 8 }, () => postView(main, first.cookie)));
      for (const response of responses) assert.equal(response.status, 200, await response.clone().text());
      const results = await Promise.all(responses.map(response => response.json()));
      assert.equal(results.filter(result => result.counted).length, 1);
      assert.ok(results.every(result => Object.keys(result).join() === "counted" && typeof result.counted === "boolean"));
      const stored = await db.albumView.findUniqueOrThrow({ where: { eventId_visitorHash: { eventId: main.id, visitorHash: first.visitorHash } } });
      assert.equal(stored.visitorHash, first.visitorHash);
      assert.equal(await db.photo.count({ where: { eventId: main.id } }), 0);
      assert.equal((await state(main.id)).viewCount, baseline + 1n);
      await expectCounted(await postView(main, first.cookie), false);
      const refreshed = await db.albumView.findUniqueOrThrow({ where: { eventId_visitorHash: { eventId: main.id, visitorHash: first.visitorHash } } });
      assert.equal(refreshed.lastCountedAt.getTime(), stored.lastCountedAt.getTime());
      assert.deepEqual(await state(main.id), { ...before, viewCount: before.viewCount + 1n });
    });

    await t.test("different browser cookies and different albums count independently", async () => {
      second = await visitor(main);
      assert.notEqual(second.visitorHash, first.visitorHash);
      await expectCounted(await postView(main, second.cookie), true);
      await expectCounted(await postView(main, second.cookie), false);
      assert.equal((await state(main.id)).viewCount, baseline + 2n);
      assert.equal(await db.albumView.count({ where: { eventId: main.id } }), 2);
      const other = await seedEvent("other");
      await expectCounted(await postView(other, first.cookie), true);
      await expectCounted(await postView(other, first.cookie), false);
      assert.equal((await state(other.id)).viewCount, 1n);
      assert.equal((await state(main.id)).viewCount, baseline + 2n);
    });

    await t.test("only a full rolling 24 hours renews the timestamp and total", async () => {
      const key = { eventId_visitorHash: { eventId: main.id, visitorHash: first.visitorHash } };
      const recent = await timestamp(-23 * 60 * 60 * 1000);
      await db.albumView.update({ where: key, data: { lastCountedAt: recent } });
      await expectCounted(await postView(main, first.cookie), false);
      assert.equal((await db.albumView.findUniqueOrThrow({ where: key })).lastCountedAt.getTime(), recent.getTime());
      const old = await timestamp(-24 * 60 * 60 * 1000 - 1000);
      await db.albumView.update({ where: key, data: { lastCountedAt: old } });
      const responses = await Promise.all(Array.from({ length: 4 }, () => postView(main, first.cookie)));
      for (const response of responses) assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await Promise.all(responses.map(response => response.json()))).filter(result => result.counted).length, 1);
      const renewed = await db.albumView.findUniqueOrThrow({ where: key });
      assert.ok(renewed.lastCountedAt.getTime() > recent.getTime());
      await expectCounted(await postView(main, first.cookie), false);
      assert.equal((await db.albumView.findUniqueOrThrow({ where: key })).lastCountedAt.getTime(), renewed.lastCountedAt.getTime());
      assert.equal((await state(main.id)).viewCount, baseline + 3n);
    });

    await t.test("private albums require a current scoped grant, including on repeated visits", async () => {
      const album = await seedEvent("private", { passwordHash, allowDownloads: false, allowGuestUploads: false });
      const otherPrivate = await seedEvent("private-other", { passwordHash });
      assert.equal((await postView(album, first.cookie)).status, 401);
      assert.equal((await postView(album, `${first.cookie}; partyphoto_event_${album.id}=forged`)).status, 401);
      assert.equal((await postView(album, `${first.cookie}; partyphoto_event_${album.id}=${randomBytes(32).toString("hex")}`)).status, 401);
      assert.equal((await request(`/api/albums/${album.slug}/unlock`, { method: "POST", data: { password: "xyz" } })).status, 401);
      assert.equal((await state(album.id)).viewCount, 0n);
      assert.equal(await db.albumView.count({ where: { eventId: album.id } }), 0);
      const unlock = await request(`/api/albums/${album.slug}/unlock`, { method: "POST", data: { password: "abc" } });
      assert.equal(unlock.status, 200, await unlock.clone().text());
      const grant = responseCookie(unlock, `partyphoto_event_${album.id}`);
      assert.ok(grant);
      const access = `${first.cookie}; ${grant}`;
      await expectCounted(await postView(album, access), true);
      assert.equal((await state(album.id)).viewCount, 1n);
      // Renaming the cookie cannot extend a grant to another album.
      assert.equal((await postView(otherPrivate, `${first.cookie}; partyphoto_event_${otherPrivate.id}=${grant.split("=")[1]}`)).status, 401);
      const tokenHash = hash(grant.split("=")[1]);
      await db.accessToken.update({ where: { tokenHash }, data: { expiresAt: new Date(0) } });
      assert.equal((await postView(album, access)).status, 401);
      await db.accessToken.update({ where: { tokenHash }, data: { expiresAt: await timestamp(3600000) } });
      await db.event.update({ where: { id: album.id }, data: { accessVersion: { increment: 1 } } });
      assert.equal((await postView(album, access)).status, 401);
      assert.equal((await state(album.id)).viewCount, 1n);
      const fresh = await request(`/api/albums/${album.slug}/unlock`, { method: "POST", data: { password: "abc" } });
      assert.equal(fresh.status, 200);
      await expectCounted(await postView(album, `${first.cookie}; ${responseCookie(fresh, `partyphoto_event_${album.id}`)}`), false);
      assert.equal((await state(otherPrivate.id)).viewCount, 0n);
    });

    await t.test("expired, deleted and missing albums reject views without touching totals", async () => {
      const expired = await seedEvent("expired", { expiresAt: new Date(0), viewCount: 41n });
      const deleted = await seedEvent("deleted", { deletedAt: new Date(), viewCount: 42n });
      for (const album of [expired, deleted]) {
        const before = await state(album.id);
        assert.equal((await postView(album, first.cookie)).status, 404);
        assert.deepEqual(await state(album.id), before);
        assert.equal(await db.albumView.count({ where: { eventId: album.id } }), 0);
      }
      assert.equal((await postView({ slug: `${namespace}-missing` }, first.cookie)).status, 404);
    });

    await t.test("shared visitor and album rate limits reject counting until their windows reset", async () => {
      const album = await seedEvent("limited");
      const identity = await visitor(album);
      const visitorKey = `view:visitor:${identity.visitorHash}`;
      const eventKey = `view:event:${album.id}`;
      const resetAt = await timestamp(60000);
      await db.authRateLimit.upsert({ where: { key: visitorKey }, create: { key: visitorKey, attempts: 120, resetAt }, update: { attempts: 120, resetAt } });
      let limited = await postView(album, identity.cookie);
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get("retry-after")) > 0);
      assert.equal((await state(album.id)).viewCount, 0n);
      await db.authRateLimit.delete({ where: { key: visitorKey } });
      await db.authRateLimit.upsert({ where: { key: eventKey }, create: { key: eventKey, attempts: 3600, resetAt }, update: { attempts: 3600, resetAt } });
      limited = await postView(album, identity.cookie);
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get("retry-after")) > 0);
      assert.equal(await db.albumView.count({ where: { eventId: album.id } }), 0);
      await db.authRateLimit.updateMany({ where: { key: { in: [visitorKey, eventKey] } }, data: { resetAt: new Date(0) } });
      await expectCounted(await postView(album, identity.cookie), true);
      assert.equal((await state(album.id)).viewCount, 1n);
      assert.equal((await db.authRateLimit.findUniqueOrThrow({ where: { key: visitorKey } })).attempts, 1);
      assert.equal((await db.authRateLimit.findUniqueOrThrow({ where: { key: eventKey } })).attempts, 1);
    });

    await t.test("rate-limit retention removes only expired view keys and preserves totals", async () => {
      const album = await seedEvent("rate-retention", { viewCount: 15n });
      const expiredHash = hash(`visitor:${randomBytes(32).toString("hex")}`);
      const activeHash = hash(`visitor:${randomBytes(32).toString("hex")}`);
      visitorHashes.add(expiredHash);
      visitorHashes.add(activeHash);
      const expiredVisitorKey = `view:visitor:${expiredHash}`;
      const expiredEventKey = `view:event:${album.id}`;
      const activeKey = `view:visitor:${activeHash}`;
      const unrelatedKey = `test:views:${namespace}`;
      extraRateKeys.push(unrelatedKey);
      const resetAt = await timestamp(60000);
      await db.authRateLimit.createMany({ data: [
        { key: expiredVisitorKey, attempts: 9, resetAt: new Date(0) },
        { key: expiredEventKey, attempts: 11, resetAt: new Date(0) },
        { key: activeKey, attempts: 7, resetAt },
        { key: unrelatedKey, attempts: 8, resetAt: new Date(0) },
      ] });
      const before = await state(album.id);
      await pruneViewRateLimits(db);
      assert.equal(await db.authRateLimit.findUnique({ where: { key: expiredVisitorKey } }), null);
      assert.equal(await db.authRateLimit.findUnique({ where: { key: expiredEventKey } }), null);
      assert.deepEqual(await db.authRateLimit.findUniqueOrThrow({ where: { key: activeKey } }), { key: activeKey, attempts: 7, resetAt });
      assert.deepEqual(await db.authRateLimit.findUniqueOrThrow({ where: { key: unrelatedKey } }), { key: unrelatedKey, attempts: 8, resetAt: new Date(0) });
      assert.deepEqual(await state(album.id), before);
    });

    await t.test("retention removes old identities, preserves aggregate totals and permits a renewed visit", async () => {
      const album = await seedEvent("retention", { viewCount: baseline, downloadCount: 5n, mediaVersion: 12, accessVersion: 13 });
      const old = await timestamp(-24 * 60 * 60 * 1000 - 1000);
      const recent = await timestamp(-24 * 60 * 60 * 1000 + 60000);
      await db.albumView.createMany({ data: [
        { eventId: album.id, visitorHash: first.visitorHash, lastCountedAt: old },
        { eventId: album.id, visitorHash: second.visitorHash, lastCountedAt: recent },
      ] });
      const before = await state(album.id);
      await pruneAlbumViews(db);
      assert.equal(await db.albumView.count({ where: { eventId: album.id } }), 1);
      assert.equal(await db.albumView.findUnique({ where: { eventId_visitorHash: { eventId: album.id, visitorHash: first.visitorHash } } }), null);
      assert.equal((await db.albumView.findUniqueOrThrow({ where: { eventId_visitorHash: { eventId: album.id, visitorHash: second.visitorHash } } })).lastCountedAt.getTime(), recent.getTime());
      assert.deepEqual(await state(album.id), before);
      await expectCounted(await postView(album, first.cookie), true);
      await expectCounted(await postView(album, second.cookie), false);
      await pruneAlbumViews(db);
      await pruneAlbumViews(db);
      assert.equal(await db.albumView.count({ where: { eventId: album.id } }), 2);
      assert.deepEqual(await state(album.id), { ...before, viewCount: before.viewCount + 1n });
      await db.event.delete({ where: { id: album.id } });
      assert.equal(await db.albumView.count({ where: { eventId: album.id } }), 0);
    });
  } finally {
    await db.accessToken.deleteMany({ where: { eventId: { in: eventIds } } });
    await db.event.deleteMany({ where: { id: { in: eventIds } } });
    if (userId) await db.user.delete({ where: { id: userId } });
    await db.authRateLimit.deleteMany({ where: { key: { in: [
      ...Array.from(visitorHashes, value => `view:visitor:${value}`),
      ...eventIds.flatMap(eventId => [`view:event:${eventId}`, `album:unlock:${eventId}`]),
      ...extraRateKeys,
    ] } } });
    await db.$disconnect();
  }
});
