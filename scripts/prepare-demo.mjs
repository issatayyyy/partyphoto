import { cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const isEnvironmentFile = name => name.startsWith(".env");

async function requireDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid build directory");
}

async function validateAssets(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (isEnvironmentFile(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error("Asset symlinks are not supported");
    if (entry.isDirectory()) await validateAssets(join(path, entry.name));
  }
}

async function removeEnvironmentFiles(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const target = join(path, entry.name);
    if (isEnvironmentFile(entry.name)) await rm(target, { recursive: true, force: true });
    else if (entry.isDirectory()) await removeEnvironmentFiles(target);
  }
}

export async function prepareDemo({ rootDir = projectRoot } = {}) {
  const root = resolve(rootDir);
  const standalone = join(root, ".next", "standalone");
  const staticSource = join(root, ".next", "static");
  await requireDirectory(standalone);
  await requireDirectory(staticSource);
  const server = await lstat(join(standalone, "server.js"));
  if (!server.isFile() || server.isSymbolicLink()) throw new Error("Missing standalone server");

  // Next traces runtime files, which can include build-time .env files.
  // Credentials must come from the hosting environment at runtime.
  await removeEnvironmentFiles(standalone);
  await validateAssets(staticSource);
  const staticTarget = join(standalone, ".next", "static");
  await mkdir(join(standalone, ".next"), { recursive: true });
  await rm(staticTarget, { recursive: true, force: true });
  await cp(staticSource, staticTarget, { recursive: true, filter: source => !isEnvironmentFile(basename(source)) });

  const publicSource = join(root, "public");
  let publicExists = true;
  try { await requireDirectory(publicSource); }
  catch (error) { if (error.code === "ENOENT") publicExists = false; else throw error; }
  const publicTarget = join(standalone, "public");
  await rm(publicTarget, { recursive: true, force: true });
  if (publicExists) {
    await validateAssets(publicSource);
    await cp(publicSource, publicTarget, { recursive: true, filter: source => !isEnvironmentFile(basename(source)) });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await prepareDemo();
    console.log("Demo build assets prepared.");
  } catch {
    console.error("Could not prepare demo assets. Check the standalone build and asset directories.");
    process.exitCode = 1;
  }
}
