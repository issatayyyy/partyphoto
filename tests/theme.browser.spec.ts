import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import argon2 from "argon2";

const screenshotDirectory = resolve(".data");
const theme = (page: Page, value: "light" | "dark") => expect(page.locator("html")).toHaveAttribute("data-theme", value);
const toggle = (page: Page, to: "light" | "dark") => page.getByRole("button", {
  name: to === "dark" ? "Включить тёмную тему" : "Включить светлую тему", exact: true,
});
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "Page must fit the mobile viewport").toBe(true);
}
async function capture(page: Page, filename: string) {
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: resolve(screenshotDirectory, filename), fullPage: true, animations: "disabled" });
}

test("browser preference and saved override set the page palette before React hydration", async ({ browser, baseURL }) => {
  const palettes: Array<{ background: string; foreground: string }> = [];
  for (const saved of [null, "light"] as const) {
    const context = await browser.newContext({ baseURL, colorScheme: "dark", viewport: { width: 1440, height: 900 } });
    try {
      if (saved) await context.addInitScript(value => localStorage.setItem("partyphoto-theme", value), saved);
      // Inline initialization still runs, while all external Next scripts are
      // blocked. The first rendered palette cannot depend on hydration.
      await context.route("**/_next/**", route => route.request().resourceType() === "script" ? route.abort() : route.continue());
      const page = await context.newPage();
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await theme(page, saved ?? "dark");
      palettes.push(await page.evaluate(() => ({ background: getComputedStyle(document.body).backgroundColor, foreground: getComputedStyle(document.body).color })));
      await capture(page, `theme-${saved ?? "dark"}-desktop.png`);
    } finally { await context.close(); }
  }
  expect(palettes[0].background).not.toBe(palettes[1].background);
  expect(palettes[0].foreground).not.toBe(palettes[1].foreground);
});

test("keyboard switching survives navigation and reload and synchronizes with system and other tabs", async ({ page, context }) => {
  const errors: string[] = [];
  const monitor = (target: Page) => {
    target.on("pageerror", () => errors.push("runtime-error"));
    target.on("console", message => {
      if (["warning", "error"].includes(message.type()) && /hydrat|server rendered|did not match/i.test(message.text())) errors.push("hydration-warning");
    });
  };
  monitor(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await theme(page, "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await theme(page, "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await theme(page, "light");
  await toggle(page, "dark").focus();
  await page.keyboard.press("Space");
  await theme(page, "dark");
  expect(await page.evaluate(() => localStorage.getItem("partyphoto-theme"))).toBe("dark");
  await toggle(page, "light").focus();
  await page.keyboard.press("Enter");
  await theme(page, "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await theme(page, "light");

  await page.getByRole("navigation", { name: "Навигация" }).getByRole("link", { name: "Войти", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await theme(page, "light");
  await page.locator("header .brand").click();
  await page.getByRole("link", { name: /Открыть альбом по коду/ }).click();
  await expect(page).toHaveURL(/\/join$/);
  await theme(page, "light");
  await page.reload();
  await theme(page, "light");

  const other = await context.newPage();
  monitor(other);
  try {
    await other.goto("/login");
    await theme(other, "light");
    await toggle(page, "dark").click();
    await theme(other, "dark");
    await expect(toggle(other, "light")).toBeVisible();
    await other.evaluate(() => localStorage.removeItem("partyphoto-theme"));
    await theme(page, "dark"); // The original tab's system currently prefers dark.
    await page.emulateMedia({ colorScheme: "light" });
    await theme(page, "light");
  } finally { await other.close(); }
  expect(errors).toEqual([]);
});

test("both themes fit narrow forms and dark staff/guest pages; blocked storage keeps switching usable", async ({ page, context, browser, baseURL }) => {
  test.setTimeout(120000);
  const hydrationErrors: string[] = [];
  page.on("pageerror", () => hydrationErrors.push("runtime-error"));
  page.on("console", message => {
    if (["warning", "error"].includes(message.type()) && /hydrat|server rendered|did not match/i.test(message.text())) hydrationErrors.push("hydration-warning");
  });
  const database = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) || !["postgres:", "postgresql:"].includes(database.protocol)) {
    throw new Error("Theme page fixtures require local PostgreSQL");
  }
  for (const value of ["light", "dark"] as const) {
    await page.goto("/");
    if (await page.locator("html").getAttribute("data-theme") !== value) await toggle(page, value).click();
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const path of ["/", "/login", "/register", "/join", "/forgot-password", "/reset-password"]) {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await theme(page, value); await expect(toggle(page, value === "dark" ? "light" : "dark")).toBeVisible();
        await fits(page);
      }
    }
    await page.goto("/"); await capture(page, `theme-${value}-mobile.png`);
  }

  const db = new PrismaClient();
  const namespace = `theme-browser-${randomBytes(10).toString("hex")}`;
  const session = randomBytes(32).toString("hex");
  let userId: string | undefined;
  let eventId: string | undefined;
  try {
    const user = await db.user.create({ data: {
      email: `${namespace}@example.invalid`, name: "Проверка тёмной темы", role: "ADMIN",
      passwordHash: await argon2.hash(randomBytes(20).toString("base64url"), { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }),
      sessions: { create: { tokenHash: createHash("sha256").update(session).digest("hex"), expiresAt: new Date(Date.now() + 3600000) } },
    } });
    userId = user.id;
    const event = await db.event.create({ data: { ownerId: user.id, title: "Моменты в тёмной теме", description: "Учебный альбом для проверки цветовой схемы.",
      slug: namespace, code: randomBytes(4).toString("hex").toUpperCase(), allowGuestUploads: true } });
    eventId = event.id;
    await context.addCookies([{ name: "partyphoto_session", value: session, url: baseURL!, httpOnly: true, sameSite: "Lax" }]);
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: /Добро пожаловать/ })).toBeVisible();
    await theme(page, "dark"); await fits(page); await capture(page, "theme-dark-dashboard-mobile.png");
    await page.getByRole("link", { name: "Суперадмин", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Управление PartyPhoto", exact: true })).toBeVisible();
    await theme(page, "dark"); await fits(page);
    await page.getByLabel("Поиск пользователей", { exact: true }).fill(user.email);
    await page.getByRole("button", { name: "Найти пользователей", exact: true }).click();
    await expect(page.locator(".admin-user-card")).toHaveCount(1);
    await page.getByLabel("Поиск мероприятий", { exact: true }).fill(event.title);
    await page.getByRole("button", { name: "Найти мероприятия", exact: true }).click();
    await expect(page.getByRole("heading", { name: event.title, exact: true })).toBeVisible();
    await capture(page, "theme-dark-admin-mobile.png");
    await page.goto(`/e/${event.slug}`);
    await expect(page.getByRole("heading", { name: event.title, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Первые моменты ещё впереди", exact: true })).toBeVisible();
    await theme(page, "dark"); await fits(page); await capture(page, "theme-dark-album-mobile.png");
    expect(hydrationErrors).toEqual([]);
  } finally {
    // Stop guest effects before deleting the isolated fixture event.
    try {
      await page.goto("/").catch(() => {});
      const visitors = (await context.cookies().catch(() => [])).filter(cookie => cookie.name === "partyphoto_visitor")
        .map(cookie => createHash("sha256").update(`visitor:${cookie.value}`).digest("hex"));
      if (eventId) {
        await db.event.deleteMany({ where: { id: eventId, ownerId: userId } });
        await db.authRateLimit.deleteMany({ where: { key: { in: [`view:event:${eventId}`, ...visitors.map(hash => `view:visitor:${hash}`)] } } });
      }
      if (userId) await db.user.deleteMany({ where: { id: userId, email: `${namespace}@example.invalid` } });
    } finally { await db.$disconnect(); }
  }

  const unavailable = await browser.newContext({ baseURL, colorScheme: "dark", viewport: { width: 320, height: 844 } });
  try {
    await unavailable.addInitScript(() => Object.defineProperty(window, "localStorage", { configurable: true,
      get() { throw new DOMException("Storage unavailable", "SecurityError"); } }));
    const blockedPage = await unavailable.newPage();
    const errors: string[] = [];
    blockedPage.on("pageerror", error => errors.push(error.name));
    await blockedPage.goto("/login");
    await theme(blockedPage, "dark");
    await toggle(blockedPage, "light").click();
    await theme(blockedPage, "light"); await fits(blockedPage);
    expect(errors).toEqual([]);
  } finally { await unavailable.close(); }
});
