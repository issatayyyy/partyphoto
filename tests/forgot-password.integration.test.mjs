import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { issuePasswordReset } from "../scripts/password-reset.mjs";

const base = new URL(process.env.AUTH_TEST_URL ?? process.env.APP_URL);
const database = new URL(process.env.DATABASE_URL);
const local = ["localhost", "127.0.0.1", "[::1]"];
if (base.protocol !== "http:" || !local.includes(base.hostname) || !local.includes(database.hostname)
  || !["postgres:", "postgresql:"].includes(database.protocol)) {
  throw new Error("Forgot-password integration tests require local HTTP and PostgreSQL");
}
const db = new PrismaClient();
const prefix = `forgot-check-${randomBytes(10).toString("hex")}`;
const fixtureUsers = [];
const fixtureEmails = new Set();
const resetHashes = new Set();
const records = [];
const plans = new Map();
const sha = value => createHash("sha256").update(value).digest("hex");
const generic = { ok: true, message: "Если для этой почты есть активный аккаунт, мы отправим ссылку для смены пароля. Проверьте также папку «Спам»." };
const passwordOptions = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

async function post(path, data, { origin = base.origin, type = "application/json", raw } = {}) {
  const headers = { "content-type": type };
  if (origin !== null) headers.origin = origin;
  return fetch(new URL(path, base), { method: "POST", headers, body: raw ?? JSON.stringify(data), redirect: "manual", signal: AbortSignal.timeout(15000) });
}
const forgot = (email, overrides) => post("/api/auth/forgot-password", { email }, overrides);
async function accepted(response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), generic);
}
async function waitFor(check, description) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(25); }
  assert.fail(description);
}
async function seed(label, settings = {}) {
  const email = `${prefix}-${label}@example.invalid`;
  fixtureEmails.add(email);
  const password = randomBytes(18).toString("base64url");
  const user = await db.user.create({ data: {
    email, name: `Forgot test ${label}`, passwordHash: await argon2.hash(password, passwordOptions), ...settings,
    sessions: { create: Array.from({ length: 2 }, () => ({ tokenHash: sha(randomBytes(32).toString("hex")), expiresAt: new Date(Date.now() + 3600000) })) },
  } });
  fixtureUsers.push(user);
  return { ...user, password };
}
function plan(email, status = 201, hold = false) {
  let release;
  const gate = hold ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  const entry = { status, gate, release: () => release?.() };
  plans.set(email, entry);
  return entry;
}
function deliveredToken(record) {
  const link = record.body.textContent.split("\n").find(line => line.startsWith(`${base.origin}/reset-password#`));
  assert.ok(link, "Mail must contain the trusted fragment reset URL");
  const url = new URL(link);
  assert.equal(url.origin, base.origin); assert.equal(url.pathname, "/reset-password"); assert.equal(url.search, "");
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  assert.ok(/^[a-f0-9]{64}$/.test(token ?? ""), "Mail reset token must be a random 32-byte value");
  resetHashes.add(sha(token));
  return token;
}
async function unchanged(user) {
  const current = await db.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(current.passwordHash === user.passwordHash, true);
  assert.equal(current.role, user.role);
  assert.equal(await db.session.count({ where: { userId: user.id } }), 2);
}
async function expireMinute(email) {
  await db.authRateLimit.updateMany({ where: { key: `forgot-password:email:${sha(email)}:minute` }, data: { resetAt: new Date(0) } });
}

const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST"); assert.equal(request.url, "/v3/smtp/email");
    assert.equal(request.headers["api-key"], "local-test-key");
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 16384) throw new Error("Fixture body exceeds limit"); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const email = body.to?.[0]?.email;
    if (!fixtureEmails.has(email)) throw new Error("Refusing provider request outside fixture emails");
    const selected = plans.get(email) ?? plan(email);
    const record = { email, body, finished: false };
    records.push(record);
    await selected.gate;
    response.writeHead(selected.status, { "content-type": "application/json" });
    response.end(selected.status === 201 ? '{"messageId":"local-fixture"}' : '{"message":"fixture rejection"}');
    record.finished = true;
  } catch {
    response.writeHead(500); response.end();
  }
});

test("self-service forgotten passwords over local HTTP, PostgreSQL and a local mail provider", { timeout: 120000 }, async t => {
  try {
    await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(3119, "127.0.0.1", resolve); });
    // A server accidentally configured for a real provider must be rejected
    // before any existing-account request can initiate an external email.
    const preflightEmail = `${prefix}-transport@example.invalid`;
    fixtureEmails.add(preflightEmail);
    const preflight = await forgot(preflightEmail);
    assert.equal(preflight.headers.get("x-partyphoto-mail-transport"), "local-test", "Server must explicitly confirm its validated local mail transport");
    await accepted(preflight);
    await t.test("strict JSON and same-origin validation reject without contacting mail", async () => {
      for (const origin of [null, "null", "https://foreign.example", `${base.origin}/`]) assert.equal((await forgot("nobody@example.invalid", { origin })).status, 403);
      assert.equal((await forgot("nobody@example.invalid", { type: "text/plain" })).status, 415);
      assert.equal((await forgot("nobody@example.invalid", { raw: "{" })).status, 400);
      assert.equal((await forgot("nobody@example.invalid", { raw: "x".repeat(8193) })).status, 413);
      for (const data of [null, [], {}, { email: "bad" }, { email: "a".repeat(255) }, { email: "nobody@example.invalid", role: "ADMIN" }]) {
        assert.equal((await post("/api/auth/forgot-password", data)).status, 400);
      }
      assert.equal(records.length, 0);
    });

    await t.test("unknown and disabled accounts return the identical generic response without mail", async () => {
      const unknown = `${prefix}-unknown@example.invalid`; fixtureEmails.add(unknown);
      const disabled = await seed("disabled", { disabledAt: new Date() });
      const existingHash = sha(randomBytes(32).toString("hex"));
      await db.passwordResetToken.create({ data: { userId: disabled.id, tokenHash: existingHash, expiresAt: new Date(Date.now() + 3600000) } });
      await accepted(await forgot(unknown)); await accepted(await forgot(disabled.email));
      await delay(150);
      assert.equal(records.length, 0);
      assert.equal((await db.passwordResetToken.findUniqueOrThrow({ where: { userId: disabled.id } })).tokenHash === existingHash, true);
      await unchanged(disabled);
      assert.equal((await forgot(unknown)).status, 429);
      assert.equal((await forgot(disabled.email)).status, 429);
    });

    await t.test("response finishes before provider latency; mail carries only a fragment token and reset alone revokes sessions", async () => {
      const user = await seed("active", { role: "ADMIN" });
      const held = plan(user.email, 201, true);
      try {
        await accepted(await forgot(`  ${user.email.toUpperCase()}  `));
        const record = await waitFor(() => records.find(value => value.email === user.email), "Scheduled mail was not attempted");
        assert.equal(record.finished, false, "HTTP response must not wait for the provider");
        const token = deliveredToken(record);
        const stored = await db.passwordResetToken.findUniqueOrThrow({ where: { userId: user.id } });
        assert.equal(stored.tokenHash === sha(token), true); assert.equal(stored.tokenHash === token, false);
        assert.equal(stored.expiresAt.getTime() - stored.createdAt.getTime(), 1800000);
        await unchanged(user);
        const limited = await forgot(user.email);
        assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get("retry-after")) > 0);
        assert.equal((await db.passwordResetToken.findUniqueOrThrow({ where: { userId: user.id } })).tokenHash === stored.tokenHash, true);
        held.release(); await waitFor(() => record.finished, "Provider fixture did not finish");
        const replacementPassword = randomBytes(18).toString("base64url");
        const reset = await post("/api/auth/reset-password", { token, password: replacementPassword });
        assert.equal(reset.status, 200); assert.deepEqual(await reset.json(), { ok: true });
        assert.equal(await db.session.count({ where: { userId: user.id } }), 0);
        assert.equal(await db.passwordResetToken.count({ where: { userId: user.id } }), 0);
        const current = await db.user.findUniqueOrThrow({ where: { id: user.id } });
        assert.equal(await argon2.verify(current.passwordHash, replacementPassword), true); assert.equal(current.role, "ADMIN");
      } finally { held.release(); }
    });

    await t.test("provider rejection remains generic and removes only the just-issued token", async () => {
      const user = await seed("failed"); plan(user.email, 401);
      await accepted(await forgot(user.email));
      const record = await waitFor(() => records.find(value => value.email === user.email), "Rejected mail was not attempted");
      deliveredToken(record);
      await waitFor(() => record.finished, "Rejected provider fixture did not finish");
      await waitFor(async () => !(await db.passwordResetToken.findUnique({ where: { userId: user.id } })), "Failed delivery token was retained");
      await unchanged(user);
    });

    await t.test("late failed delivery cannot delete a concurrent replacement link", async () => {
      const user = await seed("replacement"); const held = plan(user.email, 403, true);
      try {
        await accepted(await forgot(user.email));
        const record = await waitFor(() => records.find(value => value.email === user.email), "Held rejected mail was not attempted");
        const oldToken = deliveredToken(record);
        const replacement = await issuePasswordReset(db, user.email); resetHashes.add(sha(replacement.token));
        assert.equal(sha(oldToken) === sha(replacement.token), false);
        held.release(); await waitFor(() => record.finished, "Held rejection did not finish"); await delay(150);
        assert.equal((await db.passwordResetToken.findUniqueOrThrow({ where: { userId: user.id } })).tokenHash === sha(replacement.token), true);
        await unchanged(user);
      } finally { held.release(); }
    });

    await t.test("hourly email cap and concurrent requests preserve the latest token", async () => {
      const user = await seed("hourly"); plan(user.email);
      const concurrent = await Promise.all([forgot(user.email), forgot(user.email)]);
      assert.deepEqual(concurrent.map(value => value.status).sort(), [200, 429]);
      await accepted(concurrent.find(value => value.status === 200));
      for (let count = 1; count <= 3; count++) {
        await waitFor(() => records.filter(value => value.email === user.email && value.finished).length === count, "Hourly mail was not delivered");
        if (count < 3) { await expireMinute(user.email); await accepted(await forgot(user.email)); }
      }
      const previous = await db.passwordResetToken.findUniqueOrThrow({ where: { userId: user.id } });
      await expireMinute(user.email);
      assert.equal((await forgot(user.email)).status, 429);
      assert.equal((await db.passwordResetToken.findUniqueOrThrow({ where: { userId: user.id } })).tokenHash === previous.tokenHash, true);
      assert.equal(records.filter(value => value.email === user.email).length, 3);
      await unchanged(user);
    });
  } finally {
    for (const selected of plans.values()) selected.release();
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    await db.passwordResetToken.deleteMany({ where: { userId: { in: fixtureUsers.map(value => value.id) } } });
    await db.user.deleteMany({ where: { id: { in: fixtureUsers.map(value => value.id) }, email: { in: [...fixtureEmails] } } });
    const keys = [...fixtureEmails].flatMap(email => [`forgot-password:email:${sha(email)}:minute`, `forgot-password:email:${sha(email)}:hour`, `auth:login:${sha(email)}`]);
    keys.push(...[...resetHashes].map(hash => `password-reset:token:${hash}`));
    await db.authRateLimit.deleteMany({ where: { key: { in: keys } } });
    await db.$disconnect();
  }
});
