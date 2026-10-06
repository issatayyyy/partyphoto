import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import argon2 from "argon2";
import { recoverMedia } from "../scripts/media-recovery.mjs";

const endpoint = new URL(process.env.S3_ENDPOINT);
const database = new URL(process.env.DATABASE_URL);
if (![endpoint, database].every(url => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) || endpoint.protocol !== "http:") {
  throw new Error("Media recovery tests require local PostgreSQL and S3 endpoints");
}
const db = new PrismaClient();
const s3 = new S3Client({
  endpoint: endpoint.href, region: process.env.S3_REGION,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
});
const bucket = process.env.S3_BUCKET;
const namespace = `recovery-check-${randomUUID()}`;
const ownKeys = new Set();
let eventId;

async function seedPhoto({ status, size = 100, thumbnailSize = 25, reserved = 0, expiresAt = null, partial = false }) {
  const id = randomUUID();
  const originalKey = `events/${eventId}/photos/${id}/original.jpeg`;
  const thumbnailKey = `events/${eventId}/photos/${id}/thumbnail.webp`;
  ownKeys.add(originalKey);
  ownKeys.add(thumbnailKey);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: originalKey, Body: Buffer.alloc(size, 17), ContentType: "image/jpeg" }));
  if (!partial) await s3.send(new PutObjectCommand({ Bucket: bucket, Key: thumbnailKey, Body: Buffer.alloc(thumbnailSize, 31), ContentType: "image/webp" }));
  const photo = await db.$transaction(async tx => {
    const photo = await tx.photo.create({ data: {
      id, eventId, originalKey, thumbnailKey, filename: `${status.toLowerCase()}.jpg`, mimeType: "image/jpeg",
      sizeBytes: BigInt(size), thumbnailBytes: BigInt(thumbnailSize), reservedBytes: BigInt(reserved),
      status, uploadExpiresAt: expiresAt, width: 10, height: 10,
    } });
    await tx.event.update({ where: { id: eventId }, data: {
      reservedBytes: { increment: BigInt(reserved) },
      usedStorageBytes: { increment: reserved ? 0n : BigInt(size + thumbnailSize) },
    } });
    return photo;
  });
  return photo;
}

async function assertObject(key, exists) {
  if (exists) {
    const object = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    assert.ok(object.ContentLength > 0);
    return;
  }
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    assert.fail("Recovery left an object in storage");
  } catch (error) {
    if (error.code === "ERR_ASSERTION") throw error;
    assert.equal(error.$metadata?.httpStatusCode, 404);
  }
}

async function assertPhotoObjects(photo, exist) {
  await assertObject(photo.originalKey, exist);
  await assertObject(photo.thumbnailKey, exist);
}

test("media recovery removes unfinished objects and releases quotas exactly once", async t => {
  let userId;
  let live;
  try {
    const user = await db.user.create({ data: {
      email: `${namespace}@example.invalid`, name: "Recovery test",
      passwordHash: await argon2.hash(randomUUID(), { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }),
    } });
    userId = user.id;
    const event = await db.event.create({ data: {
      ownerId: user.id, title: "Media recovery fixture", slug: namespace, code: randomBytes(4).toString("hex").toUpperCase(),
    } });
    eventId = event.id;

    await t.test("expired PROCESSING is deleted while an active upload retains its reservation and keys", async () => {
      live = await seedPhoto({ status: "PROCESSING", size: 70, thumbnailSize: 10, reserved: 80, expiresAt: new Date(Date.now() + 3600000) });
      const expired = await seedPhoto({ status: "PROCESSING", size: 120, thumbnailSize: 30, reserved: 150, expiresAt: new Date(0) });
      assert.equal((await db.event.findUniqueOrThrow({ where: { id: eventId } })).reservedBytes, 230n);
      await recoverMedia(db, s3, bucket);
      assert.equal(await db.photo.findUnique({ where: { id: expired.id } }), null);
      await assertPhotoObjects(expired, false);
      assert.equal((await db.photo.findUniqueOrThrow({ where: { id: live.id } })).status, "PROCESSING");
      await assertPhotoObjects(live, true);
      const after = await db.event.findUniqueOrThrow({ where: { id: eventId } });
      assert.equal(after.reservedBytes, 80n);
      assert.equal(after.usedStorageBytes, 0n);
      await recoverMedia(db, s3, bucket);
      assert.equal((await db.event.findUniqueOrThrow({ where: { id: eventId } })).reservedBytes, 80n);
    });

    await t.test("a failed storage deletion keeps finalized DELETING quota until a successful retry", async () => {
      const deleting = await seedPhoto({ status: "DELETING", size: 170, thumbnailSize: 30 });
      let injected = false;
      const failingOnce = { send(command) {
        const deletesTarget = command instanceof DeleteObjectCommand
          ? [deleting.originalKey, deleting.thumbnailKey].includes(command.input.Key)
          : command instanceof DeleteObjectsCommand && command.input.Delete?.Objects?.some(item => [deleting.originalKey, deleting.thumbnailKey].includes(item.Key));
        if (deletesTarget && !injected) {
          injected = true;
          throw Object.assign(new Error("Injected transient storage failure"), { $metadata: { httpStatusCode: 503 } });
        }
        return s3.send(command);
      } };
      await recoverMedia(db, failingOnce, bucket);
      assert.equal(injected, true);
      assert.equal((await db.photo.findUniqueOrThrow({ where: { id: deleting.id } })).status, "DELETING");
      const failed = await db.event.findUniqueOrThrow({ where: { id: eventId } });
      assert.equal(failed.usedStorageBytes, 200n);
      assert.equal(failed.reservedBytes, 80n);
      await recoverMedia(db, s3, bucket);
      assert.equal(await db.photo.findUnique({ where: { id: deleting.id } }), null);
      await assertPhotoObjects(deleting, false);
      const retried = await db.event.findUniqueOrThrow({ where: { id: eventId } });
      assert.equal(retried.usedStorageBytes, 0n);
      assert.equal(retried.reservedBytes, 80n);
      await recoverMedia(db, s3, bucket);
      assert.equal((await db.event.findUniqueOrThrow({ where: { id: eventId } })).usedStorageBytes, 0n);
    });

    await t.test("finalized pending, hidden and published photos survive even with an old upload deadline", async () => {
      const finalized = [];
      for (const status of ["PENDING", "HIDDEN", "PUBLISHED"]) {
        finalized.push(await seedPhoto({ status, size: 60, thumbnailSize: 10, expiresAt: new Date(0) }));
      }
      const before = await db.event.findUniqueOrThrow({ where: { id: eventId } });
      await recoverMedia(db, s3, bucket);
      for (const photo of finalized) {
        assert.equal((await db.photo.findUniqueOrThrow({ where: { id: photo.id } })).status, photo.status);
        await assertPhotoObjects(photo, true);
      }
      const after = await db.event.findUniqueOrThrow({ where: { id: eventId } });
      assert.equal(after.usedStorageBytes, before.usedStorageBytes);
      assert.equal(after.reservedBytes, before.reservedBytes);
    });

    await t.test("duplicate simultaneous recovery handles a partial upload without double releasing quota", async () => {
      const partial = await seedPhoto({ status: "PROCESSING", size: 80, thumbnailSize: 24, reserved: 104, expiresAt: new Date(0), partial: true });
      const before = await db.event.findUniqueOrThrow({ where: { id: eventId } });
      await Promise.all([recoverMedia(db, s3, bucket), recoverMedia(db, s3, bucket)]);
      assert.equal(await db.photo.findUnique({ where: { id: partial.id } }), null);
      await assertPhotoObjects(partial, false);
      const after = await db.event.findUniqueOrThrow({ where: { id: eventId } });
      assert.equal(after.reservedBytes, before.reservedBytes - 104n);
      assert.equal(after.reservedBytes, 80n);
      assert.equal(after.usedStorageBytes, before.usedStorageBytes);
      assert.equal((await db.photo.findUniqueOrThrow({ where: { id: live.id } })).reservedBytes, 80n);
      await recoverMedia(db, s3, bucket);
      assert.equal((await db.event.findUniqueOrThrow({ where: { id: eventId } })).reservedBytes, 80n);
    });
  } finally {
    if (ownKeys.size) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: [...ownKeys].map(Key => ({ Key })) } }));
    if (eventId) {
      await db.photo.deleteMany({ where: { eventId } });
      await db.event.delete({ where: { id: eventId } });
    }
    if (userId) await db.user.delete({ where: { id: userId } });
    await db.$disconnect();
    s3.destroy();
  }
});
