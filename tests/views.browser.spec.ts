import { test, expect } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import argon2 from "argon2";

function viewResponse(page: Page, slug: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === `/api/albums/${slug}/view` && response.request().method() === "POST", { timeout: 15000 });
}

test("mobile album views count browsers once and private albums count only after unlock", async ({ page, browser, baseURL }) => {
  test.setTimeout(90000);
  const db = new PrismaClient();
  const namespace = `views-browser-${randomUUID()}`;
  const token = randomBytes(32).toString("hex");
  const albumPassword = "abc";
  let userId: string | undefined;
  const eventIds: string[] = [];
  let secondVisitor: BrowserContext | undefined;
  let organizer: BrowserContext | undefined;
  try {
    const passwordHash = await argon2.hash(albumPassword, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const user = await db.user.create({ data: {
      email: `${namespace}@example.invalid`, name: "Проверка просмотров", passwordHash,
      sessions: { create: { tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 3600000) } },
    } });
    userId = user.id;
    const publicAlbum = await db.event.create({ data: { ownerId: user.id, title: "Открытый альбом просмотров", slug: `${namespace}-public`, code: randomBytes(4).toString("hex").toUpperCase() } });
    eventIds.push(publicAlbum.id);
    const privateAlbum = await db.event.create({ data: { ownerId: user.id, title: "Закрытый альбом просмотров", description: "Фотографии доступны после ввода пароля.", passwordHash, slug: `${namespace}-private`, code: randomBytes(4).toString("hex").toUpperCase() } });
    eventIds.push(privateAlbum.id);
    const countViews = async (id: string) => (await db.event.findUniqueOrThrow({ where: { id }, select: { viewCount: true } })).viewCount;

    await page.setViewportSize({ width: 390, height: 844 });
    await test.step("First mobile guest view and visitor cookie", async () => {
      const firstView = viewResponse(page, publicAlbum.slug);
      await page.goto(`/e/${publicAlbum.slug}`);
      await expect(page.getByRole("heading", { name: publicAlbum.title, exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Первые моменты ещё впереди", exact: true })).toBeVisible();
      expect((await firstView).ok()).toBe(true);
      await expect.poll(() => countViews(publicAlbum.id)).toBe(1n);
      const visitorCookie = (await page.context().cookies(baseURL!)).find(cookie => cookie.name === "partyphoto_visitor");
      expect(visitorCookie?.httpOnly).toBe(true);
      expect(visitorCookie?.value).toMatch(/^[a-f0-9]{64}$/);
    });

    await test.step("Reload retains the same view count", async () => {
      const reloadView = viewResponse(page, publicAlbum.slug);
      await page.reload();
      expect((await reloadView).ok()).toBe(true);
      expect(await countViews(publicAlbum.id)).toBe(1n);
    });
    await test.step("Gallery refresh retains the same view count", async () => {
      const refreshedView = viewResponse(page, publicAlbum.slug);
      await page.getByRole("button", { name: "Обновить", exact: true }).click();
      expect((await refreshedView).ok()).toBe(true);
      expect(await countViews(publicAlbum.id)).toBe(1n);
    });

    secondVisitor = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const otherPage = await secondVisitor.newPage();
    await test.step("A separate browser visitor increments the count", async () => {
      const secondView = viewResponse(otherPage, publicAlbum.slug);
      await otherPage.goto(new URL(`/e/${publicAlbum.slug}`, baseURL).href);
      expect((await secondView).ok()).toBe(true);
      await expect.poll(() => countViews(publicAlbum.id)).toBe(2n);
    });

    organizer = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await organizer.addCookies([{ name: "partyphoto_session", value: token, url: baseURL!, httpOnly: true, sameSite: "Lax" }]);
    const dashboard = await organizer.newPage();
    let staffViewRequests = 0;
    dashboard.on("request", request => { if (new URL(request.url()).pathname.endsWith("/view") && request.method() === "POST") staffViewRequests++; });
    const stats = dashboard.getByRole("region", { name: "Статистика мероприятия" });
    const viewsStat = stats.locator("div").filter({ hasText: "Просмотры" }).locator("strong");
    await test.step("Organizer statistics display guest views without adding a staff view", async () => {
      await dashboard.goto(new URL(`/dashboard/events/${publicAlbum.id}`, baseURL).href);
      await expect(viewsStat).toHaveText("2");
      await expect(stats.getByText("Один браузер — один просмотр за 24 часа.", { exact: true })).toBeVisible();
      await expect(dashboard.getByRole("heading", { name: "Первые моменты ещё впереди", exact: true })).toBeVisible();
      expect(staffViewRequests).toBe(0);
      expect(await countViews(publicAlbum.id)).toBe(2n);
      expect(await dashboard.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });

    // An organizer who opens the guest page is still another browser visitor.
    await test.step("Organizer opening the guest page counts as another browser", async () => {
      const organizerView = viewResponse(dashboard, publicAlbum.slug);
      await dashboard.goto(new URL(`/e/${publicAlbum.slug}`, baseURL).href);
      expect((await organizerView).ok()).toBe(true);
      await expect.poll(() => countViews(publicAlbum.id)).toBe(3n);
      await dashboard.goto(new URL(`/dashboard/events/${publicAlbum.id}`, baseURL).href);
      await expect(viewsStat).toHaveText("3");
    });

    let lockedViewRequests = 0;
    page.on("request", request => { if (new URL(request.url()).pathname === `/api/albums/${privateAlbum.slug}/view` && request.method() === "POST") lockedViewRequests++; });
    await test.step("Locked and rejected private album access never records a view", async () => {
    await page.goto(`/e/${privateAlbum.slug}`);
    await expect(page.getByRole("heading", { name: "Альбом защищён паролем", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Фотографии", exact: true })).toHaveCount(0);
    expect(await countViews(privateAlbum.id)).toBe(0n);
    expect(lockedViewRequests).toBe(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Альбом защищён паролем", exact: true })).toBeVisible();
    expect(await countViews(privateAlbum.id)).toBe(0n);
    expect(lockedViewRequests).toBe(0);
    await page.getByLabel("Пароль альбома", { exact: true }).fill("wrong-password");
    await page.getByRole("button", { name: "Открыть альбом", exact: true }).click();
    await expect(page.locator("form").getByRole("alert")).toHaveText("Неверный пароль альбома.");
    expect(await countViews(privateAlbum.id)).toBe(0n);
    expect(lockedViewRequests).toBe(0);
    });

    await test.step("Unlocking the private album records one view and reload deduplicates it", async () => {
    const unlockedView = viewResponse(page, privateAlbum.slug);
    await page.getByLabel("Пароль альбома", { exact: true }).fill(albumPassword);
    await page.getByRole("button", { name: "Открыть альбом", exact: true }).click();
    expect((await unlockedView).ok()).toBe(true);
    await expect(page.getByText(privateAlbum.description, { exact: true })).toBeVisible();
    await expect.poll(() => countViews(privateAlbum.id)).toBe(1n);
    const privateReloadView = viewResponse(page, privateAlbum.slug);
    await page.reload();
    expect((await privateReloadView).ok()).toBe(true);
    expect(await countViews(privateAlbum.id)).toBe(1n);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("views-private-mobile.png"), fullPage: true });
    });

    // Statistics are optional: an unavailable tracker must not break the album.
    await test.step("A failed view tracker leaves the gallery usable and shows no technical error", async () => {
    const failedViewPath = new URL(`/api/albums/${publicAlbum.slug}/view`, baseURL).href;
    await page.route(failedViewPath, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Analytics service unavailable" }) }));
    const failedView = viewResponse(page, publicAlbum.slug);
    await page.goto(`/e/${publicAlbum.slug}`);
    expect((await failedView).status()).toBe(503);
    await expect(page.getByRole("heading", { name: publicAlbum.title, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Первые моменты ещё впереди", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Обновить", exact: true })).toBeEnabled();
    await expect(page.locator(".photo-gallery-section").getByRole("alert")).toHaveCount(0);
    await expect(page.getByText("Analytics service unavailable", { exact: true })).toHaveCount(0);
    expect(await countViews(publicAlbum.id)).toBe(3n);
    await page.unroute(failedViewPath);
    });
  } finally {
    const contexts = [page.context(), secondVisitor, organizer].filter((context): context is BrowserContext => Boolean(context));
    const cookieResults = await Promise.allSettled(contexts.map(context => context.cookies(baseURL!)));
    const cookies = cookieResults.flatMap(result => result.status === "fulfilled" ? result.value : []);
    const visitorHashes = new Set(cookies.filter(cookie => cookie.name === "partyphoto_visitor").map(cookie => createHash("sha256").update(`visitor:${cookie.value}`).digest("hex")));
    await Promise.allSettled([secondVisitor?.close(), organizer?.close()]);
    try {
      if (eventIds.length) {
        const storedViews = await db.albumView.findMany({ where: { eventId: { in: eventIds } }, select: { visitorHash: true } });
        for (const view of storedViews) visitorHashes.add(view.visitorHash);
        await db.accessToken.deleteMany({ where: { eventId: { in: eventIds } } });
        // AlbumView rows cascade when their events are deleted.
        await db.event.deleteMany({ where: { id: { in: eventIds } } });
        await db.authRateLimit.deleteMany({ where: { key: { in: [...eventIds.flatMap(id => [`album:unlock:${id}`, `view:event:${id}`]), ...[...visitorHashes].map(hash => `view:visitor:${hash}`)] } } });
      }
      if (userId) await db.user.delete({ where: { id: userId } });
    } finally {
      await db.$disconnect();
    }
  }
});
