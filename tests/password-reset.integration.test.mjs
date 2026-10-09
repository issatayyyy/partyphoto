import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { issuePasswordReset } from "../scripts/password-reset.mjs";

// These fixtures target the local application/database and never print credentials.
const base = new URL(process.env.AUTH_TEST_URL ?? process.env.APP_URL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) || base.protocol !== "http:") {
  throw new Error("Password-reset integration tests require a local HTTP dev server");
}
const db = new PrismaClient();
const namespace = `reset-check-${randomUUID()}`;
const users = [];
const tokenHashes = new Set();
const extraRateKeys = [];
const hash = value => createHash("sha256").update(value).digest("hex");
const options = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

async function post(path, data, { cookie, origin = base.origin, type = "application/json", raw } = {}) {
  const headers = { "content-type": type };
  if (origin !== null) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  return fetch(new URL(path, base), {
    method: "POST", headers, body: raw ?? JSON.stringify(data), redirect: "manual", signal: AbortSignal.timeout(15000),
  });
}
const reset = (token, password, overrides) => post("/api/auth/reset-password", { token, password }, overrides);
const login = (user, password) => post("/api/auth/login", { email: user.email, password });
const me = cookie => fetch(new URL("/api/auth/me", base), { headers: { cookie }, signal: AbortSignal.timeout(15000) });
const sessionCookie = response => response.headers.getSetCookie().find(value => value.startsWith("partyphoto_session="))?.split(";")[0];

async function seedUser(name, settings = {}) {
  const password = `old-${randomUUID()}`;
  const sessions = Array.from({ length: 2 }, () => randomBytes(32).toString("hex"));
  const user = await db.user.create({ data: {
    email: `${namespace}-${name}@example.invalid`, name: `Reset test ${name}`,
    passwordHash: await argon2.hash(password, options), ...settings,
    sessions: { create: sessions.map(token => ({ tokenHash: hash(token), expiresAt: new Date(Date.now() + 3600000) })) },
  }, select: { id: true, email: true, name: true, role: true } });
  const fixture = { ...user, password, cookies: sessions.map(token => `partyphoto_session=${token}`) };
  users.push(fixture);
  return fixture;
}

async function issueToken(user, expiresAt = new Date(Date.now() + 3600000)) {
  const token = randomBytes(32).toString("hex");
  const tokenHash = hash(token);
  tokenHashes.add(tokenHash);
  await db.passwordResetToken.upsert({
    where: { userId: user.id }, create: { userId: user.id, tokenHash, expiresAt }, update: { tokenHash, expiresAt },
  });
  return token;
}

async function passwordMatches(user, password) {
  const stored = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { passwordHash: true } });
  return argon2.verify(stored.passwordHash, password);
}

async function assertSuccess(response) {
  assert.equal(response.status, 200, "Reset must succeed");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true });
}

async function invalidBody(response) {
  assert.equal(response.status, 400, "Invalid reset tokens must use the generic failure status");
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.equal(typeof body.error, "string");
  for (const user of users) assert.equal(body.error.includes(user.email), false);
  assert.equal(body.error.includes("$argon2"), false);
  return body;
}

// Wait for requests blocked by this fixture's User lock, including queued waiters.
async function waitForWaiters(blockerPid, count) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [row] = await db.$queryRaw`
      WITH RECURSIVE waiting AS (
        SELECT "pid" FROM pg_stat_activity WHERE ${blockerPid} = ANY(pg_blocking_pids("pid"))
        UNION
        SELECT activity."pid" FROM pg_stat_activity activity
        JOIN waiting blocker ON blocker."pid" = ANY(pg_blocking_pids(activity."pid"))
      ) SELECT COUNT(*)::integer AS "count" FROM waiting
    `;
    if (row.count >= count) return;
    await delay(20);
  }
  assert.fail("Expected requests did not reach the fixture's database lock within the bounded wait");
}

test("operator-issued password resets over HTTP and PostgreSQL", async t => {
  try {
    await t.test("strict input, password bounds, origin and body limits reject without consuming a token", async () => {
      const user = await seedUser("validation");
      const token = await issueToken(user);
      for (const origin of [null, "null", "https://foreign.example", `${base.origin}/`]) {
        assert.equal((await reset(token, "new-password", { origin })).status, 403);
      }
      assert.equal((await reset(token, "new-password", { type: "text/plain" })).status, 415);
      assert.equal((await reset(token, "new-password", { raw: "x".repeat(8193) })).status, 413);
      assert.equal((await reset(token, "new-password", { raw: "{" })).status, 400);
      for (const data of [
        null, [], {}, { token, password: "1234567" }, { token, password: "x".repeat(129) },
        { token: "a".repeat(63), password: "new-password" },
        { token: "A".repeat(64), password: "new-password" },
        { token, password: "new-password", role: "ADMIN" },
      ]) assert.equal((await post("/api/auth/reset-password", data)).status, 400);
      assert.equal(await passwordMatches(user, user.password), true);
      assert.equal(await db.passwordResetToken.count({ where: { userId: user.id } }), 1);
      assert.equal(await db.session.count({ where: { userId: user.id } }), 2);
    });

    await t.test("wrong, expired and disabled-account tokens have indistinguishable errors", async () => {
      const wrong = randomBytes(32).toString("hex");
      tokenHashes.add(hash(wrong));
      const generic = await invalidBody(await reset(wrong, "new-password"));
      const expired = await seedUser("expired");
      const expiredToken = await issueToken(expired, new Date(0));
      assert.deepEqual(await invalidBody(await reset(expiredToken, "new-password")), generic);
      const disabled = await seedUser("disabled", { disabledAt: new Date() });
      const disabledToken = await issueToken(disabled);
      assert.deepEqual(await invalidBody(await reset(disabledToken, "new-password")), generic);
      for (const user of [expired, disabled]) {
        assert.equal(await passwordMatches(user, user.password), true);
        assert.equal(await db.session.count({ where: { userId: user.id } }), 2);
      }
    });

    await t.test("reset accepts eight characters, preserves admin/events, revokes every session and clears only its login limit", async () => {
      const user = await seedUser("admin", { role: "ADMIN" });
      const event = await db.event.create({ data: {
        ownerId: user.id, title: "Admin original album", slug: `${namespace}-album`, code: randomBytes(4).toString("hex").toUpperCase(),
        description: "Must remain unchanged", viewCount: 12n, downloadCount: 9n, mediaVersion: 7, accessVersion: 8,
      } });
      const token = await issueToken(user);
      const storedToken = await db.passwordResetToken.findUniqueOrThrow({ where: { userId: user.id }, select: { tokenHash: true } });
      assert.equal(storedToken.tokenHash === token, false);
      assert.equal(storedToken.tokenHash === hash(token), true);
      const loginKey = `auth:login:${hash(user.email)}`;
      const foreignKey = `auth:login:${hash(`${namespace}-foreign@example.invalid`)}`;
      extraRateKeys.push(foreignKey);
      const resetAt = new Date(Date.now() + 900000);
      await db.authRateLimit.createMany({ data: [
        { key: loginKey, attempts: 10, resetAt }, { key: foreignKey, attempts: 9, resetAt },
      ] });
      const globalBefore = await db.authRateLimit.findUnique({ where: { key: "auth:global" } });
      const newPassword = "12345678";
      await assertSuccess(await reset(token, newPassword, { cookie: user.cookies[0] }));
      assert.equal(await passwordMatches(user, newPassword), true);
      assert.equal(await passwordMatches(user, user.password), false);
      assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { id: true, email: true, name: true, role: true } }), {
        id: user.id, email: user.email, name: user.name, role: "ADMIN",
      });
      assert.deepEqual(await db.event.findUniqueOrThrow({ where: { id: event.id } }), event);
      assert.equal(await db.passwordResetToken.count({ where: { userId: user.id } }), 0);
      assert.equal(await db.session.count({ where: { userId: user.id } }), 0);
      for (const cookie of user.cookies) assert.equal((await me(cookie)).status, 401);
      assert.equal(await db.authRateLimit.findUnique({ where: { key: loginKey } }), null);
      assert.deepEqual(await db.authRateLimit.findUniqueOrThrow({ where: { key: foreignKey } }), { key: foreignKey, attempts: 9, resetAt });
      assert.deepEqual(await db.authRateLimit.findUnique({ where: { key: "auth:global" } }), globalBefore);
      await invalidBody(await reset(token, "different-password"));
      assert.equal(await passwordMatches(user, newPassword), true);
      assert.equal((await login(user, user.password)).status, 401);
      const signedIn = await login(user, newPassword);
      assert.equal(signedIn.status, 200);
      assert.equal((await signedIn.json()).user.role, "ADMIN");
      assert.equal((await me(sessionCookie(signedIn))).status, 200);
    });

    await t.test("per-token attempt limits reject before changes and expired windows reset", async () => {
      const user = await seedUser("limited");
      const token = await issueToken(user);
      const key = `password-reset:token:${hash(token)}`;
      await db.authRateLimit.create({ data: { key, attempts: 10, resetAt: new Date(Date.now() + 900000) } });
      const limited = await reset(token, "new-password");
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get("retry-after")) > 0);
      assert.equal(await passwordMatches(user, user.password), true);
      assert.equal(await db.session.count({ where: { userId: user.id } }), 2);
      await db.authRateLimit.update({ where: { key }, data: { resetAt: new Date(0) } });
      await assertSuccess(await reset(token, "new-password"));
      assert.equal((await db.authRateLimit.findUniqueOrThrow({ where: { key } })).attempts, 1);
    });

    await t.test("two concurrent resets consume one token and only the winner's password works", async () => {
      const user = await seedUser("concurrent");
      const token = await issueToken(user);
      const passwords = [`winner-a-${randomUUID()}`, `winner-b-${randomUUID()}`];
      const responses = await Promise.all(passwords.map(password => reset(token, password)));
      assert.deepEqual(responses.map(response => response.status).sort(), [200, 400]);
      const winner = responses.findIndex(response => response.status === 200);
      await assertSuccess(responses[winner]);
      await invalidBody(responses[1 - winner]);
      assert.equal(await passwordMatches(user, passwords[winner]), true);
      assert.equal(await passwordMatches(user, passwords[1 - winner]), false);
      assert.equal(await db.passwordResetToken.count({ where: { userId: user.id } }), 0);
      assert.equal(await db.session.count({ where: { userId: user.id } }), 0);
      for (const cookie of user.cookies) assert.equal((await me(cookie)).status, 401);
    });

    await t.test("an old-password login queued behind a reset cannot resurrect a valid session", async () => {
      const user = await seedUser("login-race");
      const token = await issueToken(user);
      const newPassword = `new-${randomUUID()}`;
      let resetting;
      let oldLogin;
      try {
        await db.$transaction(async tx => {
          await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;
          const [connection] = await tx.$queryRaw`SELECT pg_backend_pid() AS "pid"`;
          resetting = reset(token, newPassword).then(response => ({ response }), error => ({ error }));
          await waitForWaiters(connection.pid, 1);
          oldLogin = login(user, user.password).then(response => ({ response }), error => ({ error }));
          await waitForWaiters(connection.pid, 2);
        }, { maxWait: 5000, timeout: 10000 });
        const resetResult = await resetting;
        assert.equal(Boolean(resetResult.error), false, "Reset request must finish after the fixture lock is released");
        await assertSuccess(resetResult.response);
        const loginResult = await oldLogin;
        assert.equal(Boolean(loginResult.error), false, "Login request must finish after the fixture lock is released");
        assert.ok([200, 401].includes(loginResult.response.status));
        const cookie = sessionCookie(loginResult.response);
        if (cookie) assert.equal((await me(cookie)).status, 401);
        assert.equal(await db.session.count({ where: { userId: user.id } }), 0);
        assert.equal(await passwordMatches(user, newPassword), true);
        assert.equal((await login(user, user.password)).status, 401);
        const signedIn = await login(user, newPassword);
        assert.equal(signedIn.status, 200);
        assert.equal((await me(sessionCookie(signedIn))).status, 200);
      } finally {
        // Also settle aborted requests after a failed assertion rolls the lock back.
        await Promise.all([resetting, oldLogin].filter(Boolean));
      }
    });

    await t.test("operator issuance normalizes email, uses a 30-minute DB expiry and replaces only the reset token", async () => {
      const user = await seedUser("issued", { role: "ADMIN" });
      const issued = await issuePasswordReset(db, `  ${user.email.toUpperCase()}  `);
      tokenHashes.add(hash(issued.token));
      assert.equal(/^[a-f0-9]{64}$/.test(issued.token), true);
      assert.equal(issued.email, user.email);
      let stored = await db.passwordResetToken.findUniqueOrThrow({ where: { userId: user.id } });
      assert.equal(stored.tokenHash === hash(issued.token), true);
      assert.equal(stored.tokenHash === issued.token, false);
      assert.equal(stored.expiresAt.getTime() - stored.createdAt.getTime(), 30 * 60 * 1000);
      assert.equal(stored.expiresAt.getTime(), issued.expiresAt.getTime());
      const replacement = await issuePasswordReset(db, user.email);
      tokenHashes.add(hash(replacement.token));
      assert.equal(issued.token === replacement.token, false);
      assert.equal(await db.passwordResetToken.count({ where: { userId: user.id } }), 1);
      stored = await db.passwordResetToken.findUniqueOrThrow({ where: { userId: user.id } });
      assert.equal(stored.tokenHash === hash(replacement.token), true);
      await invalidBody(await reset(issued.token, "new-password"));
      assert.equal(await passwordMatches(user, user.password), true);
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { role: true } })).role, "ADMIN");
      assert.equal(await db.session.count({ where: { userId: user.id } }), 2);
      for (const cookie of user.cookies) assert.equal((await me(cookie)).status, 200);
      const disabled = await seedUser("issue-disabled", { disabledAt: new Date() });
      await assert.rejects(() => issuePasswordReset(db, disabled.email));
      await assert.rejects(() => issuePasswordReset(db, `${namespace}-missing@example.invalid`));
      await assert.rejects(() => issuePasswordReset(db, "not-an-email"));
      assert.equal(await db.passwordResetToken.count({ where: { userId: disabled.id } }), 0);
    });
  } finally {
    const userIds = users.map(user => user.id);
    await db.event.deleteMany({ where: { ownerId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.authRateLimit.deleteMany({ where: { key: { in: [
      ...users.map(user => `auth:login:${hash(user.email)}`),
      ...Array.from(tokenHashes, value => `password-reset:token:${value}`),
      ...extraRateKeys,
    ] } } });
    await db.$disconnect();
  }
});
