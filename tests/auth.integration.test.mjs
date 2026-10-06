import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";

// Run against a local dev server using this project's .env and database only.
const base = new URL(process.env.AUTH_TEST_URL ?? process.env.APP_URL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) || base.protocol !== "http:") {
  throw new Error("Auth integration tests require a local HTTP dev server");
}
const db = new PrismaClient();
const namespace = `auth-check-${randomUUID()}`;
const email = `${namespace}@example.invalid`;
const raceEmail = `${namespace}-race@example.invalid`;
const limitedEmail = `${namespace}-limited@example.invalid`;
const boundaryEmail = `${namespace}-boundary@example.invalid`;
const password = `  ${randomUUID()}  `;
const hash = value => createHash("sha256").update(value).digest("hex");
const cookieFrom = response => response.headers.get("set-cookie")?.split(";")[0];
const tokenFrom = cookie => cookie.split("=")[1];

async function post(path, data, { cookie, origin = base.origin, type = "application/json", raw } = {}) {
  const headers = { "content-type": type };
  if (origin !== null) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  return fetch(new URL(path, base), { method: "POST", headers, body: raw ?? (data === undefined ? undefined : JSON.stringify(data)), redirect: "manual" });
}

function me(cookie) {
  return fetch(new URL("/api/auth/me", base), { headers: cookie ? { cookie } : {} });
}

test("organizer authentication over HTTP and PostgreSQL", async t => {
  try {
    await t.test("anonymous access and CSRF/content validation", async () => {
      assert.equal((await me()).status, 401);
      const dashboard = await fetch(new URL("/dashboard", base), { redirect: "manual" });
      assert.equal(dashboard.status, 307);
      assert.equal(new URL(dashboard.headers.get("location"), base).pathname, "/login");
      for (const origin of [null, "null", "https://foreign.example"]) {
        assert.equal((await post("/api/auth/register", { name: "Test", email, password }, { origin })).status, 403);
      }
      assert.equal((await post("/api/auth/register", {}, { type: "text/plain" })).status, 415);
      assert.equal((await post("/api/auth/register", {}, { raw: "{" })).status, 400);
      assert.equal((await post("/api/auth/register", {}, { raw: "x".repeat(8193) })).status, 413);
      assert.equal((await post("/api/auth/register", { name: "Test", email, password: "1234567" })).status, 400);
      assert.equal((await post("/api/auth/login", { email, password: "1234567" })).status, 400);
      assert.equal((await post("/api/auth/register", { name: "Test", email, password, role: "ADMIN" })).status, 400);
      assert.equal(await db.user.count({ where: { email } }), 0);
    });

    await t.test("an eight-character account password works for registration and login", async () => {
      const boundaryPassword = randomUUID().slice(0, 8);
      const registered = await post("/api/auth/register", { name: "Boundary check", email: boundaryEmail, password: boundaryPassword });
      assert.equal(registered.status, 201);
      const stored = await db.user.findUniqueOrThrow({ where: { email: boundaryEmail } });
      assert.equal(await argon2.verify(stored.passwordHash, boundaryPassword), true);
      const loggedIn = await post("/api/auth/login", { email: boundaryEmail, password: boundaryPassword }, { cookie: cookieFrom(registered) });
      assert.equal(loggedIn.status, 200);
      assert.equal((await me(cookieFrom(loggedIn))).status, 200);
    });

    let cookie;
    let userId;
    await t.test("registration normalizes email, hashes credentials and starts a session", async () => {
      const response = await post("/api/auth/register", { name: "  Test <organizer>  ", email: `  ${email.toUpperCase()}  `, password });
      assert.equal(response.status, 201);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const user = (await response.json()).user;
      assert.deepEqual(Object.keys(user).sort(), ["email", "id", "name", "role"]);
      assert.equal(user.role, "ORGANIZER");
      assert.equal(user.email, email);
      assert.equal(user.name, "Test <organizer>");
      userId = user.id;
      cookie = cookieFrom(response);
      assert.match(cookie, /^partyphoto_session=[a-f0-9]{64}$/);
      const setCookie = response.headers.get("set-cookie");
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=lax/i);
      assert.match(setCookie, /Path=\//i);
      const stored = await db.user.findUniqueOrThrow({ where: { id: userId } });
      assert.match(stored.passwordHash, /^\$argon2id\$/);
      assert.equal(await argon2.verify(stored.passwordHash, password), true);
      assert.equal(await argon2.verify(stored.passwordHash, password.trim()), false);
      const session = await db.session.findUniqueOrThrow({ where: { tokenHash: hash(tokenFrom(cookie)) } });
      assert.equal(session.userId, userId);
      assert.notEqual(session.tokenHash, tokenFrom(cookie));
      assert.equal((await me(cookie)).status, 200);
      const dashboard = await fetch(new URL("/dashboard", base), { headers: { cookie } });
      assert.equal(dashboard.status, 200);
      assert.match(await dashboard.text(), /Test &lt;organizer&gt;/);
    });

    await t.test("duplicate email, concurrent registration and generic login errors", async () => {
      assert.equal((await post("/api/auth/register", { name: "Test", email: email.toUpperCase(), password })).status, 409);
      const responses = await Promise.all([1, 2].map(() => post("/api/auth/register", { name: "Race check", email: raceEmail, password })));
      assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
      assert.equal(await db.user.count({ where: { email: raceEmail } }), 1);
      const raceUser = await db.user.findUniqueOrThrow({ where: { email: raceEmail } });
      assert.equal(await db.session.count({ where: { userId: raceUser.id } }), 1);
      const wrong = await post("/api/auth/login", { email, password: "wrong-password" });
      const unknown = await post("/api/auth/login", { email: `${namespace}-missing@example.invalid`, password });
      assert.equal(wrong.status, 401);
      assert.equal(unknown.status, 401);
      assert.deepEqual(await wrong.json(), await unknown.json());
    });

    await t.test("expired sessions fail and login rotates the token", async () => {
      const previous = cookie;
      await db.session.update({ where: { tokenHash: hash(tokenFrom(cookie)) }, data: { expiresAt: new Date(0) } });
      assert.equal((await me(cookie)).status, 401);
      let response = await post("/api/auth/login", { email: email.toUpperCase(), password }, { cookie });
      assert.equal(response.status, 200);
      cookie = cookieFrom(response);
      assert.notEqual(cookie, previous);
      assert.equal((await me(previous)).status, 401);
      const beforeRotation = cookie;
      response = await post("/api/auth/login", { email, password }, { cookie });
      assert.equal(response.status, 200);
      cookie = cookieFrom(response);
      assert.notEqual(cookie, beforeRotation);
      assert.equal((await me(beforeRotation)).status, 401);
      assert.equal(await db.session.count({ where: { userId } }), 1);
    });

    await t.test("disabled accounts fail immediately; logout invalidates the server session", async () => {
      await db.user.update({ where: { id: userId }, data: { disabledAt: new Date() } });
      assert.equal((await me(cookie)).status, 401);
      const disabled = await post("/api/auth/login", { email, password });
      assert.equal(disabled.status, 401);
      assert.deepEqual(await disabled.json(), { error: "Неверный email или пароль." });
      await db.user.update({ where: { id: userId }, data: { disabledAt: null } });
      assert.equal((await post("/api/auth/logout", undefined, { cookie, origin: "https://foreign.example" })).status, 403);
      assert.equal((await me(cookie)).status, 200);
      const response = await post("/api/auth/logout", undefined, { cookie });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("set-cookie"), /Max-Age=0/i);
      assert.equal((await me(cookie)).status, 401);
      assert.equal(await db.session.count({ where: { userId } }), 0);
      assert.equal((await post("/api/auth/logout")).status, 200);
      assert.equal((await me("partyphoto_session=forged" )).status, 401);
    });

    await t.test("account attempt limit is atomic under concurrent requests", async () => {
      const key = `auth:login:${hash(limitedEmail)}`;
      await db.authRateLimit.create({ data: { key, attempts: 9, resetAt: new Date(Date.now() + 900000) } });
      const responses = await Promise.all([1, 2].map(() => post("/api/auth/login", { email: limitedEmail, password })));
      assert.deepEqual(responses.map(r => r.status).sort(), [401, 429]);
      const limited = responses.find(r => r.status === 429);
      assert.ok(Number(limited.headers.get("retry-after")) > 0);
      assert.equal((await db.authRateLimit.findUniqueOrThrow({ where: { key } })).attempts, 11);
    });
  } finally {
    // Remove only this run's fixture users/counters; leave application data intact.
    await db.user.deleteMany({ where: { email: { in: [email, raceEmail, boundaryEmail] } } });
    const subjects = [email, raceEmail, limitedEmail, boundaryEmail, `${namespace}-missing@example.invalid`];
    await db.authRateLimit.deleteMany({ where: { key: { in: subjects.flatMap(subject => ["login", "register"].map(action => `auth:${action}:${hash(subject)}`)) } } });
    await db.$disconnect();
  }
});
