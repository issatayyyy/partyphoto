import { mkdir, chmod, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const dataDirectory = resolve(projectDirectory, ".data/storage");

export async function configureStorage() {
  const bucket = process.env.S3_BUCKET;
  const accessKey = process.env.S3_ACCESS_KEY_ID;
  const secretKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) throw new Error("Set a valid S3_BUCKET in .env.");
  if (!accessKey || accessKey.length < 8 || !secretKey || secretKey.length < 16) throw new Error("Set non-empty S3 keys (secret at least 16 characters) in .env.");
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await chmod(dataDirectory, 0o700);
  const configPath = resolve(dataDirectory, "s3.json");
  const config = { identities: [{ name: "partyphoto", credentials: [{ accessKey, secretKey }], actions: ["Read", "Write", "List", "Tagging", "Admin"].map(action => `${action}:${bucket}`) }] };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await chmod(configPath, 0o600);
  return { bucket, accessKey, secretKey, configPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await configureStorage();
  console.log("Private local S3 configuration generated; credentials were not printed.");
}
