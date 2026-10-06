import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import argon2 from "argon2";

test("organizer creates an event on mobile and shares its public album", async ({ page, context, browser, baseURL }) => {
  test.setTimeout(60000);
  const db = new PrismaClient();
  const email = `event-browser-${randomUUID()}@example.invalid`;
  const title = `Вечеринка ${randomUUID().slice(0, 8)}`;
  const description = "Собираем фотографии друзей в одном альбоме.";
  const token = randomBytes(32).toString("hex");
  let userId: string | undefined;
  try {
    const user = await db.user.create({ data: {
      email, name: "Проверка мероприятий", role: "ORGANIZER",
      passwordHash: await argon2.hash(randomUUID(), { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }),
      sessions: { create: { tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 3600000) } },
    } });
    userId = user.id;
    await context.addCookies([{ name: "partyphoto_session", value: token, url: baseURL!, httpOnly: true, sameSite: "Lax" }]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Создать мероприятие", exact: true }).click();
    await page.getByLabel("Название мероприятия", { exact: true }).fill(title);
    await page.getByLabel(/^Описание/).fill(description);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Создать мероприятие", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard\/events\/[^/]+$/);
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    const event = await db.event.findFirstOrThrow({ where: { ownerId: user.id, title } });
    await expect(page.getByText(event.code, { exact: true })).toBeVisible();
    const albumLink = page.getByRole("link", { name: /^Открыть альбом/ });
    await expect(albumLink).toHaveAttribute("href", new URL(`/e/${event.slug}`, baseURL).href);
    const qr = page.getByRole("img", { name: /^QR-код для доступа/ });
    await expect(qr).toBeVisible();
    await expect(qr).toHaveJSProperty("naturalWidth", 512);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("event-mobile.png"), fullPage: true });
    await page.reload();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();

    const guest = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const guestPage = await guest.newPage();
      await guestPage.goto(new URL(`/e/${event.slug}`, baseURL).href);
      await expect(guestPage.getByRole("heading", { name: title, exact: true })).toBeVisible();
      await expect(guestPage.getByText(description, { exact: true })).toBeVisible();
      expect(await guestPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await guestPage.screenshot({ path: test.info().outputPath("guest-album-mobile.png"), fullPage: true });
    } finally { await guest.close(); }
  } finally {
    if (userId) {
      const events = await db.event.findMany({ where: { ownerId: userId }, select: { id: true } });
      const eventIds = events.map(event => event.id);
      await db.photo.deleteMany({ where: { eventId: { in: eventIds } } });
      await db.mediaJob.deleteMany({ where: { eventId: { in: eventIds } } });
      await db.accessToken.deleteMany({ where: { eventId: { in: eventIds } } });
      await db.eventMember.deleteMany({ where: { eventId: { in: eventIds } } });
      await db.event.deleteMany({ where: { id: { in: eventIds } } });
      await db.user.delete({ where: { id: userId } });
    }
    await db.$disconnect();
  }
});

test("guest password form protects the description and keeps access after reload", async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const db = new PrismaClient();
  const namespace = `guest-browser-${randomUUID()}`;
  const title = `Закрытый альбом ${randomUUID().slice(0, 8)}`;
  const description = "Эта информация доступна только после ввода пароля.";
  const password = `Guest ${randomUUID()}`;
  let userId: string | undefined;
  let eventId: string | undefined;
  try {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const user = await db.user.create({ data: { email: `${namespace}@example.invalid`, name: "Проверка гостя", passwordHash } });
    userId = user.id;
    const event = await db.event.create({ data: { ownerId: user.id, title, description, passwordHash, slug: namespace, code: randomBytes(5).toString("hex").toUpperCase() } });
    eventId = event.id;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/e/${event.slug}`);
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(page.getByText(description, { exact: true })).toHaveCount(0);
    await page.getByLabel("Пароль альбома", { exact: true }).fill("wrong-password");
    await page.getByRole("button", { name: "Открыть альбом", exact: true }).click();
    await expect(page.locator("form").getByRole("alert")).toHaveText("Неверный пароль альбома.");
    await expect(page.getByText(description, { exact: true })).toHaveCount(0);
    await page.getByLabel("Пароль альбома", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Открыть альбом", exact: true }).click();
    await expect(page.getByText(description, { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText(description, { exact: true })).toBeVisible();
    await expect(page.getByLabel("Пароль альбома", { exact: true })).toHaveCount(0);
    const cookie = (await page.context().cookies(baseURL!)).find(item => item.name === `partyphoto_event_${event.id}`);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    if (eventId) {
      await db.accessToken.deleteMany({ where: { eventId } });
      await db.event.delete({ where: { id: eventId } });
    }
    if (userId) await db.user.delete({ where: { id: userId } });
    await db.$disconnect();
  }
});
