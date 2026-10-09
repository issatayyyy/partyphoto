import { test, expect } from "@playwright/test";
import type { BrowserContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import argon2 from "argon2";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

test("superadmin manages isolated users and searches events on mobile", async ({ page, context, browser, baseURL }) => {
  test.setTimeout(120000);
  const db = new PrismaClient();
  const namespace = `admin-browser-${randomUUID()}`;
  const adminEmail = `${namespace}-admin@example.invalid`;
  const organizerEmail = `${namespace}-organizer@example.invalid`;
  const photographerEmail = `${namespace}-photographer@example.invalid`;
  const adminToken = randomBytes(32).toString("hex");
  const organizerToken = randomBytes(32).toString("hex");
  const anotherOrganizerToken = randomBytes(32).toString("hex");
  const photographerToken = randomBytes(32).toString("hex");
  const eventTitle = `Проверка суперадмина ${randomUUID().slice(0, 8)}`;
  const contexts: BrowserContext[] = [];
  let userIds: string[] = [];
  let eventId: string | undefined;

  try {
    const passwordHash = await argon2.hash(randomUUID(), { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const expiresAt = new Date(Date.now() + 3600000);
    const [admin, organizer, photographer] = await db.$transaction([
      db.user.create({ data: { email: adminEmail, name: "Администратор проверки", role: "ADMIN", passwordHash, sessions: { create: { tokenHash: digest(adminToken), expiresAt } } } }),
      db.user.create({ data: { email: organizerEmail, name: "Организатор проверки", role: "ORGANIZER", passwordHash, sessions: { create: [organizerToken, anotherOrganizerToken].map(value => ({ tokenHash: digest(value), expiresAt })) } } }),
      db.user.create({ data: { email: photographerEmail, name: "Фотограф проверки", role: "PHOTOGRAPHER", passwordHash, sessions: { create: { tokenHash: digest(photographerToken), expiresAt } } } }),
    ]);
    userIds = [admin.id, organizer.id, photographer.id];
    const event = await db.event.create({ data: { ownerId: organizer.id, title: eventTitle, slug: namespace, code: randomBytes(5).toString("hex").toUpperCase() } });
    eventId = event.id;
    await context.addCookies([{ name: "partyphoto_session", value: adminToken, url: baseURL!, httpOnly: true, sameSite: "Lax" }]);
    await page.setViewportSize({ width: 390, height: 844 });

    const organizerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    contexts.push(organizerContext);
    await organizerContext.addCookies([{ name: "partyphoto_session", value: organizerToken, url: baseURL!, httpOnly: true, sameSite: "Lax" }]);
    const organizerPage = await organizerContext.newPage();
    const photographerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    contexts.push(photographerContext);
    await photographerContext.addCookies([{ name: "partyphoto_session", value: photographerToken, url: baseURL!, httpOnly: true, sameSite: "Lax" }]);
    const photographerPage = await photographerContext.newPage();

    const searchUsers = async (email: string) => {
      await page.getByLabel("Поиск пользователей", { exact: true }).fill(email);
      const response = page.waitForResponse(result => new URL(result.url()).pathname === "/api/admin/users" && result.request().method() === "GET", { timeout: 15000 });
      await page.getByRole("button", { name: "Найти пользователей", exact: true }).click();
      expect((await response).ok()).toBe(true);
      const card = page.locator(".admin-user-card").filter({ hasText: email });
      await expect(card).toHaveCount(1);
      await expect(card).toBeVisible();
      return card;
    };
    const confirmation = page.getByRole("region", { name: "Подтверждение изменения", exact: true });
    const confirmMutation = async () => {
      const response = page.waitForResponse(result => new URL(result.url()).pathname === `/api/admin/users/${organizer.id}` && result.request().method() === "PATCH", { timeout: 15000 });
      await confirmation.getByRole("button", { name: "Подтвердить изменение", exact: true }).click();
      expect((await response).ok()).toBe(true);
      await expect(confirmation).toHaveCount(0);
    };

    await test.step("Only administrators can open the superadmin panel", async () => {
      await page.goto("/dashboard");
      await page.getByRole("link", { name: "Суперадмин", exact: true }).click();
      await expect(page).toHaveURL(/\/admin$/);
      await expect(page.getByRole("heading", { name: "Управление PartyPhoto", exact: true })).toBeVisible();
      for (const nonAdminPage of [organizerPage, photographerPage]) {
        await nonAdminPage.goto(new URL("/dashboard", baseURL).href);
        await expect(nonAdminPage.getByRole("link", { name: "Суперадмин", exact: true })).toHaveCount(0);
        await nonAdminPage.goto(new URL("/admin", baseURL).href);
        await expect(nonAdminPage).toHaveURL(/\/dashboard$/);
        await expect(nonAdminPage.getByRole("heading", { name: "Управление PartyPhoto", exact: true })).toHaveCount(0);
      }
    });

    await test.step("The administrator cannot change or block their own account", async () => {
      const self = await searchUsers(adminEmail);
      await expect(self.getByLabel(`Роль ${adminEmail}`, { exact: true })).toBeDisabled();
      await expect(self.getByRole("button", { name: "Сохранить роль", exact: true })).toBeDisabled();
      await expect(self.getByRole("button", { name: "Заблокировать", exact: true })).toBeDisabled();
      expect(await db.session.count({ where: { userId: admin.id } })).toBe(1);
    });

    await test.step("Changing a role requires confirmation and revokes old sessions", async () => {
      const card = await searchUsers(organizerEmail);
      await expect(card.getByRole("heading", { name: organizer.name, exact: true })).toBeVisible();
      await card.getByLabel(`Роль ${organizerEmail}`, { exact: true }).selectOption("PHOTOGRAPHER");
      await card.getByRole("button", { name: "Сохранить роль", exact: true }).click();
      await expect(confirmation).toContainText(organizer.name);
      await expect(confirmation).toContainText(organizerEmail);
      expect((await db.user.findUniqueOrThrow({ where: { id: organizer.id } })).role).toBe("ORGANIZER");
      expect(await db.session.count({ where: { userId: organizer.id } })).toBe(2);
      await confirmMutation();
      await expect(card.getByLabel(`Роль ${organizerEmail}`, { exact: true })).toHaveValue("PHOTOGRAPHER");
      const changed = await db.user.findUniqueOrThrow({ where: { id: organizer.id } });
      expect(changed.role).toBe("PHOTOGRAPHER");
      expect(changed.disabledAt).toBeNull();
      expect(await db.session.count({ where: { userId: organizer.id } })).toBe(0);
      await organizerPage.goto(new URL("/dashboard", baseURL).href);
      await expect(organizerPage).toHaveURL(/\/login$/);
    });

    await test.step("Blocking can be cancelled, then confirmed to revoke sessions", async () => {
      const activeToken = randomBytes(32).toString("hex");
      const secondActiveToken = randomBytes(32).toString("hex");
      await db.session.createMany({ data: [activeToken, secondActiveToken].map(value => ({ userId: organizer.id, tokenHash: digest(value), expiresAt })) });
      await organizerContext.addCookies([{ name: "partyphoto_session", value: activeToken, url: baseURL!, httpOnly: true, sameSite: "Lax" }]);
      await organizerPage.goto(new URL("/dashboard", baseURL).href);
      await expect(organizerPage).toHaveURL(/\/dashboard$/);

      const card = page.locator(".admin-user-card").filter({ hasText: organizerEmail });
      await card.getByRole("button", { name: "Заблокировать", exact: true }).click();
      await expect(confirmation).toContainText(organizer.name);
      await expect(confirmation).toContainText(organizerEmail);
      await confirmation.getByRole("button", { name: "Отмена", exact: true }).click();
      await expect(confirmation).toHaveCount(0);
      expect((await db.user.findUniqueOrThrow({ where: { id: organizer.id } })).disabledAt).toBeNull();
      expect(await db.session.count({ where: { userId: organizer.id } })).toBe(2);
      await card.getByRole("button", { name: "Заблокировать", exact: true }).click();
      await confirmMutation();
      await expect(card.getByRole("button", { name: "Разблокировать", exact: true })).toBeVisible();
      expect((await db.user.findUniqueOrThrow({ where: { id: organizer.id } })).disabledAt).not.toBeNull();
      expect(await db.session.count({ where: { userId: organizer.id } })).toBe(0);
      await organizerPage.goto(new URL("/dashboard", baseURL).href);
      await expect(organizerPage).toHaveURL(/\/login$/);
    });

    await test.step("Unblocking restores access without restoring revoked sessions", async () => {
      const card = page.locator(".admin-user-card").filter({ hasText: organizerEmail });
      await card.getByRole("button", { name: "Разблокировать", exact: true }).click();
      await expect(confirmation).toContainText(organizerEmail);
      await confirmMutation();
      await expect(card.getByRole("button", { name: "Заблокировать", exact: true })).toBeVisible();
      const restored = await db.user.findUniqueOrThrow({ where: { id: organizer.id } });
      expect(restored.disabledAt).toBeNull();
      expect(restored.role).toBe("PHOTOGRAPHER");
      expect(await db.session.count({ where: { userId: organizer.id } })).toBe(0);
      await organizerPage.goto(new URL("/dashboard", baseURL).href);
      await expect(organizerPage).toHaveURL(/\/login$/);
      const restoredToken = randomBytes(32).toString("hex");
      await db.session.create({ data: { userId: organizer.id, tokenHash: digest(restoredToken), expiresAt } });
      await organizerContext.addCookies([{ name: "partyphoto_session", value: restoredToken, url: baseURL!, httpOnly: true, sameSite: "Lax" }]);
      await organizerPage.goto(new URL("/dashboard", baseURL).href);
      await expect(organizerPage).toHaveURL(/\/dashboard$/);
      await organizerPage.locator("summary").filter({ hasText: "Мой аккаунт" }).click();
      await expect(organizerPage.getByText("Фотограф", { exact: true })).toBeVisible();
    });

    await test.step("Event search and long user emails fit the mobile viewport", async () => {
      await page.getByLabel("Поиск мероприятий", { exact: true }).fill(eventTitle);
      const response = page.waitForResponse(result => new URL(result.url()).pathname === "/api/admin/events" && result.request().method() === "GET", { timeout: 15000 });
      await page.getByRole("button", { name: "Найти мероприятия", exact: true }).click();
      expect((await response).ok()).toBe(true);
      await expect(page.getByRole("heading", { name: eventTitle, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath("superadmin-mobile.png"), fullPage: true });
      expect((await db.user.findUniqueOrThrow({ where: { id: photographer.id } })).role).toBe("PHOTOGRAPHER");
      expect(await db.session.count({ where: { userId: photographer.id } })).toBe(1);
    });
  } finally {
    await Promise.allSettled(contexts.map(item => item.close()));
    try {
      if (eventId) await db.event.deleteMany({ where: { id: eventId } });
      if (userIds.length) await db.user.deleteMany({ where: { id: { in: userIds } } });
    } finally { await db.$disconnect(); }
  }
});
