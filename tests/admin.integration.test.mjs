import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { bootstrapAdmin } from "../scripts/admin-bootstrap-helper.mjs";

// Only this run's example.invalid users and albums are mutated or removed.
const base = new URL(process.env.AUTH_TEST_URL ?? process.env.APP_URL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) || base.protocol !== "http:") {
  throw new Error("Admin integration tests require a local HTTP dev server");
}
const db = new PrismaClient();
const namespace = `admin-check-${randomUUID()}`;
const identities = [];
const eventIds = [];
const hash = value => createHash("sha256").update(value).digest("hex");
const huge = 9007199254740993n;
let passwordHash;

async function request(path, { method = "GET", data, cookie, origin = base.origin, type = "application/json", raw } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (method !== "GET") {
    headers["content-type"] = type;
    if (origin !== null) headers.origin = origin;
  }
  return fetch(new URL(path, base), {
    method, headers, body: raw ?? (data === undefined ? undefined : JSON.stringify(data)),
    redirect: "manual", signal: AbortSignal.timeout(15000),
  });
}
const patch = (user, data, cookie, options = {}) => request(`/api/admin/users/${user.id}`, { method: "PATCH", data, cookie, ...options });
const me = cookie => request("/api/auth/me", { cookie });
const cookieFrom = response => response.headers.getSetCookie().find(value => value.startsWith("partyphoto_session="))?.split(";")[0];

async function seedUser(name, role = "ORGANIZER", settings = {}) {
  const tokens = Array.from({ length: 2 }, () => randomBytes(32).toString("hex"));
  const user = await db.user.create({ data: {
    email: `${namespace}-${name}@example.invalid`, name: `Admin fixture ${name}`, role, passwordHash,
    ...settings, sessions: { create: tokens.map(token => ({ tokenHash: hash(token), expiresAt: new Date(Date.now() + 3600000) })) },
  }, select: { id: true, email: true, name: true, role: true } });
  const fixture = { ...user, cookie: `partyphoto_session=${tokens[0]}`, cookies: tokens.map(token => `partyphoto_session=${token}`) };
  identities.push(fixture);
  return fixture;
}

async function seedEvent(owner, name, settings = {}) {
  const event = await db.event.create({ data: {
    ownerId: owner.id, title: `${namespace}-event-${name}`, slug: `${namespace}-event-${name}`,
    code: randomBytes(4).toString("hex").toUpperCase(), ...settings,
  } });
  eventIds.push(event.id);
  return event;
}

async function seedResetToken(user) {
  await db.passwordResetToken.upsert({ where: { userId: user.id },
    create: { userId: user.id, tokenHash: hash(randomBytes(32)), expiresAt: new Date(Date.now() + 3600000) },
    update: { tokenHash: hash(randomBytes(32)), expiresAt: new Date(Date.now() + 3600000) },
  });
}

function assertNoSecrets(value) {
  const serialized = JSON.stringify(value);
  for (const forbidden of ["passwordHash", "tokenHash", "originalKey", "thumbnailKey", "$argon2", "S3_SECRET"]) {
    assert.equal(serialized.includes(forbidden), false, `Admin DTO must not contain ${forbidden}`);
  }
}

async function json(response, status = 200) {
  assert.equal(response.status, status, "Unexpected admin response status");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assertNoSecrets(body);
  return body;
}

async function signIn(user, password) {
  const response = await request("/api/auth/login", { method: "POST", data: { email: user.email, password } });
  assert.equal(response.status, 200);
  return cookieFrom(response);
}

async function waitForWaiter(blockerPid) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [row] = await db.$queryRaw`
      SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${blockerPid} = ANY(pg_blocking_pids("pid"))) AS "waiting"
    `;
    if (row.waiting) return;
    await delay(20);
  }
  assert.fail("Admin mutation did not reach the isolated User lock within the bounded wait");
}

test("service administration permissions, queries and account changes over HTTP and PostgreSQL", async t => {
  const password = `fixture-${randomUUID()}`;
  let admin;
  let organizer;
  let photographer;
  try {
    passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    admin = await seedUser("actor", "ADMIN");
    organizer = await seedUser("organizer");
    photographer = await seedUser("photographer", "PHOTOGRAPHER");

    await t.test("all admin endpoints require an active administrator session", async () => {
      const disabled = await seedUser("disabled-admin", "ADMIN", { disabledAt: new Date() });
      const expired = await seedUser("expired-admin", "ADMIN");
      await db.session.updateMany({ where: { userId: expired.id }, data: { expiresAt: new Date(0) } });
      for (const path of ["/api/admin/overview", "/api/admin/users", "/api/admin/events"]) {
        await json(await request(path), 401);
        await json(await request(path, { cookie: organizer.cookie }), 403);
        await json(await request(path, { cookie: photographer.cookie }), 403);
        await json(await request(path, { cookie: disabled.cookie }), 401);
        await json(await request(path, { cookie: expired.cookie }), 401);
      }
      await json(await patch(organizer, { role: "ADMIN" }), 401);
      await json(await patch(organizer, { role: "ADMIN" }, photographer.cookie), 403);
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: organizer.id }, select: { role: true } })).role, "ORGANIZER");
    });

    await t.test("filtered users and albums paginate at twenty and expose only public admin fields", async () => {
      const pageUsers = [];
      for (let index = 0; index < 23; index++) pageUsers.push(await seedUser(`page-${index}`));
      const query = encodeURIComponent(`${namespace}-page-`.toUpperCase());
      const first = await json(await request(`/api/admin/users?q=${query}&page=1`, { cookie: admin.cookie }));
      const second = await json(await request(`/api/admin/users?q=${query}&page=2`, { cookie: admin.cookie }));
      assert.equal(first.total, 23); assert.equal(first.page, 1); assert.equal(first.pageSize, 20); assert.equal(first.users.length, 20);
      assert.equal(second.total, 23); assert.equal(second.page, 2); assert.equal(second.pageSize, 20); assert.equal(second.users.length, 3);
      assert.deepEqual(new Set([...first.users, ...second.users].map(user => user.id)), new Set(pageUsers.map(user => user.id)));
      for (const user of [...first.users, ...second.users]) {
        assert.deepEqual(Object.keys(user).sort(), ["createdAt", "disabledAt", "email", "id", "name", "ownedEventCount", "role"]);
        assert.equal(user.ownedEventCount, 0);
      }
      const events = [];
      for (let index = 0; index < 23; index++) events.push(await seedEvent(organizer, `page-${index}`));
      const eventQuery = encodeURIComponent(`${namespace}-event-page-`.toUpperCase());
      const page1 = await json(await request(`/api/admin/events?q=${eventQuery}`, { cookie: admin.cookie }));
      const page2 = await json(await request(`/api/admin/events?q=${eventQuery}&page=2`, { cookie: admin.cookie }));
      assert.equal(page1.total, 23); assert.equal(page1.page, 1); assert.equal(page1.pageSize, 20); assert.equal(page1.events.length, 20);
      assert.equal(page2.events.length, 3);
      assert.deepEqual(new Set([...page1.events, ...page2.events].map(event => event.id)), new Set(events.map(event => event.id)));
      for (const event of [...page1.events, ...page2.events]) {
        assert.deepEqual(event.owner, { id: organizer.id, name: organizer.name, email: organizer.email });
        assert.equal(event.photoCount, 0);
      }
      const ownUser = await json(await request(`/api/admin/users?q=${encodeURIComponent(organizer.email)}`, { cookie: admin.cookie }));
      assert.equal(ownUser.users.length, 1); assert.equal(ownUser.users[0].ownedEventCount, 23);
      for (const path of ["/api/admin/users", "/api/admin/events"]) {
        for (const page of ["0", "-1", "x", "1.5"]) await json(await request(`${path}?page=${page}`, { cookie: admin.cookie }), 400);
      }
    });

    await t.test("overview counts fixtures and preserves BigInt storage/view/download precision", async () => {
      const event = await seedEvent(organizer, "bigint", {
        usedStorageBytes: huge, reservedBytes: huge + 2n, viewCount: huge + 4n, downloadCount: huge + 6n,
      });
      await db.photo.createMany({ data: ["PUBLISHED", "HIDDEN"].map((status, index) => ({
        eventId: event.id, filename: `fixture-${index}.jpg`, originalKey: `${namespace}/virtual-${index}`, mimeType: "image/jpeg", sizeBytes: 1n, status,
      })) });
      await db.mediaJob.createMany({ data: ["QUEUED", "RUNNING", "FAILED"].map(status => ({
        eventId: event.id, kind: "THUMBNAIL", status, dedupeKey: `${namespace}:${status}`, payload: {},
        availableAt: new Date(Date.now() + 3600000), lockedUntil: status === "RUNNING" ? new Date(Date.now() + 3600000) : null,
      })) });
      const deleted = await seedEvent(organizer, "deleted", {
        deletedAt: new Date(), usedStorageBytes: huge + 1n, reservedBytes: huge + 3n,
        viewCount: huge + 5n, downloadCount: huge + 7n,
      });
      const { overview } = await json(await request("/api/admin/overview", { cookie: admin.cookie }));
      for (const name of ["usersCount", "activeUsersCount", "eventsCount", "photosCount", "activeSessionsCount"]) {
        assert.equal(Number.isSafeInteger(overview[name]), true);
      }
      assert.ok(overview.usersCount >= identities.length);
      assert.ok(overview.activeUsersCount >= identities.length - 1);
      assert.ok(overview.eventsCount >= eventIds.length - 1);
      assert.ok(overview.photosCount >= 2);
      assert.ok(overview.activeSessionsCount >= 2 * (identities.length - 2));
      for (const [name, minimum] of [["usedStorageBytes", huge], ["reservedStorageBytes", huge + 2n], ["viewCount", huge + 4n], ["downloadCount", huge + 6n]]) {
        assert.equal(typeof overview[name], "string"); assert.ok(BigInt(overview[name]) >= minimum);
      }
      for (const name of ["queued", "running", "failed"]) assert.ok(overview.mediaJobs[name] >= 1);
      const totals = await db.event.aggregate({ where: { deletedAt: null }, _sum: {
        usedStorageBytes: true, reservedBytes: true, viewCount: true, downloadCount: true,
      } });
      assert.equal(overview.usedStorageBytes, (totals._sum.usedStorageBytes ?? 0n).toString());
      assert.equal(overview.reservedStorageBytes, (totals._sum.reservedBytes ?? 0n).toString());
      assert.equal(overview.viewCount, (totals._sum.viewCount ?? 0n).toString());
      assert.equal(overview.downloadCount, (totals._sum.downloadCount ?? 0n).toString());
      const listed = await json(await request(`/api/admin/events?q=${encodeURIComponent(event.slug)}`, { cookie: admin.cookie }));
      assert.equal(listed.events.length, 1);
      assert.equal(listed.events[0].usedStorageBytes, huge.toString());
      assert.equal(listed.events[0].viewCount, (huge + 4n).toString());
      assert.equal(listed.events[0].downloadCount, (huge + 6n).toString());
      assert.equal(listed.events[0].photoCount, 2);
      const hiddenEvent = await json(await request(`/api/admin/events?q=${encodeURIComponent(deleted.slug)}`, { cookie: admin.cookie }));
      assert.equal(hiddenEvent.total, 0);
      const owner = await json(await request(`/api/admin/users?q=${encodeURIComponent(organizer.email)}`, { cookie: admin.cookie }));
      assert.equal(owner.users[0].ownedEventCount, 24);
    });

    await t.test("strict mutation input, CSRF and self changes cannot modify accounts", async () => {
      for (const origin of [null, "null", "https://foreign.example", `${base.origin}/`]) {
        await json(await patch(organizer, { role: "ADMIN" }, admin.cookie, { origin }), 403);
      }
      await json(await patch(organizer, {}, admin.cookie, { type: "text/plain" }), 415);
      await json(await patch(organizer, {}, admin.cookie, { raw: "x".repeat(8193) }), 413);
      await json(await patch(organizer, {}, admin.cookie, { raw: "{" }), 400);
      for (const data of [null, [], {}, { role: "OWNER" }, { disabled: "true" }, { role: "ADMIN", name: "Injected" }]) {
        await json(await patch(organizer, data, admin.cookie), 400);
      }
      for (const data of [{ role: "ADMIN" }, { role: "ORGANIZER" }, { disabled: true }, { disabled: false }]) {
        await json(await patch(admin, data, admin.cookie), 400);
      }
      await json(await patch({ id: `${namespace}-missing` }, { role: "ADMIN" }, admin.cookie), 404);
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: admin.id }, select: { role: true, disabledAt: true } })).role, "ADMIN");
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: organizer.id }, select: { role: true } })).role, "ORGANIZER");
    });

    await t.test("no-op settings preserve all sessions and the existing recovery token", async () => {
      const user = await seedUser("no-op");
      await seedResetToken(user);
      const before = await db.passwordResetToken.findUniqueOrThrow({ where: { userId: user.id }, select: { tokenHash: true } });
      const updated = await json(await patch(user, { role: "ORGANIZER", disabled: false }, admin.cookie));
      assert.equal(updated.user.role, "ORGANIZER"); assert.equal(updated.user.disabledAt, null);
      assert.equal(await db.session.count({ where: { userId: user.id } }), 2);
      const after = await db.passwordResetToken.findUniqueOrThrow({ where: { userId: user.id }, select: { tokenHash: true } });
      assert.equal(after.tokenHash === before.tokenHash, true);
      for (const cookie of user.cookies) assert.equal((await me(cookie)).status, 200);
    });

    await t.test("promotion, demotion, blocking and unblocking revoke sessions/tokens but preserve credentials and albums", async () => {
      const user = await seedUser("changes");
      const event = await seedEvent(user, "preserved", { description: "Original description", viewCount: 13n, downloadCount: 17n });
      const initial = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { passwordHash: true, email: true, name: true } });
      await seedResetToken(user);
      let changed = await json(await patch(user, { role: "ADMIN" }, admin.cookie));
      assert.equal(changed.user.role, "ADMIN");
      assert.equal(await db.session.count({ where: { userId: user.id } }), 0);
      assert.equal(await db.passwordResetToken.count({ where: { userId: user.id } }), 0);
      for (const cookie of user.cookies) assert.equal((await me(cookie)).status, 401);
      let signedIn = await signIn(user, password);
      await json(await request("/api/admin/overview", { cookie: signedIn }));
      await seedResetToken(user);
      changed = await json(await patch(user, { role: "PHOTOGRAPHER" }, admin.cookie));
      assert.equal(changed.user.role, "PHOTOGRAPHER");
      assert.equal((await me(signedIn)).status, 401);
      assert.equal(await db.passwordResetToken.count({ where: { userId: user.id } }), 0);
      signedIn = await signIn(user, password);
      await json(await request("/api/admin/overview", { cookie: signedIn }), 403);
      await seedResetToken(user);
      changed = await json(await patch(user, { disabled: true }, admin.cookie));
      assert.ok(changed.user.disabledAt);
      assert.equal((await me(signedIn)).status, 401);
      assert.equal(await db.session.count({ where: { userId: user.id } }), 0);
      assert.equal(await db.passwordResetToken.count({ where: { userId: user.id } }), 0);
      assert.equal((await request("/api/auth/login", { method: "POST", data: { email: user.email, password } })).status, 401);
      changed = await json(await patch(user, { role: "ORGANIZER", disabled: false }, admin.cookie));
      assert.equal(changed.user.disabledAt, null); assert.equal(changed.user.role, "ORGANIZER");
      signedIn = await signIn(user, password);
      assert.equal((await me(signedIn)).status, 200);
      const after = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { passwordHash: true, email: true, name: true } });
      assert.equal(after.passwordHash === initial.passwordHash, true);
      assert.equal(await argon2.verify(after.passwordHash, password), true);
      assert.equal(after.email, initial.email); assert.equal(after.name, initial.name);
      assert.deepEqual(await db.event.findUniqueOrThrow({ where: { id: event.id } }), event);
    });

    await t.test("mutual concurrent demotions allow only one still-authorized administrator to act", async () => {
      const first = await seedUser("mutual-a", "ADMIN");
      const second = await seedUser("mutual-b", "ADMIN");
      const responses = await Promise.all([
        patch(second, { role: "ORGANIZER" }, first.cookie), patch(first, { role: "ORGANIZER" }, second.cookie),
      ]);
      assert.equal(responses.filter(response => response.status === 200).length, 1);
      assert.equal(responses.filter(response => [401, 403].includes(response.status)).length, 1);
      for (const response of responses) await json(response, response.status);
      const stored = await db.user.findMany({ where: { id: { in: [first.id, second.id] } }, select: { id: true, role: true } });
      assert.deepEqual(stored.map(user => user.role).sort(), ["ADMIN", "ORGANIZER"]);
      const winner = stored.find(user => user.role === "ADMIN");
      const loser = [first, second].find(user => user.id !== winner.id);
      assert.equal(await db.session.count({ where: { userId: loser.id } }), 0);
      assert.equal((await me(loser.cookie)).status, 401);
      await json(await request("/api/admin/overview", { cookie: admin.cookie }));
    });

    await t.test("an actor demoted while its mutation waits cannot change another account", async () => {
      const actor = await seedUser("stale-actor", "ADMIN");
      const target = await seedUser("stale-target");
      let pending;
      try {
        await db.$transaction(async tx => {
          await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actor.id} FOR UPDATE`;
          const [connection] = await tx.$queryRaw`SELECT pg_backend_pid() AS "pid"`;
          pending = patch(target, { role: "PHOTOGRAPHER" }, actor.cookie).then(response => ({ response }), error => ({ error }));
          await waitForWaiter(connection.pid);
          // Keep the existing session to distinguish fresh role checks from token revocation.
          await tx.user.update({ where: { id: actor.id }, data: { role: "ORGANIZER" } });
        }, { maxWait: 5000, timeout: 10000 });
        const result = await pending;
        assert.equal(Boolean(result.error), false, "Waiting request must finish after the isolated User lock is released");
        await json(result.response, 403);
        assert.equal((await db.user.findUniqueOrThrow({ where: { id: target.id }, select: { role: true } })).role, "ORGANIZER");
        assert.equal(await db.session.count({ where: { userId: target.id } }), 2);
        const profile = await json(await me(actor.cookie));
        assert.equal(profile.user.role, "ORGANIZER");
        await json(await request("/api/admin/users", { cookie: actor.cookie }), 403);
      } finally { await pending; }
    });

    await t.test("explicit bootstrap promotes only active existing accounts and repeat issuance preserves new sessions", async () => {
      const user = await seedUser("bootstrap");
      const event = await seedEvent(user, "bootstrap-preserved");
      await seedResetToken(user);
      const before = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { passwordHash: true, email: true, name: true } });
      assert.deepEqual(await bootstrapAdmin(db, `  ${user.email.toUpperCase()}  `), { email: user.email, role: "ADMIN", changed: true });
      assert.equal(await db.session.count({ where: { userId: user.id } }), 0);
      assert.equal(await db.passwordResetToken.count({ where: { userId: user.id } }), 0);
      for (const cookie of user.cookies) assert.equal((await me(cookie)).status, 401);
      const after = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { passwordHash: true, email: true, name: true } });
      assert.equal(after.passwordHash === before.passwordHash, true);
      assert.equal(after.email, before.email); assert.equal(after.name, before.name);
      assert.deepEqual(await db.event.findUniqueOrThrow({ where: { id: event.id } }), event);
      const signedIn = await signIn(user, password);
      await seedResetToken(user);
      assert.deepEqual(await bootstrapAdmin(db, user.email), { email: user.email, role: "ADMIN", changed: false });
      assert.equal((await me(signedIn)).status, 200);
      assert.equal(await db.passwordResetToken.count({ where: { userId: user.id } }), 1);
      const disabled = await seedUser("bootstrap-disabled", "ORGANIZER", { disabledAt: new Date() });
      await assert.rejects(() => bootstrapAdmin(db, disabled.email));
      await assert.rejects(() => bootstrapAdmin(db, `${namespace}-missing@example.invalid`));
      await assert.rejects(() => bootstrapAdmin(db, "not-an-email"));
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: disabled.id }, select: { role: true } })).role, "ORGANIZER");
    });
  } finally {
    const userIds = identities.map(user => user.id);
    await db.photo.deleteMany({ where: { eventId: { in: eventIds } } });
    await db.mediaJob.deleteMany({ where: { eventId: { in: eventIds } } });
    await db.accessToken.deleteMany({ where: { eventId: { in: eventIds } } });
    await db.eventMember.deleteMany({ where: { eventId: { in: eventIds } } });
    await db.event.deleteMany({ where: { id: { in: eventIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.authRateLimit.deleteMany({ where: { key: { in: identities.map(user => `auth:login:${hash(user.email)}`) } } });
    await db.$disconnect();
  }
});
