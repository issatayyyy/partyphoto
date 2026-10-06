import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";

test("registration, dashboard, logout and login work on mobile", async ({ page }) => {
  const db = new PrismaClient();
  const email = `browser-check-${randomUUID()}@example.invalid`;
  const password = randomUUID().slice(0, 8);
  const subject = createHash("sha256").update(email).digest("hex");
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByRole("navigation", { name: "Навигация" }).getByRole("link", { name: "Создать аккаунт", exact: true }).click();
    await expect(page).toHaveURL(/\/register$/);
    await page.screenshot({ path: test.info().outputPath("register-mobile.png"), fullPage: true });
    await page.getByLabel("Ваше имя", { exact: true }).fill("Проверка браузера");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Пароль", { exact: true }).fill("1234567");
    await page.getByRole("button", { name: "Создать аккаунт" }).click();
    await expect(page).toHaveURL(/\/register$/);
    await expect(page.locator("form").getByRole("alert")).toBeVisible();
    await expect(page.getByLabel("Пароль", { exact: true })).toHaveAttribute("aria-invalid", "true");
    expect(await page.locator("form").evaluate(form => (form as HTMLFormElement).noValidate)).toBe(true);
    await page.getByLabel("Пароль", { exact: true }).fill(password);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Создать аккаунт" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("heading", { name: /Добро пожаловать/ })).toBeVisible();
    await expect(page.getByText(email, { exact: true })).toBeVisible();
    await expect(page.getByText("Организатор", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.getByRole("button", { name: "Выйти", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Пароль", { exact: true }).fill("wrong-password");
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(page.locator("form").getByRole("alert")).toHaveText("Неверный email или пароль.");
    await expect(page.getByRole("button", { name: "Войти", exact: true })).toBeEnabled();
    await page.getByLabel("Пароль", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.getByRole("button", { name: "Выйти", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login$/);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole("heading", { name: "Войти в аккаунт", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("login-desktop.png"), fullPage: true });
  } finally {
    await db.user.deleteMany({ where: { email } });
    await db.authRateLimit.deleteMany({ where: { key: { in: [`auth:login:${subject}`, `auth:register:${subject}`] } } });
    await db.$disconnect();
  }
});
