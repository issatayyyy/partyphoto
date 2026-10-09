import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { prepareDemo } from "../scripts/prepare-demo.mjs";
import { startDemo, validateDemoEnvironment } from "../scripts/start-demo.mjs";

const baseEnv = {
  DATABASE_URL: "postgresql://demo:database-fixture-secret@db.example.invalid/demo?schema=partyphoto",
  S3_ENDPOINT: "https://storage.example.invalid",
  S3_REGION: "us-east-1",
  S3_BUCKET: "partyphoto-demo",
  S3_ACCESS_KEY_ID: "access-fixture-secret",
  S3_SECRET_ACCESS_KEY: "storage-fixture-secret",
  APP_URL: "https://partyphoto.example.invalid",
};

class FakeChild extends EventEmitter {
  constructor({ stubborn = false } = {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.kills = [];
    this.stubborn = stubborn;
    this.ended = false;
  }
  finish(code, signal = null) {
    if (this.ended) return;
    this.ended = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, signal);
  }
  kill(signal) {
    this.kills.push(signal);
    if (!this.stubborn) queueMicrotask(() => this.finish(null, signal));
    return true;
  }
}

async function fixture(t) {
  const rootDir = await mkdtemp(join(tmpdir(), "partyphoto-demo-runtime-"));
  for (const path of ["node_modules/prisma/build/index.js", "prisma/schema.prisma", ".next/standalone/server.js", "scripts/media-worker.mjs"]) {
    const target = join(rootDir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "// Runtime fixture only; never executed.\n");
  }
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  return rootDir;
}

function fakeRuntime(rootDir, options = {}) {
  const children = [];
  const calls = [];
  const messages = [];
  const signals = new EventEmitter();
  const run = startDemo({
    rootDir, env: baseEnv, signals, shutdownMs: 100, logger: message => messages.push(message),
    spawnChild(command, args, config) {
      calls.push({ command, args, config });
      if (options.throwAt === calls.length - 1) throw new Error(`Fixture error with ${baseEnv.DATABASE_URL}`);
      const child = new FakeChild({ stubborn: options.stubborn ?? false });
      children.push(child);
      return child;
    },
    ...options,
  });
  return { run, children, calls, messages, signals };
}

test("demo config requires dedicated PostgreSQL schema and keeps credentials out of errors", () => {
  assert.equal(validateDemoEnvironment(baseEnv).DATABASE_URL, baseEnv.DATABASE_URL);
  const prefix = "partyphoto_test_";
  const testSchema = prefix + "a".repeat(63 - prefix.length);
  assert.doesNotThrow(() => validateDemoEnvironment({ ...baseEnv, DATABASE_URL: baseEnv.DATABASE_URL.replace("schema=partyphoto", `schema=${testSchema}`) }));
  for (const query of ["", "schema=public", "schema=auth", "schema=storage", "schema=pg_catalog", "schema=information_schema", "schema=partyphoto_other", "schema=partyphoto&schema=public", `schema=${testSchema}a`]) {
    assert.throws(() => validateDemoEnvironment({ ...baseEnv, DATABASE_URL: `postgresql://demo:database-fixture-secret@db.example.invalid/demo?${query}` }), error => {
      assert.doesNotMatch(error.message, /database-fixture-secret|db\.example/);
      return /dedicated partyphoto schema/.test(error.message);
    });
  }
  assert.throws(() => validateDemoEnvironment({ ...baseEnv, DATABASE_URL: "mysql://demo:secret@db.example.invalid/demo?schema=partyphoto" }), /PostgreSQL/);
});

test("only a trusted Render fallback can supply the HTTPS app origin", () => {
  const { APP_URL: ignored, ...withoutApp } = baseEnv;
  assert.throws(() => validateDemoEnvironment({ ...withoutApp, RENDER_EXTERNAL_URL: "https://course.onrender.com" }), /Missing HTTPS APP_URL/);
  assert.equal(validateDemoEnvironment({ ...withoutApp, RENDER: "true", RENDER_EXTERNAL_URL: "https://course.onrender.com/" }).APP_URL, "https://course.onrender.com");
  for (const APP_URL of ["", "http://course.onrender.com", "https://user:secret@course.onrender.com", "https://course.onrender.com/path", "https://course.onrender.com/?secret=value", "https://course.onrender.com/#secret"]) {
    assert.throws(() => validateDemoEnvironment({ ...baseEnv, APP_URL, RENDER: "true", RENDER_EXTERNAL_URL: "https://course.onrender.com" }));
  }
  assert.throws(() => validateDemoEnvironment({ ...withoutApp, RENDER: "true", RENDER_EXTERNAL_URL: "http://course.onrender.com" }), /HTTPS origin/);
});

test("runtime environment fixes host and mode, accepts a port, and validates S3 URLs", () => {
  const defaults = validateDemoEnvironment({ ...baseEnv, NODE_ENV: "development", HOSTNAME: "127.0.0.1" });
  assert.equal(defaults.NODE_ENV, "production");
  assert.equal(defaults.HOSTNAME, "0.0.0.0");
  assert.equal(defaults.PORT, "10000");
  assert.equal(validateDemoEnvironment({ ...baseEnv, PORT: "3000", S3_ENDPOINT: "http://localhost:9000" }).PORT, "3000");
  for (const PORT of ["", "0", "65536", "1.5", "3000bad"]) assert.throws(() => validateDemoEnvironment({ ...baseEnv, PORT }), /PORT/);
  for (const S3_ENDPOINT of ["not-a-url", "file:///tmp/storage", "https://user:secret@storage.example.invalid", "https://storage.example.invalid?secret=value", "https://storage.example.invalid/#secret"]) assert.throws(() => validateDemoEnvironment({ ...baseEnv, S3_ENDPOINT }), /S3_ENDPOINT/);
});

test("missing runtime configuration fails before spawning anything", async t => {
  const rootDir = await fixture(t);
  for (const name of Object.keys(baseEnv)) {
    const env = { ...baseEnv };
    delete env[name];
    const messages = [];
    let spawned = false;
    const result = await startDemo({ rootDir, env, logger: message => messages.push(message), spawnChild() { spawned = true; } });
    assert.equal(result, 1);
    assert.equal(spawned, false);
    assert.doesNotMatch(messages.join("\n"), /database-fixture-secret|access-fixture-secret|storage-fixture-secret/);
  }
});

test("missing build files fail without migration or application startup", async t => {
  const rootDir = await fixture(t);
  await rm(join(rootDir, ".next/standalone/server.js"));
  const runtime = fakeRuntime(rootDir);
  assert.equal(await runtime.run, 1);
  assert.equal(runtime.calls.length, 0);
});

test("successful migrations precede fixed web and worker commands and env", async t => {
  const rootDir = await fixture(t);
  const runtime = fakeRuntime(rootDir);
  assert.equal(runtime.calls.length, 1);
  assert.equal(runtime.calls[0].command, process.execPath);
  assert.deepEqual(runtime.calls[0].args, [join(rootDir, "node_modules/prisma/build/index.js"), "migrate", "deploy", "--schema", join(rootDir, "prisma/schema.prisma")]);
  runtime.children[0].stdout.write(`${baseEnv.DATABASE_URL}\n`);
  runtime.children[0].stderr.write(`${baseEnv.S3_SECRET_ACCESS_KEY}\n`);
  runtime.children[0].finish(0);
  assert.equal(runtime.calls.length, 3);
  assert.deepEqual(runtime.calls[1].args, [join(rootDir, ".next/standalone/server.js")]);
  assert.equal(runtime.calls[1].config.cwd, join(rootDir, ".next/standalone"));
  assert.deepEqual(runtime.calls[2].args, [join(rootDir, "scripts/media-worker.mjs")]);
  assert.equal(runtime.calls[2].config.cwd, rootDir);
  for (const call of runtime.calls) {
    assert.equal(call.config.env.NODE_ENV, "production");
    assert.equal(call.config.env.HOSTNAME, "0.0.0.0");
    assert.equal(call.config.env.PORT, "10000");
    assert.equal(call.config.env.APP_URL, baseEnv.APP_URL);
    assert.deepEqual(call.config.stdio, ["ignore", "pipe", "pipe"]);
  }
  runtime.signals.emit("SIGTERM");
  assert.equal(await runtime.run, 0);
  assert.deepEqual(runtime.children[1].kills, ["SIGTERM"]);
  assert.deepEqual(runtime.children[2].kills, ["SIGTERM"]);
  assert.doesNotMatch(runtime.messages.join("\n"), /database-fixture-secret|storage-fixture-secret/);
  assert.equal(runtime.signals.listenerCount("SIGTERM"), 0);
  assert.equal(runtime.signals.listenerCount("SIGINT"), 0);
});

test("migration failure closes startup and never launches web or worker", async t => {
  const rootDir = await fixture(t);
  const runtime = fakeRuntime(rootDir);
  runtime.children[0].finish(2);
  assert.equal(await runtime.run, 1);
  assert.equal(runtime.calls.length, 1);
  assert.match(runtime.messages.join("\n"), /Database migrations failed \(exit code 2\)/);
});

test("migration spawn errors do not leak exception messages or launch children", async t => {
  const rootDir = await fixture(t);
  const runtime = fakeRuntime(rootDir, { throwAt: 0 });
  assert.equal(await runtime.run, 1);
  assert.equal(runtime.calls.length, 1);
  assert.doesNotMatch(runtime.messages.join("\n"), /database-fixture-secret/);
});

test("SIGTERM during migration stops it without starting either service", async t => {
  const rootDir = await fixture(t);
  const runtime = fakeRuntime(rootDir);
  runtime.signals.emit("SIGTERM");
  runtime.signals.emit("SIGTERM");
  assert.equal(await runtime.run, 0);
  assert.equal(runtime.calls.length, 1);
  assert.deepEqual(runtime.children[0].kills, ["SIGTERM"]);
});

test("SIGINT stops both running services once", async t => {
  const rootDir = await fixture(t);
  const runtime = fakeRuntime(rootDir);
  runtime.children[0].finish(0);
  runtime.signals.emit("SIGINT");
  runtime.signals.emit("SIGINT");
  assert.equal(await runtime.run, 0);
  assert.deepEqual(runtime.children[1].kills, ["SIGINT"]);
  assert.deepEqual(runtime.children[2].kills, ["SIGINT"]);
});

for (const [name, index, sibling] of [["website", 1, 2], ["media worker", 2, 1]]) {
  test(`unexpected ${name} exit, including code zero, stops the sibling and fails`, async t => {
    const rootDir = await fixture(t);
    const runtime = fakeRuntime(rootDir);
    runtime.children[0].finish(0);
    runtime.children[index].finish(0);
    assert.equal(await runtime.run, 1);
    assert.deepEqual(runtime.children[sibling].kills, ["SIGTERM"]);
    assert.match(runtime.messages.join("\n"), /stopped unexpectedly \(exit code 0\)/);
  });
}

test("failure to spawn a worker stops the already started website", async t => {
  const rootDir = await fixture(t);
  const runtime = fakeRuntime(rootDir, { throwAt: 2 });
  runtime.children[0].finish(0);
  assert.equal(await runtime.run, 1);
  assert.equal(runtime.calls.length, 3);
  assert.deepEqual(runtime.children[1].kills, ["SIGTERM"]);
  assert.doesNotMatch(runtime.messages.join("\n"), /database-fixture-secret/);
});

test("an asynchronous child spawn error fails and stops its sibling", async t => {
  const rootDir = await fixture(t);
  const runtime = fakeRuntime(rootDir);
  runtime.children[0].finish(0);
  runtime.children[2].emit("error", new Error(`Fixture ${baseEnv.S3_SECRET_ACCESS_KEY}`));
  assert.equal(await runtime.run, 1);
  assert.deepEqual(runtime.children[1].kills, ["SIGTERM"]);
  assert.doesNotMatch(runtime.messages.join("\n"), /storage-fixture-secret/);
});

test("a shutdown deadline forces stubborn children and resolves within a bound", async t => {
  const rootDir = await fixture(t);
  const runtime = fakeRuntime(rootDir, { stubborn: true, shutdownMs: 30 });
  runtime.children[0].finish(0);
  const started = performance.now();
  runtime.signals.emit("SIGTERM");
  assert.equal(await runtime.run, 0);
  assert.ok(performance.now() - started < 2000);
  assert.deepEqual(runtime.children[1].kills, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(runtime.children[2].kills, ["SIGTERM", "SIGKILL"]);
  assert.equal(runtime.signals.listenerCount("SIGTERM"), 0);
  for (const child of runtime.children) child.finish(null, "SIGKILL");
});

test("asset preparation copies static and public assets and removes traced environment files", async t => {
  const rootDir = await fixture(t);
  await mkdir(join(rootDir, ".next/static/chunks"), { recursive: true });
  await mkdir(join(rootDir, "public/images"), { recursive: true });
  await mkdir(join(rootDir, ".next/standalone/nested"), { recursive: true });
  await writeFile(join(rootDir, ".env"), "SOURCE_SECRET=must-stay-in-source\n");
  await writeFile(join(rootDir, ".next/standalone/.env.production"), "TRACED_SECRET=must-be-removed\n");
  await writeFile(join(rootDir, ".next/standalone/nested/.env.local"), "TRACED_SECRET=must-be-removed\n");
  await writeFile(join(rootDir, ".next/static/chunks/app.js"), "static-fixture");
  await writeFile(join(rootDir, "public/images/logo.svg"), "public-fixture");
  await writeFile(join(rootDir, "public/.env.local"), "PUBLIC_SECRET=must-not-be-copied\n");
  await prepareDemo({ rootDir });
  assert.equal(await readFile(join(rootDir, ".next/standalone/.next/static/chunks/app.js"), "utf8"), "static-fixture");
  assert.equal(await readFile(join(rootDir, ".next/standalone/public/images/logo.svg"), "utf8"), "public-fixture");
  for (const path of [".next/standalone/.env.production", ".next/standalone/nested/.env.local", ".next/standalone/public/.env.local"]) await assert.rejects(stat(join(rootDir, path)), { code: "ENOENT" });
  assert.match(await readFile(join(rootDir, ".env"), "utf8"), /SOURCE_SECRET/);
  assert.match(await readFile(join(rootDir, "public/.env.local"), "utf8"), /PUBLIC_SECRET/);
  await prepareDemo({ rootDir });
  assert.equal(await readFile(join(rootDir, ".next/standalone/public/images/logo.svg"), "utf8"), "public-fixture");
});

test("asset preparation supports a missing public directory and rejects asset symlinks", async t => {
  const rootDir = await fixture(t);
  await mkdir(join(rootDir, ".next/static"), { recursive: true });
  await writeFile(join(rootDir, ".next/static/app.js"), "static-fixture");
  await prepareDemo({ rootDir });
  await assert.rejects(stat(join(rootDir, ".next/standalone/public")), { code: "ENOENT" });
  await mkdir(join(rootDir, "public"));
  await writeFile(join(rootDir, ".env"), "SECRET=source-fixture\n");
  await symlink(join(rootDir, ".env"), join(rootDir, "public/leaked-config.txt"));
  await assert.rejects(prepareDemo({ rootDir }), /symlinks/);
  await assert.rejects(stat(join(rootDir, ".next/standalone/public/leaked-config.txt")), { code: "ENOENT" });
});
