import "server-only";
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export function storageBucket() {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error("Missing S3_BUCKET");
  return bucket;
}
let client: S3Client | undefined;
export function storage() {
  if (client) return client;
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing ${name}`);
    return value;
  };
  client = new S3Client({
    endpoint: required("S3_ENDPOINT"), region: required("S3_REGION"),
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials: { accessKeyId: required("S3_ACCESS_KEY_ID"), secretAccessKey: required("S3_SECRET_ACCESS_KEY") },
    requestHandler: { connectionTimeout: 5000, requestTimeout: 60000, socketTimeout: 60000, throwOnRequestTimeout: true },
  });
  return client;
}
export async function putMedia(key: string, body: Buffer, mimeType: string) {
  await storage().send(new PutObjectCommand({ Bucket: storageBucket(), Key: key, Body: body, ContentType: mimeType }));
}
export async function deleteMedia(key: string) {
  await storage().send(new DeleteObjectCommand({ Bucket: storageBucket(), Key: key }));
}
export function getMedia(key: string) {
  return storage().send(new GetObjectCommand({ Bucket: storageBucket(), Key: key }));
}
// Internal only: HTTP media routes must authorize event access before using keys.
export async function signedOriginalUrl(key: string) {
  return getSignedUrl(storage(), new GetObjectCommand({ Bucket: storageBucket(), Key: key, ResponseContentDisposition: "attachment" }), { expiresIn: 60 });
}
