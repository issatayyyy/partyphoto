import test from "node:test";
import assert from "node:assert/strict";
import { getResetMailConfig, sendPasswordResetEmail, MailDeliveryError } from "../src/lib/reset-email.ts";

const environment = { NODE_ENV: "production", BREVO_API_KEY: "fixture-only-api-key", MAIL_FROM_EMAIL: "sender@example.invalid" };
const resetUrl = `https://photos.example.invalid/reset-password#token=${"a".repeat(64)}`;

test("mail config requires credentials and a valid sender; test endpoint cannot reach external hosts or production", () => {
  const config = getResetMailConfig(environment);
  assert.equal(config.endpoint, "https://api.brevo.com/v3/smtp/email");
  assert.deepEqual(config.sender, { name: "PartyPhoto", email: "sender@example.invalid" });
  for (const change of [
    { BREVO_API_KEY: "" }, { BREVO_API_KEY: "key\nother" }, { MAIL_FROM_EMAIL: "not-email" },
    { MAIL_FROM_NAME: "name\r\nBcc: other" }, { MAIL_FROM_NAME: "a".repeat(81) },
    { EMAIL_TEST_API_URL: "http://127.0.0.1:3119/v3/smtp/email" },
  ]) assert.throws(() => getResetMailConfig({ ...environment, ...change }));
  for (const endpoint of ["http://external.example/v3/smtp/email", "https://127.0.0.1/v3/smtp/email", "http://user:secret@127.0.0.1/v3/smtp/email", "http://127.0.0.1/v3/smtp/email?x=1", "http://127.0.0.1/v3/smtp/email#x", "http://127.0.0.1/other", "garbage"]) {
    assert.throws(() => getResetMailConfig({ ...environment, NODE_ENV: "development", EMAIL_TEST_API_URL: endpoint }));
  }
  assert.equal(getResetMailConfig({ ...environment, NODE_ENV: "development", EMAIL_TEST_API_URL: "http://127.0.0.1:3119/v3/smtp/email" }).endpoint, "http://127.0.0.1:3119/v3/smtp/email");
});

test("Brevo request uses fixed sender, HTTPS, fragment token and a bounded request without redirects", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (endpoint, options) => {
    calls++;
    assert.equal(endpoint, "https://api.brevo.com/v3/smtp/email");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers["api-key"], environment.BREVO_API_KEY);
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    assert.deepEqual(body.to, [{ email: "user@example.invalid" }]);
    assert.deepEqual(body.sender, { name: "PartyPhoto", email: environment.MAIL_FROM_EMAIL });
    assert.ok(body.textContent.includes(resetUrl));
    assert.ok(body.htmlContent.includes(resetUrl));
    assert.match(body.textContent, /30 минут/);
    assert.equal(body.bcc, undefined);
    return new Response('{"messageId":"provider-fixture"}', { status: 201 });
  });
  await sendPasswordResetEmail(getResetMailConfig(environment), { to: " USER@example.invalid ", resetUrl });
  assert.equal(calls, 1);
});

test("provider errors are bounded categories and never include the provider response or request secrets", async t => {
  const config = getResetMailConfig(environment);
  for (const [status, category] of [[400, "sender_rejected"], [401, "unauthorized"], [403, "sender_rejected"], [429, "rate_limited"], [500, "unavailable"], [200, "unavailable"], [302, "unavailable"]]) {
    const mock = t.mock.method(globalThis, "fetch", async () => new Response(`provider leaked ${resetUrl} ${environment.BREVO_API_KEY}`, { status }));
    await assert.rejects(sendPasswordResetEmail(config, { to: "user@example.invalid", resetUrl }), error => {
      assert.ok(error instanceof MailDeliveryError);
      assert.equal(error.category, category);
      assert.doesNotMatch(error.message, /example|fixture-only|token=/);
      return true;
    });
    mock.mock.restore();
  }
  t.mock.method(globalThis, "fetch", async () => { throw new Error(`Network failure with ${environment.BREVO_API_KEY}`); });
  await assert.rejects(sendPasswordResetEmail(config, { to: "user@example.invalid", resetUrl }), { category: "unavailable", message: "Password reset email delivery failed" });
});

test("invalid recipient or reset link is rejected before any provider request", async t => {
  const mock = t.mock.method(globalThis, "fetch", () => { assert.fail("Must not contact provider"); });
  const config = getResetMailConfig(environment);
  for (const link of ["javascript:alert(1)", "http://external.example/reset-password#token=" + "a".repeat(64), "https://photos.example.invalid/reset-password?token=" + "a".repeat(64), resetUrl.replace("/reset-password", "/other"), resetUrl.replace("https://", "https://user:secret@"), resetUrl.replace("a".repeat(64), "short")]) {
    await assert.rejects(sendPasswordResetEmail(config, { to: "user@example.invalid", resetUrl: link }), MailDeliveryError);
  }
  await assert.rejects(sendPasswordResetEmail(config, { to: "user@example.invalid\r\nBcc: other@example.invalid", resetUrl }), MailDeliveryError);
  assert.equal(mock.mock.callCount(), 0);
});
