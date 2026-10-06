import { access, open } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { S3Client, HeadBucketCommand } from "@aws-sdk/client-s3";
import { configureStorage, dataDirectory } from "./configure.mjs";

const endpoint = new URL(process.env.S3_ENDPOINT || "http://localhost:9000");
if (endpoint.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(endpoint.hostname) || endpoint.port !== "9000") throw new Error("Local storage requires S3_ENDPOINT=http://localhost:9000.");
const binary = resolve(process.env.XDG_DATA_HOME || resolve(homedir(), ".local/share"), "partyphoto/seaweedfs/4.48/weed");
try { await access(binary, constants.X_OK); } catch { throw new Error("Install the verified binary first: sh infra/storage/install.sh"); }
const settings = await configureStorage();
const client = new S3Client({ endpoint: endpoint.origin, region: process.env.S3_REGION || "us-east-1", forcePathStyle: true, credentials: { accessKeyId: settings.accessKey, secretAccessKey: settings.secretKey }, maxAttempts: 1 });
try {
  await client.send(new HeadBucketCommand({ Bucket: settings.bucket }));
  console.log("Authenticated local S3 is already running on http://localhost:9000.");
  client.destroy();
  process.exit(0);
} catch { /* Start our local instance below. */ }
const logPath = resolve(dataDirectory, "seaweedfs.log");
const log = await open(logPath, "a", 0o600);
const child = spawn(binary, ["mini", `-dir=${dataDirectory}`, "-ip=127.0.0.1", "-ip.bind=127.0.0.1", "-s3.port=9000", `-s3.config=${settings.configPath}`, `-bucket=${settings.bucket}`, "-s3.autoCreateBucket=false", "-webdav=false", "-admin.ui=false", "-s3.iam=false", "-s3.port.iceberg=0", "-s3.port.lance=0", "-master.telemetry=false", "-filer.disableDirListing=true", "-filer.exposeDirectoryData=false"], { stdio: ["ignore", log.fd, log.fd] });
await log.close();
let finished = false;
let startupFailed = false;
child.on("exit", (code, signal) => {
  finished = true;
  client.destroy();
  process.exitCode = startupFailed ? 1 : signal ? 0 : code ?? 1;
  if (code && code !== 0) console.error("SeaweedFS exited; inspect .data/storage/seaweedfs.log.");
});
child.on("error", () => { finished = true; console.error("SeaweedFS failed to start; inspect .data/storage/seaweedfs.log."); process.exitCode = 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
for (let attempt = 0; attempt < 120 && !finished; attempt++) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: settings.bucket }));
    console.log("Private, authenticated local S3 ready on http://localhost:9000. Press Ctrl+C to stop. Logs: .data/storage/seaweedfs.log");
    break;
  } catch {
    if (attempt === 119) { startupFailed = true; console.error("Storage readiness timed out; inspect .data/storage/seaweedfs.log."); child.kill("SIGTERM"); process.exitCode = 1; }
    else await new Promise(resolve => setTimeout(resolve, 500));
  }
}
