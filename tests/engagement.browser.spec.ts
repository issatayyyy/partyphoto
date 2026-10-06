import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { S3Client, PutObjectCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import argon2 from "argon2";
import sharp from "sharp";
import { processZipJob } from "../scripts/zip-worker.mjs";

test("mobile guests like a photo across reloads and download its completed ZIP", async ({ page, browser, baseURL }) => {
  test.setTimeout(90000);
  const db = new PrismaClient();
  const s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT!, region: process.env.S3_REGION!, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
    requestHandler: { connectionTimeout: 5000, requestTimeout: 30000, throwOnRequestTimeout: true },
  });
  const bucket = process.env.S3_BUCKET!;
  const namespace = `engagement-ui-${randomUUID()}`;
  const filename = "friends-memory.jpg";
  const keys = new Set<string>();
  let userId: string | undefined;
  let eventId: string | undefined;
  let visitor2: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    const passwordHash = await argon2.hash("12345678", { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const user = await db.user.create({ data: { email: `${namespace}@example.invalid`, name: "Проверка ZIP и лайков", passwordHash } });
    userId = user.id;
    const event = await db.event.create({ data: { ownerId: user.id, title: "Воспоминания вместе", slug: namespace, code: randomBytes(4).toString("hex").toUpperCase() } });
    eventId = event.id;
    const jpeg = await sharp({ create: { width: 900, height: 600, channels: 3, background: "#f97355" } }).jpeg().toBuffer();
    const thumbnail = await sharp(jpeg).webp().toBuffer();
    const photoId = randomUUID();
    const originalKey = `events/${event.id}/photos/${photoId}/original.jpeg`;
    const thumbnailKey = `events/${event.id}/photos/${photoId}/thumbnail.webp`;
    keys.add(originalKey); keys.add(thumbnailKey);
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: originalKey, Body: jpeg, ContentType: "image/jpeg" }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: thumbnailKey, Body: thumbnail, ContentType: "image/webp" }));
    await db.photo.create({ data: { id: photoId, eventId: event.id, originalKey, thumbnailKey, filename, mimeType: "image/jpeg", sizeBytes: BigInt(jpeg.length), thumbnailBytes: BigInt(thumbnail.length), width: 900, height: 600, status: "PUBLISHED" } });
    await db.event.update({ where: { id: event.id }, data: { usedStorageBytes: BigInt(jpeg.length + thumbnail.length) } });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/e/${event.slug}`);
    await expect(page.getByRole("img", { name: filename, exact: true })).toBeVisible();
    const like = page.getByRole("button", { name: `Поставить лайк ${filename}`, exact: true });
    await expect(like).toHaveAttribute("aria-pressed", "false");
    await like.click();
    const unlike = page.getByRole("button", { name: `Убрать лайк ${filename}`, exact: true });
    await expect(unlike).toHaveAttribute("aria-pressed", "true");
    await expect(unlike).toContainText("1");
    await page.reload();
    await expect(page.getByRole("button", { name: `Убрать лайк ${filename}`, exact: true })).toHaveAttribute("aria-pressed", "true");
    const visitor = (await page.context().cookies(baseURL!)).find(cookie => cookie.name === "partyphoto_visitor");
    expect(visitor?.httpOnly).toBe(true);
    expect(visitor?.value).toMatch(/^[a-f0-9]{64}$/);

    visitor2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const otherPage = await visitor2.newPage();
    await otherPage.goto(new URL(`/e/${event.slug}`, baseURL).href);
    const otherLike = otherPage.getByRole("button", { name: `Поставить лайк ${filename}`, exact: true });
    await expect(otherLike).toHaveAttribute("aria-pressed", "false");
    await expect(otherLike).toContainText("1");
    await otherLike.click();
    await expect(otherPage.getByRole("button", { name: `Убрать лайк ${filename}`, exact: true })).toContainText("2");
    await page.reload();
    const originalUnlike = page.getByRole("button", { name: `Убрать лайк ${filename}`, exact: true });
    await expect(originalUnlike).toContainText("2");
    await originalUnlike.click();
    await expect(page.getByRole("button", { name: `Поставить лайк ${filename}`, exact: true })).toContainText("1");

    await page.getByRole("button", { name: "Скачать всё ZIP", exact: true }).click();
    await expect.poll(() => db.mediaJob.count({ where: { eventId: event.id, kind: "ZIP" } }), { timeout: 10000 }).toBe(1);
    const job = await db.mediaJob.findFirstOrThrow({ where: { eventId: event.id, kind: "ZIP" } });
    // The same production worker function runs when tests pause the background loop.
    await processZipJob(db, s3, bucket, { eventId: event.id, jobId: job.id });
    await expect.poll(async () => (await db.mediaJob.findUniqueOrThrow({ where: { id: job.id } })).status, { timeout: 60000 }).toBe("DONE");
    const finished = await db.mediaJob.findUniqueOrThrow({ where: { id: job.id } });
    if (finished.resultKey) keys.add(finished.resultKey);
    expect(finished.status).toBe("DONE");
    const downloadLink = page.getByRole("link", { name: "Скачать готовый ZIP", exact: true });
    await expect(downloadLink).toBeVisible({ timeout: 60000 });
    const downloadPromise = page.waitForEvent("download");
    await downloadLink.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.zip$/i);
    const path = await download.path();
    expect(path).not.toBeNull();
    const zip = await readFile(path!);
    expect([...zip.subarray(0, 4)]).toEqual([80, 75, 3, 4]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("engagement-guest-mobile.png"), fullPage: true });
    await page.reload();
    await expect(page.getByRole("link", { name: "Скачать готовый ZIP", exact: true })).toBeVisible();
  } finally {
    const cookies = [...await page.context().cookies(baseURL!), ...(visitor2 ? await visitor2.cookies(baseURL!) : [])];
    const voters = cookies.filter(cookie => cookie.name === "partyphoto_visitor").map(cookie => createHash("sha256").update(`visitor:${cookie.value}`).digest("hex"));
    await visitor2?.close();
    if (eventId) {
      const jobs = await db.mediaJob.findMany({ where: { eventId, kind: "ZIP" }, select: { resultKey: true } });
      for (const job of jobs) if (job.resultKey) keys.add(job.resultKey);
      if (keys.size) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: [...keys].map(Key => ({ Key })) } }));
      const photos = await db.photo.findMany({ where: { eventId }, select: { id: true } });
      await db.photoLike.deleteMany({ where: { photoId: { in: photos.map(photo => photo.id) } } });
      await db.photo.deleteMany({ where: { eventId } });
      await db.mediaJob.deleteMany({ where: { eventId } });
      await db.event.delete({ where: { id: eventId } });
    }
    if (userId) await db.user.delete({ where: { id: userId } });
    await db.authRateLimit.deleteMany({ where: { key: { in: [
      ...voters.flatMap(voter => [`like:voter:${voter}`, `zip:create:${voter}`]),
      ...(eventId ? [`like:event:${eventId}`, `zip:create:${eventId}`] : []),
    ] } } });
    await db.$disconnect();
    s3.destroy();
  }
});
