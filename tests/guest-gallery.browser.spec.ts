import { test as base, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import argon2 from "argon2";
import sharp from "sharp";

type GuestAlbum = { db: PrismaClient; eventId: string; slug: string; title: string; newest: string; popular: string };

const test = base.extend<{ album: GuestAlbum }>({
  album: async ({ page, context }, use) => {
    const database = new URL(process.env.DATABASE_URL!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(database.hostname)) {
      throw new Error("Guest gallery fixtures require local PostgreSQL");
    }
    const db = new PrismaClient();
    const slug = `guest-gallery-${randomUUID()}`;
    const title = "Вечер вместе";
    const newest = "newest-memory.jpg";
    const popular = "favorite-memory.jpg";
    let userId: string | undefined;
    let eventId: string | undefined;
    try {
      const user = await db.user.create({ data: {
        email: `${slug}@example.invalid`, name: "Проверка гостевой галереи",
        passwordHash: await argon2.hash(randomBytes(24).toString("hex"), { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }),
      } });
      userId = user.id;
      const event = await db.event.create({ data: {
        ownerId: user.id, title, description: "Наши фотографии с одного прекрасного вечера.", slug,
        code: randomBytes(4).toString("hex").toUpperCase(), allowGuestUploads: true,
      } });
      eventId = event.id;
      for (const [index, filename] of [newest, popular, "hidden-memory.jpg"].entries()) {
        await db.photo.create({ data: {
          eventId, filename, originalKey: `${slug}/${filename}`, thumbnailKey: `${slug}/thumb-${filename}`,
          mimeType: "image/jpeg", sizeBytes: 128, width: 800, height: 600,
          status: index === 2 ? "HIDDEN" : "PUBLISHED", createdAt: new Date(Date.now() - index * 60000),
          likes: { create: Array.from({ length: index === 1 ? 2 : index === 2 ? 3 : 0 }, () => ({ voterHash: randomBytes(32).toString("hex") })) },
        } });
      }
      // Fixture photos exercise real database/API ordering; only the absent S3
      // thumbnails are replaced with a small local image.
      const thumbnail = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#b5bc9b" } }).jpeg().toBuffer();
      await page.route("**/api/photos/*/thumbnail", route => route.fulfill({ status: 200, contentType: "image/jpeg", body: thumbnail }));
      await use({ db, eventId, slug, title, newest, popular });
    } finally {
      await page.goto("/").catch(() => {});
      const visitors = (await context.cookies().catch(() => [])).filter(cookie => cookie.name === "partyphoto_visitor")
        .map(cookie => createHash("sha256").update(`visitor:${cookie.value}`).digest("hex"));
      try {
        if (eventId) {
          await db.photo.deleteMany({ where: { eventId } });
          await db.mediaJob.deleteMany({ where: { eventId } });
          await db.event.deleteMany({ where: { id: eventId, ownerId: userId } });
        }
        if (userId) await db.user.deleteMany({ where: { id: userId, email: `${slug}@example.invalid` } });
        await db.authRateLimit.deleteMany({ where: { key: { in: [
          ...(eventId ? [`view:event:${eventId}`] : []), ...visitors.map(hash => `view:visitor:${hash}`),
        ] } } });
      } finally { await db.$disconnect(); }
    }
  },
});

async function noAccountNavigation(page: Page) {
  await expect(page.getByRole("navigation", { name: "Основные разделы", exact: true })).toHaveCount(0);
  await expect(page.locator('a[href="/"], a[href="/join"], a[href^="/dashboard"], a[href^="/admin"], a[href="/login"], a[href="/register"]')).toHaveCount(0);
}

async function capture(page: Page, filename: string) {
  const directory = resolve(".data/guest-review");
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, filename), fullPage: true, animations: "disabled" });
}

test("guest album stays focused on the event, sorts real photos by likes, and fits both mobile themes", async ({ page, album }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/e/${album.slug}`);
  await expect(page.getByRole("heading", { name: album.title, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Галерея", exact: true })).toBeVisible();
  await noAccountNavigation(page);
  const nav = page.getByRole("navigation", { name: "Навигация мероприятия", exact: true });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole("button", { name: "Сделать фото", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Добавить фотки", exact: true })).toBeVisible();
  await expect(nav.getByText("Галерея", { exact: true })).toBeVisible();
  await expect(page.locator(".photo-upload")).toBeHidden();
  const previews = page.locator(".photo-grid .photo-preview-button");
  await expect(previews).toHaveCount(2);
  await expect(previews.first()).toHaveAttribute("aria-label", `Открыть фотографию ${album.newest}`);
  await expect(page.getByRole("button", { name: "Новые", exact: true })).toHaveAttribute("aria-pressed", "true");
  const likedResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === `/api/albums/${album.slug}/photos` && url.searchParams.get("sort") === "likes";
  });
  await page.getByRole("button", { name: "По лайкам", exact: true }).click();
  expect((await likedResponse).ok()).toBe(true);
  await expect(page.getByRole("button", { name: "По лайкам", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(previews.first()).toHaveAttribute("aria-label", `Открыть фотографию ${album.popular}`);
  await expect(previews).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Открыть фотографию hidden-memory.jpg", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Поставить лайк ${album.popular}`, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: `Скачать оригинал ${album.popular}`, exact: true })).toBeVisible();

  await page.getByRole("button", { name: `Открыть фотографию ${album.popular}`, exact: true }).click();
  const preview = page.getByRole("dialog", { name: album.popular, exact: true });
  await expect(preview).toBeVisible();
  await expect(preview.getByRole("link", { name: /Скачать оригинал/ })).toBeVisible();
  await preview.getByRole("button", { name: "Закрыть просмотр фотографии", exact: true }).click();
  await page.getByRole("button", { name: "Новые", exact: true }).click();
  await expect(previews.first()).toHaveAttribute("aria-label", `Открыть фотографию ${album.newest}`);

  for (const theme of ["light", "dark"] as const) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) {
      await page.getByRole("button", { name: theme === "dark" ? "Включить тёмную тему" : "Включить светлую тему", exact: true }).click();
    }
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      await expect(nav).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const image = await page.locator(".photo-image-wrap").first().boundingBox();
      expect(image).not.toBeNull();
      expect(Math.abs(image!.width - image!.height)).toBeLessThanOrEqual(2);
      const overlays = await page.locator(".photo-card").evaluateAll(cards => cards.flatMap(card => {
        const bounds = card.getBoundingClientRect();
        return Array.from(card.querySelectorAll(".photo-card-actions, .photo-card-actions button, .photo-card-actions a"), control => {
          const rect = control.getBoundingClientRect();
          return { label: control.getAttribute("aria-label") ?? "Photo action overlay", inside:
            rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 &&
            rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1 };
        });
      }));
      expect(overlays.length).toBeGreaterThan(0);
      for (const overlay of overlays) expect(overlay.inside, `${overlay.label} must fit inside its photo card at ${width}px`).toBe(true);
      await capture(page, `guest-${theme}-${width}.png`);
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const selectedName = "guest-selected-but-not-uploaded.jpg";
  let uploadRequests = 0;
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `/api/albums/${album.slug}/photos`) uploadRequests++;
  });
  const chooser = page.waitForEvent("filechooser");
  await nav.getByRole("button", { name: "Добавить фотки", exact: true }).click();
  const selectedImage = await sharp({ create: { width: 160, height: 120, channels: 3, background: "#b5bc9b" } }).jpeg().toBuffer();
  await (await chooser).setFiles({ name: selectedName, mimeType: "image/jpeg", buffer: selectedImage });
  await expect(page.locator(".photo-upload")).toBeVisible();
  const fileInput = page.getByLabel("Выберите фотографии", { exact: true });
  await expect(fileInput).toBeVisible();
  await expect(fileInput).toBeFocused();
  await expect(page.locator(".upload-file-list")).toContainText(selectedName);
  await expect(page.getByRole("button", { name: "Загрузить фотографии", exact: true })).toBeEnabled();
  expect(uploadRequests).toBe(0);
  expect(await album.db.photo.count({ where: { eventId: album.eventId, filename: selectedName } })).toBe(0);
});

test("view-only and password-locked albums keep event-only navigation while the homepage keeps global links", async ({ page, album }) => {
  await album.db.event.update({ where: { id: album.eventId }, data: { allowGuestUploads: false, allowDownloads: false } });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(`/e/${album.slug}`);
  await expect(page.locator(".photo-grid .photo-preview-button")).toHaveCount(2);
  await noAccountNavigation(page);
  await expect(page.getByRole("navigation", { name: "Навигация мероприятия", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Сделать фото", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Добавить фотки", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Скачать оригинал/ })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await capture(page, "guest-view-only-320.png");

  await album.db.event.update({ where: { id: album.eventId }, data: {
    passwordHash: await argon2.hash("album-test-password", { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }),
  } });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Альбом защищён паролем", exact: true })).toBeVisible();
  await expect(page.getByLabel("Пароль альбома", { exact: true })).toBeVisible();
  await noAccountNavigation(page);
  await expect(page.locator(".photo-grid")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Навигация мероприятия", exact: true })).toHaveCount(0);
  expect((await page.request.get(`/api/albums/${album.slug}/photos?sort=likes`)).status()).toBe(401);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await capture(page, "guest-locked-320.png");

  await page.goto("/");
  const global = page.getByRole("navigation", { name: "Основные разделы", exact: true });
  await expect(global.getByRole("link", { name: "Главная", exact: true })).toBeVisible();
  await expect(global.getByRole("link", { name: "Кабинет", exact: true })).toBeVisible();
});

test("long like failures remain readable and accessible without changing likes on mobile cards or previews", async ({ page, album }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const photo = await album.db.photo.findFirstOrThrow({ where: { eventId: album.eventId, filename: album.popular } });
  const message = "Не удалось сохранить лайк. Сервер временно недоступен. " +
    "Проверьте подключение к интернету и повторите попытку чуть позже. Состояние фотографии осталось прежним. ".repeat(4);
  let failedRequests = 0;
  await page.route(`**/api/photos/${photo.id}/like`, route => {
    expect(route.request().method()).toBe("PUT");
    failedRequests++;
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: message }) });
  });
  await page.goto(`/e/${album.slug}`);
  const like = page.getByRole("button", { name: `Поставить лайк ${album.popular}`, exact: true });
  await expect(like).toHaveAttribute("aria-pressed", "false");
  await expect(like).toContainText("2");
  await like.click();
  const cardError = page.locator(".guest-like-error");
  await expect(cardError).toHaveAttribute("role", "alert");
  await expect(cardError).toContainText(`${album.popular}: ${message}`);
  await expect(cardError).toBeVisible();
  const errorId = await cardError.getAttribute("id");
  expect((await like.getAttribute("aria-describedby"))?.split(/\s+/)).toContain(errorId);
  expect(await cardError.evaluate(element => element.closest(".photo-card") === null)).toBe(true);
  await cardError.scrollIntoViewIfNeeded();
  const errorBounds = await cardError.boundingBox();
  const gridBounds = await page.locator(".photo-grid").boundingBox();
  expect(errorBounds!.y + errorBounds!.height).toBeLessThanOrEqual(gridBounds!.y + 1);
  expect(errorBounds!.x).toBeGreaterThanOrEqual(0);
  expect(errorBounds!.x + errorBounds!.width).toBeLessThanOrEqual(320);
  expect(await cardError.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(like).toHaveAttribute("aria-pressed", "false");
  await expect(like).toContainText("2");
  await expect(like).toBeEnabled();
  await capture(page, "guest-like-error-card-320.png");

  await page.getByRole("button", { name: `Открыть фотографию ${album.popular}`, exact: true }).click();
  const preview = page.getByRole("dialog", { name: album.popular, exact: true });
  const previewLike = preview.getByRole("button", { name: `Поставить лайк ${album.popular}`, exact: true });
  await previewLike.click();
  const previewError = preview.getByRole("alert");
  await expect(previewError).toHaveText(message);
  await expect(previewError).toBeVisible();
  const previewErrorId = await previewError.getAttribute("id");
  expect((await previewLike.getAttribute("aria-describedby"))?.split(/\s+/)).toContain(previewErrorId);
  await previewError.scrollIntoViewIfNeeded();
  const layout = await previewError.evaluate(element => {
    const dialog = element.closest("dialog")!;
    const error = element.getBoundingClientRect();
    const bounds = dialog.getBoundingClientRect();
    return {
      inside: error.left >= bounds.left - 1 && error.right <= bounds.right + 1 &&
        error.top >= bounds.top - 1 && error.bottom <= bounds.bottom + 1,
      noHorizontalOverflow: dialog.scrollWidth <= dialog.clientWidth && element.scrollWidth <= element.clientWidth,
    };
  });
  expect(layout).toEqual({ inside: true, noHorizontalOverflow: true });
  await expect(previewLike).toHaveAttribute("aria-pressed", "false");
  await expect(previewLike).toContainText("2");
  await expect(previewLike).toBeEnabled();
  expect(failedRequests).toBe(2);
  expect(await album.db.photoLike.count({ where: { photoId: photo.id } })).toBe(2);
  await capture(page, "guest-like-error-preview-320.png");
});

test("switching sort discards a delayed next page from the previous order", async ({ page, album }) => {
  await album.db.photo.createMany({ data: Array.from({ length: 40 }, (_, index) => ({
    eventId: album.eventId, filename: `extra-${index}.jpg`, originalKey: `${album.slug}/extra-${index}.jpg`,
    thumbnailKey: `${album.slug}/extra-thumb-${index}.jpg`, mimeType: "image/jpeg", sizeBytes: 128,
    width: 800, height: 600, status: "PUBLISHED" as const, createdAt: new Date(Date.now() - (index + 3) * 60000),
  })) });
  let release: () => void = () => {};
  let announceHeld: () => void = () => {};
  let announceFinished: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = new Promise<void>(resolve => { announceHeld = resolve; });
  const finished = new Promise<void>(resolve => { announceFinished = resolve; });
  let intercepted = false;
  await page.route(`**/api/albums/${album.slug}/photos?**`, async route => {
    const url = new URL(route.request().url());
    if (!intercepted && url.searchParams.has("cursor") && url.searchParams.get("sort") !== "likes") {
      intercepted = true;
      const response = await route.fetch();
      announceHeld();
      await gate;
      try { await route.fulfill({ response }); }
      catch { /* Switching sort may already have aborted this request. */ }
      finally { announceFinished(); }
      return;
    }
    await route.continue();
  });
  try {
    await page.goto(`/e/${album.slug}`);
    const previews = page.locator(".photo-grid .photo-preview-button");
    await expect(previews).toHaveCount(40);
    await page.getByRole("button", { name: "Показать ещё", exact: true }).click();
    await held;
    await page.getByRole("button", { name: "По лайкам", exact: true }).click();
    await expect(previews.first()).toHaveAttribute("aria-label", `Открыть фотографию ${album.popular}`);
    await expect(previews).toHaveCount(40);
    release();
    await finished;
    await expect(previews).toHaveCount(40);
    await page.getByRole("button", { name: "Показать ещё", exact: true }).click();
    await expect(previews).toHaveCount(42);
    const labels = await previews.evaluateAll(elements => elements.map(element => element.getAttribute("aria-label")));
    expect(new Set(labels).size).toBe(42);
    await expect(previews.first()).toHaveAttribute("aria-label", `Открыть фотографию ${album.popular}`);
    await expect(page.getByRole("button", { name: "Показать ещё", exact: true })).toHaveCount(0);
  } finally { release(); }
});
