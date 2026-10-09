import { test as base, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { S3Client, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import argon2 from "argon2";
import sharp from "sharp";

type AlbumFixture = {
  db: PrismaClient;
  eventId: string;
  slug: string;
  userId: string;
  session: string;
};

const test = base.extend<{ album: AlbumFixture }>({
  album: async ({ page, context }, use) => {
    for (const name of ["DATABASE_URL", "S3_ENDPOINT"] as const) {
      const url = new URL(process.env[name]!);
      if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
        throw new Error("Camera fixtures require local PostgreSQL and S3 storage");
      }
    }
    const db = new PrismaClient();
    const slug = `camera-browser-${randomUUID()}`;
    const session = randomBytes(32).toString("hex");
    let userId: string | undefined;
    let eventId: string | undefined;
    try {
      const user = await db.user.create({ data: {
        email: `${slug}@example.invalid`, name: "Проверка камеры",
        passwordHash: await argon2.hash(randomBytes(24).toString("hex"), { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }),
        sessions: { create: { tokenHash: createHash("sha256").update(session).digest("hex"), expiresAt: new Date(Date.now() + 3600000) } },
      } });
      userId = user.id;
      const codeAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
      const code = Array.from(randomBytes(8), byte => codeAlphabet[byte % codeAlphabet.length]).join("");
      const event = await db.event.create({ data: {
        ownerId: user.id, title: "Моменты с камеры", slug,
        code, allowGuestUploads: true,
      } });
      eventId = event.id;
      await use({ db, eventId, slug, userId, session });
    } finally {
      // Stop gallery/view effects before deleting this test's isolated album.
      await page.goto("/").catch(() => {});
      const visitors = (await context.cookies().catch(() => [])).filter(cookie => cookie.name === "partyphoto_visitor")
        .map(cookie => createHash("sha256").update(`visitor:${cookie.value}`).digest("hex"));
      try {
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
          await db.event.deleteMany({ where: { id: eventId, ownerId: userId } });
        }
        if (userId) await db.user.deleteMany({ where: { id: userId, email: `${slug}@example.invalid` } });
        await db.authRateLimit.deleteMany({ where: { key: { in: [
          ...(userId ? [`media:upload:${userId}`] : []),
          ...(eventId ? [`media:upload:${eventId}`, `view:event:${eventId}`] : []),
          ...visitors.map(hash => `view:visitor:${hash}`),
        ] } } });
      } finally { await db.$disconnect(); }
    }
  },
});

// Chromium generates video frames; application capture and JPEG encoding stay real.
test.use({
  viewport: { width: 390, height: 844 },
  permissions: ["camera"],
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
});

async function observeCamera(page: Page) {
  await page.addInitScript(() => {
    const state = window as typeof window & { cameraTestStreams: MediaStream[] };
    state.cameraTestStreams = [];
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await getUserMedia(constraints);
      state.cameraTestStreams.push(stream);
      return stream;
    };
  });
}

async function cameraState(page: Page) {
  return page.evaluate(() => {
    const streams = (window as typeof window & { cameraTestStreams: MediaStream[] }).cameraTestStreams;
    return {
      requested: streams.length,
      live: streams.flatMap(stream => stream.getTracks()).filter(track => track.readyState === "live").length,
      audio: streams.flatMap(stream => stream.getAudioTracks()).length,
    };
  });
}

test("guest camera previews and retakes locally, then retries a failed upload without losing the photo", async ({ page, album }) => {
  test.setTimeout(90000);
  await observeCamera(page);
  const endpoint = `/api/albums/${album.slug}/photos`;
  let posts = 0;
  await page.route(`**${endpoint}`, async route => {
    if (route.request().method() !== "POST") return route.continue();
    posts++;
    if (posts === 1) {
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Временная ошибка загрузки. Повторите попытку." }) });
    }
    return route.continue();
  });
  await page.goto(`/e/${album.slug}`);
  const open = page.getByRole("button", { name: "Сделать фото", exact: true });
  await expect(open).toBeVisible();
  expect(await cameraState(page)).toEqual({ requested: 0, live: 0, audio: 0 });
  await open.click();
  const camera = page.getByRole("dialog", { name: "Камера", exact: true });
  await expect(camera).toBeVisible();
  await expect(camera.getByRole("button", { name: "Сделать снимок", exact: true })).toBeEnabled();
  await expect.poll(async () => (await cameraState(page)).live).toBeGreaterThan(0);
  expect((await cameraState(page)).audio).toBe(0);
  await camera.getByRole("button", { name: "Сделать снимок", exact: true }).click();
  await expect(camera.locator("img")).toBeVisible();
  await expect.poll(async () => (await cameraState(page)).live).toBe(0);
  expect(posts).toBe(0);
  expect(await album.db.photo.count({ where: { eventId: album.eventId } })).toBe(0);

  await camera.getByRole("button", { name: "Переснять", exact: true }).click();
  await expect(camera.getByRole("button", { name: "Сделать снимок", exact: true })).toBeEnabled();
  await expect.poll(async () => (await cameraState(page)).live).toBeGreaterThan(0);
  await camera.getByRole("button", { name: "Сделать снимок", exact: true }).click();
  const preview = camera.locator("img");
  await expect(preview).toBeVisible();
  const previewSource = await preview.getAttribute("src");
  expect(posts).toBe(0);
  await expect.poll(async () => (await cameraState(page)).live).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("camera-preview-mobile.png"), fullPage: true });

  await camera.getByRole("button", { name: "Загрузить в альбом", exact: true }).click();
  await expect(camera.getByRole("alert")).toContainText("Временная ошибка загрузки");
  await expect(preview).toHaveAttribute("src", previewSource!);
  expect(await album.db.photo.count({ where: { eventId: album.eventId } })).toBe(0);
  await camera.getByRole("button", { name: "Загрузить в альбом", exact: true }).click();
  await expect(camera).not.toBeVisible();
  await expect.poll(() => album.db.photo.count({ where: { eventId: album.eventId, status: "PUBLISHED" } })).toBe(1);
  expect(posts).toBe(2);
  const photo = await album.db.photo.findFirstOrThrow({ where: { eventId: album.eventId } });
  expect(photo.uploaderId).toBeNull();
  expect(photo.mimeType).toBe("image/jpeg");
  expect(photo.width).toBeGreaterThan(0);
  expect(photo.height).toBeGreaterThan(0);
  expect(photo.thumbnailKey).not.toBeNull();
  await expect(page.getByRole("img", { name: photo.filename, exact: true })).toBeVisible();
  const original = await page.request.get(`/api/photos/${photo.id}/original`);
  expect(original.ok()).toBe(true);
  const metadata = await sharp(await original.body()).metadata();
  expect(metadata.format).toBe("jpeg");
  expect(metadata.width).toBe(photo.width);
  expect(metadata.height).toBe(photo.height);
  expect((await cameraState(page)).live).toBe(0);
});

test("organizer camera closes without publishing, releases the stream and restores keyboard focus", async ({ page, context, baseURL, album }) => {
  await observeCamera(page);
  await context.addCookies([{ name: "partyphoto_session", value: album.session, url: baseURL!, httpOnly: true, sameSite: "Lax" }]);
  await page.goto(`/dashboard/events/${album.eventId}`);
  const open = page.getByRole("button", { name: "Сделать фото", exact: true });
  await open.click();
  const camera = page.getByRole("dialog", { name: "Камера", exact: true });
  await expect.poll(async () => (await cameraState(page)).live).toBeGreaterThan(0);
  await camera.getByRole("button", { name: "Закрыть камеру", exact: true }).click();
  await expect(camera).not.toBeVisible();
  await expect.poll(async () => (await cameraState(page)).live).toBe(0);
  await expect(open).toBeFocused();

  await open.click();
  await expect.poll(async () => (await cameraState(page)).live).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(camera).not.toBeVisible();
  await expect.poll(async () => (await cameraState(page)).live).toBe(0);
  await expect(open).toBeFocused();
  expect(await album.db.photo.count({ where: { eventId: album.eventId } })).toBe(0);

  // Disabling guest uploads also removes the camera from the public album.
  await album.db.event.update({ where: { id: album.eventId }, data: { allowGuestUploads: false } });
  await context.clearCookies();
  await page.goto(`/e/${album.slug}`);
  await expect(page.getByRole("heading", { name: "Моменты с камеры", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Сделать фото", exact: true })).toHaveCount(0);
});

test("denied camera access leaves a working device-file upload fallback", async ({ page, album }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("Permission denied", "NotAllowedError"); };
  });
  await page.goto(`/e/${album.slug}`);
  await page.getByRole("button", { name: "Сделать фото", exact: true }).click();
  const camera = page.getByRole("dialog", { name: "Камера", exact: true });
  await expect(camera.getByRole("alert")).toBeVisible();
  await expect(camera.getByRole("button", { name: "Загрузить в альбом", exact: true })).toHaveCount(0);
  const fileChooser = page.waitForEvent("filechooser");
  await camera.getByRole("button", { name: "Выбрать фото с устройства", exact: true }).click();
  const buffer = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#718447" } }).jpeg().toBuffer();
  await (await fileChooser).setFiles({ name: "camera-permission-fallback.jpg", mimeType: "image/jpeg", buffer });
  await expect(camera).not.toBeVisible();
  await page.getByRole("button", { name: "Загрузить фотографии", exact: true }).click();
  await expect(page.getByRole("img", { name: "camera-permission-fallback.jpg", exact: true })).toBeVisible();
  expect(await album.db.photo.count({ where: { eventId: album.eventId, status: "PUBLISHED" } })).toBe(1);
});

test("late camera permission, backgrounding and route unmount never leave a live stream", async ({ page, album }) => {
  await observeCamera(page);
  const event = await album.db.event.findUniqueOrThrow({ where: { id: album.eventId }, select: { code: true } });
  await page.goto("/join");
  await page.getByLabel("Код мероприятия", { exact: true }).fill(event.code);
  await page.getByRole("button", { name: "Открыть альбом", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/e/${album.slug}$`));
  await page.evaluate(() => {
    const state = window as typeof window & { cameraTestRelease: () => void };
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    let holdPermission = true;
    const pending: Array<() => void> = [];
    state.cameraTestRelease = () => {
      holdPermission = false;
      pending.splice(0).forEach(release => release());
    };
    // Delay only the browser response; the stream and tracks remain real.
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await getUserMedia(constraints);
      if (holdPermission) await new Promise<void>(resolve => pending.push(resolve));
      return stream;
    };
  });
  const open = page.getByRole("button", { name: "Сделать фото", exact: true });
  const camera = page.getByRole("dialog", { name: "Камера", exact: true });
  await open.click();
  await expect.poll(async () => (await cameraState(page)).requested).toBeGreaterThan(0);
  await expect(camera.getByRole("button", { name: "Сделать снимок", exact: true })).toBeDisabled();
  await camera.getByRole("button", { name: "Закрыть камеру", exact: true }).click();
  await expect(camera).not.toBeVisible();
  await page.evaluate(() => (window as typeof window & { cameraTestRelease: () => void }).cameraTestRelease());
  await expect.poll(async () => (await cameraState(page)).live).toBe(0);

  await open.click();
  await expect(camera.getByRole("button", { name: "Сделать снимок", exact: true })).toBeEnabled();
  await expect.poll(async () => (await cameraState(page)).live).toBeGreaterThan(0);
  const beforeBackground = (await cameraState(page)).requested;
  await page.evaluate(() => {
    // Headless Chrome does not consistently background tabs. Emit its lifecycle
    // state change without replacing MediaStream or the application's handler.
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const resume = camera.getByRole("button", { name: "Включить камеру", exact: true });
  await expect(resume).toBeVisible();
  await expect.poll(async () => (await cameraState(page)).live).toBe(0);
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "visibilityState");
    Reflect.deleteProperty(document, "hidden");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(resume).toBeVisible();
  expect(await cameraState(page)).toMatchObject({ requested: beforeBackground, live: 0 });
  await resume.click();
  await expect(camera.getByRole("button", { name: "Сделать снимок", exact: true })).toBeEnabled();
  await expect.poll(async () => (await cameraState(page)).requested).toBeGreaterThan(beforeBackground);
  await expect.poll(async () => (await cameraState(page)).live).toBeGreaterThan(0);
  const beforeNavigation = (await cameraState(page)).requested;

  // Restore the previous App Router entry to exercise React unmount rather
  // than a full document unload that would release tracks for us.
  await page.goBack();
  await expect(page).toHaveURL(/\/join$/);
  await expect(camera).not.toBeVisible();
  await expect.poll(async () => (await cameraState(page)).live).toBe(0);
  expect((await cameraState(page)).requested).toBe(beforeNavigation);
  expect(await album.db.photo.count({ where: { eventId: album.eventId } })).toBe(0);
});
