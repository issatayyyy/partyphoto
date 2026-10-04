import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}
export function storage() {
  return new S3Client({
    endpoint: required("S3_ENDPOINT"), region: required("S3_REGION"),
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials: { accessKeyId: required("S3_ACCESS_KEY_ID"), secretAccessKey: required("S3_SECRET_ACCESS_KEY") }
  });
}
// Internal helper: callers MUST authorize event access before signing any key.
// Never accept an arbitrary object key directly from a public HTTP request.
export async function signedOriginalUrl(key: string) {
  return getSignedUrl(storage(), new GetObjectCommand({
    Bucket: required("S3_BUCKET"), Key: key,
    ResponseContentDisposition: "attachment"
  }), { expiresIn: 60 });
}
