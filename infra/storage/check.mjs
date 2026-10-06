import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { S3Client, HeadBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

const endpoint = new URL(process.env.S3_ENDPOINT || "http://localhost:9000");
if (endpoint.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(endpoint.hostname) || endpoint.port !== "9000") throw new Error("This check is for local SeaweedFS on port 9000.");
const Bucket = process.env.S3_BUCKET;
assert.ok(Bucket && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY, "Set local S3 credentials in .env.");
const client = new S3Client({ endpoint: endpoint.origin, region: process.env.S3_REGION || "us-east-1", forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }, maxAttempts: 1 });
const Key = `.partyphoto-health/${randomUUID()}.txt`;
try {
  await client.send(new HeadBucketCommand({ Bucket }));
  await client.send(new PutObjectCommand({ Bucket, Key, Body: "PartyPhoto private storage check", ContentType: "text/plain", ACL: "private" }));
  const object = await client.send(new GetObjectCommand({ Bucket, Key }));
  assert.equal(await object.Body.transformToString(), "PartyPhoto private storage check");
  const anonymous = await fetch(`${endpoint.origin}/${Bucket}/${Key}`);
  await anonymous.body?.cancel();
  assert.equal(anonymous.status, 403, "Anonymous access must be denied.");
  await client.send(new DeleteObjectCommand({ Bucket, Key }));
  await assert.rejects(client.send(new GetObjectCommand({ Bucket, Key })), error => error.$metadata?.httpStatusCode === 404);
  console.log("Local S3 verified: authenticated write/read/delete and anonymous access denied (403).");
} finally {
  await client.send(new DeleteObjectCommand({ Bucket, Key })).catch(() => {});
  client.destroy();
}
