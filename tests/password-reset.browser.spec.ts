import { test, expect } from "@playwright/test";
import type { BrowserContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import argon2 from "argon2";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

test("mobile password reset removes the fragment, revokes sessions and preserves administrator access", async ({ page, context, browser, baseURL }) => {
  test.setTimeout(90000);
  const db = new PrismaClient();
  const email = `password-reset-browser-${randomUUID()}@example.invalid`;
  const oldPassword = randomUUID();
  const newPassword = randomUUID().slice(0, 8);
  const resetToken = randomBytes(32).toString("hex");
  const expiredToken = randomBytes(32).toString("hex");
  const oldSession = randomBytes(32).toString("hex");
  const anotherOldSession = randomBytes(32).toString("hex");
  const accountLimiter = `auth:login:${digest(email)}`;
  let userId: string | undefined;
  let oldBrowser: BrowserContext | undefined;
  try {
    const passwordHash = await argon2.hash(oldPassword, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const user = await db.user.create({ data: {
      email, name: "Проверка восстановления", role: "ADMIN", passwordHash,
      sessions: { create: [oldSession, anotherOldSession].map(value => ({ tokenHash: digest(value), expiresAt: new Date(Date.now() + 3600000) })) },
    } });
    userId = user.id;
    await db.passwordResetToken.create({ data: { userId: user.id, tokenHash: digest(resetToken), expiresAt: new Date(Date.now() + 1800000) } });
    await db.authRateLimit.create({ data: { key: accountLimiter, attempts: 30, resetAt: new Date(Date.now() + 900000) } });
    await context.addCookies([{ name: "partyphoto_session", value: oldSession, url: baseURL!, httpOnly: true, sameSite: "Lax" }]);
    oldBrowser = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await oldBrowser.addCookies([{ name: "partyphoto_session", value: anotherOldSession, url: baseURL!, httpOnly: true, sameSite: "Lax" }]);
    const oldPage = await oldBrowser.newPage();
    let tokenInRequestUrl = false;
    page.on("request", request => { if (request.url().includes(resetToken) || request.url().includes(expiredToken)) tokenInRequestUrl = true; });
    await page.setViewportSize({ width: 390, height: 844 });

    await test.step("The token fragment is removed before entering a new password", async () => {
      await page.goto(`/reset-password#token=${resetToken}`);
      await expect(page.getByLabel("Новый пароль", { exact: true })).toBeVisible();
      expect(await page.evaluate(() => window.location.pathname === "/reset-password" && window.location.hash === "" && window.location.search === "")).toBe(true);
      expect(tokenInRequestUrl).toBe(false);
      await expect(page.locator("input[type=hidden]")).toHaveCount(0);
      expect(await page.locator("form").evaluate(form => (form as HTMLFormElement).noValidate)).toBe(true);
    });

    await test.step("Short passwords and mismatched confirmations show inline errors", async () => {
      await page.getByLabel("Новый пароль", { exact: true }).fill("1234567");
      await page.getByLabel("Повторите пароль", { exact: true }).fill("1234567");
      await page.getByRole("button", { name: "Сохранить новый пароль", exact: true }).click();
      await expect(page.locator("form").getByText("Пароль должен содержать от 8 до 128 символов.", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Новый пароль", { exact: true })).toHaveAttribute("aria-invalid", "true");
      await expect(page.getByLabel("Повторите пароль", { exact: true })).toHaveAttribute("aria-invalid", "true");
      await page.getByLabel("Новый пароль", { exact: true }).fill(newPassword);
      await page.getByLabel("Повторите пароль", { exact: true }).fill(`${newPassword}-other`);
      await page.getByRole("button", { name: "Сохранить новый пароль", exact: true }).click();
      await expect(page.locator("form").getByRole("alert")).toHaveText("Пароли должны совпадать.");
      await expect(page.getByLabel("Повторите пароль", { exact: true })).toHaveAttribute("aria-invalid", "true");
      expect(await db.passwordResetToken.count({ where: { userId: user.id } })).toBe(1);
    });

    await test.step("A valid reset revokes every old session without logging in automatically", async () => {
      await page.getByLabel("Повторите пароль", { exact: true }).fill(newPassword);
      const response = page.waitForResponse(result => new URL(result.url()).pathname === "/api/auth/reset-password" && result.request().method() === "POST");
      await page.getByRole("button", { name: "Сохранить новый пароль", exact: true }).click();
      expect((await response).ok()).toBe(true);
      await expect(page.getByRole("heading", { name: "Пароль обновлён", exact: true })).toBeVisible();
      expect(await page.evaluate(() => window.location.pathname === "/reset-password" && window.location.hash === "")).toBe(true);
      await expect(page.getByLabel("Новый пароль", { exact: true })).toHaveCount(0);
      const updated = await db.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(updated.role).toBe("ADMIN");
      expect(await argon2.verify(updated.passwordHash, newPassword)).toBe(true);
      expect(await argon2.verify(updated.passwordHash, oldPassword)).toBe(false);
      expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
      expect(await db.passwordResetToken.count({ where: { userId: user.id } })).toBe(0);
      expect(await db.authRateLimit.count({ where: { key: accountLimiter } })).toBe(0);
      await oldPage.goto(new URL("/dashboard", baseURL).href);
      await expect(oldPage).toHaveURL(/\/login$/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath("password-reset-success-mobile.png"), fullPage: true });
    });

    await test.step("The new password signs in with the preserved administrator role", async () => {
      await page.getByRole("link", { name: /^Войти с новым паролем/ }).click();
      await expect(page).toHaveURL(/\/login$/);
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Пароль", { exact: true }).fill(newPassword);
      await page.getByRole("button", { name: "Войти", exact: true }).click();
      await expect(page).toHaveURL(/\/dashboard$/);
      await expect(page.getByText("Администратор", { exact: true })).toBeVisible();
    });

    await test.step("An expired token is rejected and a missing link offers no reset form", async () => {
      await db.passwordResetToken.create({ data: { userId: user.id, tokenHash: digest(expiredToken), expiresAt: new Date(Date.now() - 60000) } });
      const currentHash = (await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { passwordHash: true } })).passwordHash;
      await page.goto(`/reset-password#token=${expiredToken}`);
      await expect(page.getByLabel("Новый пароль", { exact: true })).toBeVisible();
      expect(await page.evaluate(() => window.location.hash === "")).toBe(true);
      const candidate = randomUUID().slice(0, 8);
      await page.getByLabel("Новый пароль", { exact: true }).fill(candidate);
      await page.getByLabel("Повторите пароль", { exact: true }).fill(candidate);
      await page.getByRole("button", { name: "Сохранить новый пароль", exact: true }).click();
      await expect(page.locator("form").getByRole("alert")).toHaveText("Ссылка недействительна или срок её действия истёк. Получите новую ссылку восстановления.");
      await expect(page.getByRole("button", { name: "Сохранить новый пароль", exact: true })).toBeEnabled();
      const unchanged = await db.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(unchanged.passwordHash === currentHash).toBe(true);
      expect(unchanged.role).toBe("ADMIN");
      await oldPage.goto(new URL("/reset-password", baseURL).href);
      await expect(oldPage.locator(".auth-card").getByRole("alert")).toHaveText("Ссылка для смены пароля недействительна. Откройте полную ссылку, которую вы получили, или получите новую.");
      await expect(oldPage.getByLabel("Новый пароль", { exact: true })).toHaveCount(0);
      await expect(oldPage.getByRole("button", { name: "Сохранить новый пароль", exact: true })).toHaveCount(0);
      expect(tokenInRequestUrl).toBe(false);
    });
  } finally {
    await Promise.allSettled([oldBrowser?.close()]);
    try {
      if (userId) await db.user.delete({ where: { id: userId } });
      await db.authRateLimit.deleteMany({ where: { key: { in: [accountLimiter, `password-reset:token:${digest(resetToken)}`, `password-reset:token:${digest(expiredToken)}`] } } });
    } finally { await db.$disconnect(); }
  }
});
