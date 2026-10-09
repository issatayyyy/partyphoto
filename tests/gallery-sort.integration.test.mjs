import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

// Listing needs PostgreSQL only: no files are uploaded to S3 by these fixtures.
const base = new URL(process.env.AUTH_TEST_URL ?? process.env.APP_URL);
const database = new URL(process.env.DATABASE_URL);
const localHosts = ["localhost", "127.0.0.1", "[::1]"];
if (!localHosts.includes(base.hostname) || base.protocol !== "http:" || !localHosts.includes(database.hostname)) {
  throw new Error("Gallery sorting integration tests require a local HTTP server and PostgreSQL database");
}
const db = new PrismaClient();
const namespace = `sort-check-${randomUUID()}`;
const hash = value => createHash("sha256").update(value).digest("hex");

async function request(path, cookie) {
  return fetch(new URL(path, base), { headers: cookie ? { cookie } : {}, redirect: "manual" });
}

async function readPage(path, cookie) {
  const response = await request(path, cookie);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json();
}

async function readAll(path, sort, cookie, totalCount) {
  const all = [];
  let cursor;
  let pages = 0;
  do {
    const query = new URLSearchParams({ sort });
    if (cursor) query.set("cursor", cursor);
    const page = await readPage(`${path}?${query}`, cookie);
    assert.equal(page.totalCount, totalCount);
    assert.ok(page.photos.length <= 40);
    all.push(...page.photos);
    cursor = page.nextCursor;
    assert.ok(++pages <= 4, "Pagination must reach the end of this small fixture");
    if (cursor) {
      assert.equal(page.photos.length, 40);
      assert.equal(cursor, page.photos.at(-1).id);
    }
  } while (cursor);
  assert.equal(all.length, totalCount);
  assert.equal(new Set(all.map(photo => photo.id)).size, totalCount, "Pages must not repeat photos");
  return all;
}

test("gallery sorting ranks the whole accessible album with stable pagination and access checks", async t => {
  const userIds = [];
  const eventIds = [];
  const cookies = [];
  let event;
  let otherEvent;
  let lockedEvent;
  const photos = [];
  const guestToken = randomBytes(32).toString("hex");
  const guestCookie = `partyphoto_visitor=${guestToken}`;
  const guestVoter = hash(`visitor:${guestToken}`);
  try {
    for (const label of ["owner", "other"]) {
      const token = randomBytes(32).toString("hex");
      const user = await db.user.create({ data: {
        email: `${namespace}-${label}@example.invalid`, name: `Sort ${label}`, passwordHash: "unused-fixture-password",
        sessions: { create: { tokenHash: hash(token), expiresAt: new Date(Date.now() + 3600000) } },
      } });
      userIds.push(user.id);
      cookies.push(`partyphoto_session=${token}`);
    }
    for (const label of ["public", "other", "locked"]) {
      const item = await db.event.create({ data: {
        ownerId: label === "other" ? userIds[1] : userIds[0], title: `Sort ${label}`,
        slug: `${namespace}-${label}`, code: randomBytes(4).toString("hex").toUpperCase(),
        ...(label === "locked" ? { passwordHash: "unused-fixture-password" } : {}),
      } });
      eventIds.push(item.id);
      if (label === "public") event = item;
      if (label === "other") otherEvent = item;
      if (label === "locked") lockedEvent = item;
    }
    for (let index = 0; index < 91; index++) {
      const id = `${namespace}-${String(index).padStart(3, "0")}`;
      // 86 visible photos span three pages. Oldest two have most likes;
      // tied dates and 0/1 likes straddle the pagination boundaries.
      const createdAt = new Date(Date.UTC(2025, 0, 1) - Math.floor(index / 4) * 1000);
      const status = index < 86 ? "PUBLISHED" : ["HIDDEN", "PENDING", "DELETING", "PROCESSING", "PUBLISHED"][index - 86];
      const photo = await db.photo.create({ data: {
        id, eventId: index === 90 ? otherEvent.id : event.id, filename: `sort-${index}.jpg`,
        originalKey: `${namespace}/${index}.jpg`, mimeType: "image/jpeg", sizeBytes: 1n, status, createdAt,
      } });
      const likeCount = index >= 86 ? 12 : index === 85 ? 9 : index === 84 ? 5 : index % 2;
      await db.photoLike.createMany({ data: Array.from({ length: likeCount }, (_, voter) => ({
        photoId: id, voterHash: voter === 0 ? guestVoter : hash(`${namespace}-voter-${voter}`),
      })) });
      photos.push({ ...photo, likeCount });
    }
    const guestPath = `/api/albums/${event.slug}/photos`;
    const staffPath = `/api/events/${event.id}/photos`;
    const published = photos.filter(photo => photo.eventId === event.id && photo.status === "PUBLISHED");
    const byNewest = (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id);
    const byLikes = (a, b) => b.likeCount - a.likeCount || byNewest(a, b);

    await t.test("newest remains the default and old id cursors traverse every visible photo once", async () => {
      const page = await readPage(guestPath, guestCookie);
      assert.equal(page.totalCount, 86);
      assert.equal(page.photos.length, 40);
      const expected = [...published].sort(byNewest).map(photo => photo.id);
      assert.deepEqual(page.photos.map(photo => photo.id), expected.slice(0, 40));
      const legacy = await readPage(`${guestPath}?cursor=${page.nextCursor}`, guestCookie);
      assert.deepEqual(legacy.photos.map(photo => photo.id), expected.slice(40, 80));
      const all = await readAll(guestPath, "newest", guestCookie, 86);
      assert.deepEqual(all.map(photo => photo.id), expected);
    });

    await t.test("likes promotes an old photo beyond page one and breaks ties across pages deterministically", async () => {
      const page = await readPage(`${guestPath}?sort=likes`, guestCookie);
      assert.equal(page.photos[0].id, photos[85].id);
      assert.equal(page.photos[0].likeCount, 9);
      assert.equal(page.photos[0].liked, true);
      assert.equal(page.photos[1].id, photos[84].id);
      const expected = [...published].sort(byLikes).map(photo => photo.id);
      const all = await readAll(guestPath, "likes", guestCookie, 86);
      assert.deepEqual(all.map(photo => photo.id), expected);
      assert.equal(all.filter(photo => photo.likeCount === 0).every(photo => !photo.liked), true);
      const staff = await readAll(staffPath, "likes", cookies[0], 89);
      const expectedStaff = photos.filter(photo => photo.eventId === event.id && photo.status !== "PROCESSING").sort(byLikes);
      assert.deepEqual(staff.map(photo => photo.id), expectedStaff.map(photo => photo.id));
      assert.equal(staff.every(photo => !photo.liked), true, "Staff uses account identity, not the guest voter");
    });

    await t.test("hidden and other-album photos cannot be used as guest cursors", async () => {
      for (const sort of ["newest", "likes"]) {
        for (const anchor of [photos[86], photos[87], photos[88], photos[89], photos[90]]) {
          const response = await request(`${guestPath}?sort=${sort}&cursor=${anchor.id}`, guestCookie);
          assert.equal(response.status, 400);
          assert.equal(Object.hasOwn(await response.json(), "photos"), false);
        }
      }
      assert.equal((await request(`${staffPath}?sort=likes&cursor=${photos[90].id}`, cookies[0])).status, 400);
    });

    await t.test("invalid sorting/cursors fail without exposing a photo page", async () => {
      for (const query of ["sort=popular", "sort=", "sort=likes%20", "sort=likes&cursor=bad%2Fid", "sort=likes&cursor=missing"]) {
        for (const [path, cookie] of [[guestPath, guestCookie], [staffPath, cookies[0]]]) {
          const response = await request(`${path}?${query}`, cookie);
          assert.equal(response.status, 400);
          assert.equal(Object.hasOwn(await response.json(), "photos"), false);
        }
      }
      assert.equal((await request(`${staffPath}?sort=likes`)).status, 401);
      assert.equal((await request(`${staffPath}?sort=likes`, cookies[1])).status, 404);
      const locked = await request(`/api/albums/${lockedEvent.slug}/photos?sort=likes`, guestCookie);
      assert.equal(locked.status, 401);
      assert.equal(Object.hasOwn(await locked.json(), "totalCount"), false);
    });

    await t.test("revoked guest access and expired albums are rechecked on subsequent sorted pages", async () => {
      const page = await readPage(`${guestPath}?sort=likes`, guestCookie);
      await db.event.update({ where: { id: event.id }, data: { passwordHash: "unused-fixture-password", accessVersion: { increment: 1 } } });
      assert.equal((await request(`${guestPath}?sort=likes&cursor=${page.nextCursor}`, guestCookie)).status, 401);
      await db.event.update({ where: { id: event.id }, data: { passwordHash: null, expiresAt: new Date(0) } });
      assert.equal((await request(`${guestPath}?sort=likes&cursor=${page.nextCursor}`, guestCookie)).status, 404);
      await db.event.update({ where: { id: event.id }, data: { expiresAt: null } });
      await db.user.update({ where: { id: userIds[0] }, data: { disabledAt: new Date() } });
      assert.equal((await request(`${staffPath}?sort=likes`, cookies[0])).status, 401);
    });
  } finally {
    await db.photo.deleteMany({ where: { eventId: { in: eventIds } } });
    await db.event.deleteMany({ where: { id: { in: eventIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.$disconnect();
  }
});
