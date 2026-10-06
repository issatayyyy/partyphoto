import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { S3Client, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import argon2 from "argon2";
import sharp from "sharp";

test("mobile photo batches, guest moderation, original downloads and removal work in the browser", async ({ page, context, browser, baseURL }) => {
  test.setTimeout(90000);
  const db = new PrismaClient();
  const namespace = `media-browser-${randomUUID()}`;
  const token = randomBytes(32).toString("hex");
  const jpegName = "friends-original.jpg";
  const pngName = "party-original.png";
  const guestName = "guest-memory.png";
  let userId: string | undefined;
  let eventId: string | undefined;
  let guestContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    const passwordHash = await argon2.hash("12345678", { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const user = await db.user.create({ data: {
      email: `${namespace}@example.invalid`, name: "Проверка фотографий", passwordHash,
      sessions: { create: { tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 3600000) } },
    } });
    userId = user.id;
    const event = await db.event.create({ data: {
      ownerId: user.id, title: "Фотографии друзей", slug: namespace,
      code: randomBytes(4).toString("hex").toUpperCase(), allowGuestUploads: true, moderateUploads: true,
    } });
    eventId = event.id;
    const jpeg = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: "#ffc43d" } }).jpeg({ quality: 95 }).toBuffer();
    const png = await sharp({ create: { width: 600, height: 400, channels: 3, background: "#7a6ff0" } }).png().toBuffer();
    await context.addCookies([{ name: "partyphoto_session", value: token, url: baseURL!, httpOnly: true, sameSite: "Lax" }]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/dashboard/events/${event.id}`);
    await expect(page.getByRole("heading", { name: event.title, exact: true })).toBeVisible();
    await page.getByLabel("Выберите фотографии", { exact: true }).setInputFiles([
      { name: jpegName, mimeType: "", buffer: jpeg },
      { name: pngName, mimeType: "image/png", buffer: png },
    ]);
    await page.getByRole("button", { name: "Загрузить фотографии", exact: true }).click();
    await expect(page.getByRole("img", { name: jpegName, exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: pngName, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("media-owner-mobile.png"), fullPage: true });

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: `Скачать оригинал ${jpegName}`, exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(jpegName);
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    expect(await readFile(downloadPath!)).toEqual(jpeg);

    guestContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const guestPage = await guestContext.newPage();
    await guestPage.goto(new URL(`/e/${event.slug}`, baseURL).href);
    await expect(guestPage.getByRole("img", { name: jpegName, exact: true })).toBeVisible();
    await expect(guestPage.getByRole("img", { name: pngName, exact: true })).toBeVisible();
    await guestPage.getByLabel("Выберите фотографии", { exact: true }).setInputFiles({ name: guestName, mimeType: "image/png", buffer: png });
    await guestPage.getByRole("button", { name: "Загрузить фотографии", exact: true }).click();
    await expect(guestPage.getByText("Отправлено на проверку", { exact: true })).toBeVisible();
    await expect(guestPage.getByRole("img", { name: guestName, exact: true })).toHaveCount(0);
    const guestPhoto = await db.photo.findFirstOrThrow({ where: { eventId: event.id, filename: guestName } });
    expect(guestPhoto.status).toBe("PENDING");

    await page.reload();
    await expect(page.getByRole("img", { name: guestName, exact: true })).toBeVisible();
    await expect(page.getByText("На проверке", { exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: `Выбрать фотографию ${guestName}`, exact: true }).check();
    await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
    await expect(page.getByText("На проверке", { exact: true })).toHaveCount(0);
    await guestPage.reload();
    await expect(guestPage.getByRole("img", { name: guestName, exact: true })).toBeVisible();

    await page.getByRole("checkbox", { name: `Выбрать фотографию ${guestName}`, exact: true }).check();
    await page.getByRole("button", { name: "Скрыть", exact: true }).click();
    await expect(page.getByText("Скрыто", { exact: true })).toBeVisible();
    await guestPage.reload();
    await expect(guestPage.getByRole("img", { name: guestName, exact: true })).toHaveCount(0);
    expect((await guestContext.request.get(new URL(`/api/photos/${guestPhoto.id}/original`, baseURL).href)).status()).toBe(404);

    await page.getByRole("checkbox", { name: `Выбрать фотографию ${guestName}`, exact: true }).check();
    await page.getByRole("button", { name: "Удалить", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Удалить выбранные фотографии?" });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "Удалить фотографии", exact: true }).click();
    await expect(page.getByRole("img", { name: guestName, exact: true })).toHaveCount(0);
    expect((await context.request.get(new URL(`/api/photos/${guestPhoto.id}/thumbnail`, baseURL).href)).status()).toBe(404);
    expect(await guestPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await guestPage.screenshot({ path: test.info().outputPath("media-guest-mobile.png"), fullPage: true });
  } finally {
    await guestContext?.close();
    if (eventId) {
      const photos = await db.photo.findMany({ where: { eventId }, select: { originalKey: true, thumbnailKey: true } });
      const keys = photos.flatMap(photo => [photo.originalKey, photo.thumbnailKey].filter((key): key is string => key !== null));
      if (keys.length) {
        const client = new S3Client({
          endpoint: process.env.S3_ENDPOINT!, region: process.env.S3_REGION!, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
          credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
        });
        try { await client.send(new DeleteObjectsCommand({ Bucket: process.env.S3_BUCKET!, Delete: { Objects: keys.map(Key => ({ Key })) } })); }
        finally { client.destroy(); }
      }
      await db.photo.deleteMany({ where: { eventId } });
      await db.mediaJob.deleteMany({ where: { eventId } });
      await db.accessToken.deleteMany({ where: { eventId } });
      await db.eventMember.deleteMany({ where: { eventId } });
      await db.event.delete({ where: { id: eventId } });
    }
    if (userId) await db.user.delete({ where: { id: userId } });
    await db.authRateLimit.deleteMany({ where: { key: { in: [
      ...(userId ? [`media:upload:${userId}`] : []),
      ...(eventId ? [`media:upload:${eventId}`, `media:moderate:${eventId}`] : []),
    ] } } });
    await db.$disconnect();
  }
});
