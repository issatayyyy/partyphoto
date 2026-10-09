import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const mailLogLines = new Set([
  "Password reset email: accepted",
  "Password reset email: failed (unauthorized)",
  "Password reset email: failed (sender_rejected)",
  "Password reset email: failed (rate_limited)",
  "Password reset email: failed (unavailable)",
  "Password reset email: failed (internal)",
]);
const maxLogLineLength = 256;

function relayMailStatus(stream, logger) {
  if (!stream) return;
  let pending = "";
  let discarding = false;
  stream.setEncoding("utf8");
  stream.on("data", chunk => {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      const end = newline === -1 ? chunk.length : newline;
      if (!discarding) {
        if (pending.length + end - start > maxLogLineLength) {
          pending = "";
          discarding = true;
        } else pending += chunk.slice(start, end);
      }
      if (newline === -1) break;
      if (!discarding) {
        const line = pending.endsWith("\r") ? pending.slice(0, -1) : pending;
        if (mailLogLines.has(line)) logger(line);
      }
      pending = "";
      discarding = false;
      start = newline + 1;
    }
  });
  // A partial line at EOF is never a complete allowed status.
  stream.on("end", () => { pending = ""; });
  stream.resume();
}

class DemoConfigurationError extends Error {}

function requireValue(env, name) {
  if (typeof env[name] !== "string" || !env[name].trim()) throw new DemoConfigurationError(`Missing ${name}.`);
  return env[name];
}

function parseUrl(value, message) {
  try { return new URL(value); }
  catch { throw new DemoConfigurationError(message); }
}

export function validateDemoEnvironment(input) {
  const env = { ...input };
  const database = parseUrl(requireValue(env, "DATABASE_URL"), "Invalid DATABASE_URL.");
  const schemas = database.searchParams.getAll("schema");
  const schema = schemas[0] ?? "";
  if (!["postgres:", "postgresql:"].includes(database.protocol) || !database.hostname || database.pathname.length < 2
    || schemas.length !== 1 || schema.length > 63 || !/^(?:partyphoto|partyphoto_test_[a-z0-9_]+)$/.test(schema)) {
    throw new DemoConfigurationError("DATABASE_URL must use PostgreSQL and the dedicated partyphoto schema.");
  }

  for (const name of ["S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) requireValue(env, name);
  const storage = parseUrl(requireValue(env, "S3_ENDPOINT"), "Invalid S3_ENDPOINT.");
  if (!["http:", "https:"].includes(storage.protocol) || !storage.hostname || storage.username || storage.password || storage.search || storage.hash) {
    throw new DemoConfigurationError("S3_ENDPOINT must be an HTTP or HTTPS URL without credentials, query or fragment.");
  }

  const appValue = env.APP_URL === undefined && env.RENDER === "true" ? env.RENDER_EXTERNAL_URL : env.APP_URL;
  if (typeof appValue !== "string" || !appValue.trim()) throw new DemoConfigurationError("Missing HTTPS APP_URL.");
  const app = parseUrl(appValue, "Invalid APP_URL.");
  if (app.protocol !== "https:" || !app.hostname || app.username || app.password || app.pathname !== "/" || app.search || app.hash) {
    throw new DemoConfigurationError("APP_URL must be an HTTPS origin without credentials, path, query or fragment.");
  }
  const port = env.PORT === undefined ? "10000" : env.PORT;
  if (typeof port !== "string" || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new DemoConfigurationError("PORT must be between 1 and 65535.");
  return { ...env, APP_URL: app.origin, NODE_ENV: "production", HOSTNAME: "0.0.0.0", PORT: String(Number(port)) };
}

function defaultSignalChild(child, signal, detached) {
  if (detached && Number.isSafeInteger(child.pid) && child.pid > 0) {
    try { process.kill(-child.pid, signal); return; }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  child.kill(signal);
}

function exitResult(code, signal) {
  const safeSignal = ["SIGINT", "SIGTERM", "SIGKILL", "SIGHUP", "SIGABRT", "SIGSEGV"].includes(signal) ? signal : null;
  return safeSignal ? `signal ${safeSignal}` : `exit code ${Number.isInteger(code) ? code : "unknown"}`;
}

// Dependency injection is for process fixtures only. The production entry point
// always runs these fixed files and never accepts commands through env variables.
export async function startDemo({
  env = process.env,
  rootDir = projectRoot,
  spawnChild = spawn,
  signals = process,
  logger = message => console.log(message),
  shutdownMs = 10000,
  signalChild = defaultSignalChild,
} = {}) {
  let childEnv;
  const root = resolve(rootDir);
  const paths = {
    migration: join(root, "node_modules", "prisma", "build", "index.js"),
    schema: join(root, "prisma", "schema.prisma"),
    web: join(root, ".next", "standalone", "server.js"),
    worker: join(root, "scripts", "media-worker.mjs"),
  };
  try {
    childEnv = validateDemoEnvironment(env);
    for (const path of Object.values(paths)) if (!statSync(path).isFile()) throw new Error("Missing runtime file");
    if (!Number.isInteger(shutdownMs) || shutdownMs < 1 || shutdownMs > 10000) throw new Error("Invalid shutdown deadline");
  } catch (error) {
    logger(error instanceof DemoConfigurationError ? `Demo configuration error: ${error.message}` : "Demo runtime files are unavailable. Rebuild the project with all dependencies.");
    return 1;
  }

  return await new Promise(resolveDone => {
    const children = new Set();
    const detached = process.platform !== "win32";
    let stopping = false;
    let finished = false;
    let result = 1;
    let deadline;

    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      signals.removeListener("SIGTERM", onTerm);
      signals.removeListener("SIGINT", onInt);
      resolveDone(result);
    }

    function activeChildren() { return [...children].filter(record => record.active); }

    function sendSignal(record, signal) {
      if (!record.active) return;
      try { signalChild(record.child, signal, detached); }
      catch { logger(`Could not signal ${record.name}; waiting for shutdown deadline.`); }
    }

    function stop(code, message, signal = "SIGTERM") {
      if (stopping || finished) return;
      stopping = true;
      result = code;
      logger(message);
      if (!activeChildren().length) { finish(); return; }
      deadline = setTimeout(() => {
        logger("Shutdown deadline reached; forcing remaining processes to stop.");
        for (const record of activeChildren()) sendSignal(record, "SIGKILL");
        finish();
      }, shutdownMs);
      for (const record of activeChildren()) sendSignal(record, signal);
    }

    const onTerm = () => stop(0, "Received SIGTERM; stopping demo processes.");
    const onInt = () => stop(0, "Received SIGINT; stopping demo processes.", "SIGINT");
    signals.on("SIGTERM", onTerm);
    signals.on("SIGINT", onInt);

    function launch(name, args, cwd) {
      if (stopping || finished) return null;
      let child;
      try { child = spawnChild(process.execPath, args, { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"], detached }); }
      catch { stop(1, `Could not start ${name}; stopping demo processes.`); return null; }
      const record = { child, name, active: true };
      children.add(record);
      // Do not relay arbitrary library diagnostics or database connection strings.
      // Only complete, fixed mail-status lines from the website may pass through.
      if (name === "website") {
        relayMailStatus(child.stdout, logger);
        relayMailStatus(child.stderr, logger);
      } else {
        child.stdout?.resume();
        child.stderr?.resume();
      }
      child.once("error", () => {
        if (!record.active || finished) return;
        record.active = false;
        if (!stopping) stop(1, `Could not run ${name}; stopping demo processes.`);
        else if (!activeChildren().length) finish();
      });
      child.once("exit", (code, signal) => {
        if (!record.active || finished) return;
        record.active = false;
        if (stopping) { if (!activeChildren().length) finish(); return; }
        if (name === "database migrations" && code === 0) {
          logger("Database migrations completed successfully.");
          const web = launch("website", [paths.web], join(root, ".next", "standalone"));
          const worker = web && !stopping ? launch("media worker", [paths.worker], root) : null;
          if (web && worker && !stopping) logger("Website and media worker started.");
        } else {
          stop(1, `${name === "database migrations" ? "Database migrations failed" : `${name === "website" ? "Website" : "Media worker"} stopped unexpectedly`} (${exitResult(code, signal)}); stopping demo processes.`);
        }
      });
      return record;
    }

    logger("Applying database migrations before starting the website.");
    launch("database migrations", [paths.migration, "migrate", "deploy", "--schema", paths.schema], root);
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exit(await startDemo()); }
  catch {
    console.error("Demo startup failed; check the runtime configuration and build.");
    process.exit(1);
  }
}
