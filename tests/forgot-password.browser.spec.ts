import { test, expect } from "@playwright/test";

const successMessage = "Если для этой почты есть активный аккаунт, мы отправим ссылку для смены пароля. Проверьте также папку «Спам».";

test("mobile recovery validates email inline and shows a generic success without duplicate requests", async ({ page }) => {
  test.setTimeout(60000);
  const emails: string[] = [];
  let releaseResponse = () => {};
  const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
  await page.route("**/api/auth/forgot-password", async route => {
    expect(route.request().method()).toBe("POST");
    const payload = route.request().postDataJSON();
    expect(Object.keys(payload)).toEqual(["email"]);
    emails.push(payload.email);
    await responseGate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, message: "Fixture response; the interface must always use neutral success text." }) });
  });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/login");
    await page.getByRole("link", { name: "Забыли пароль?", exact: true }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    await expect(page.getByRole("heading", { name: "Восстановление доступа", exact: true })).toBeVisible();
    const form = page.locator(".auth-card form");
    const email = form.getByLabel("Email", { exact: true });
    expect(await form.evaluate(element => (element as HTMLFormElement).noValidate)).toBe(true);
    await form.getByRole("button", { name: "Отправить ссылку", exact: true }).click();
    await expect(email).toHaveAttribute("aria-invalid", "true");
    await expect(form.getByRole("alert")).toHaveText("Введите корректный email, например you@example.com.");
    await email.fill("invalid-email");
    await form.getByRole("button", { name: "Отправить ссылку", exact: true }).click();
    await expect(form.getByRole("alert")).toBeVisible();
    expect(emails).toEqual([]);

    await email.fill("Demo.User@example.invalid");
    const request = page.waitForRequest(value => new URL(value.url()).pathname === "/api/auth/forgot-password" && value.method() === "POST");
    await form.getByRole("button", { name: "Отправить ссылку", exact: true }).click();
    await request;
    await expect(form.getByRole("button", { name: "Отправляем…", exact: true })).toBeDisabled();
    await expect(email).toBeDisabled();
    await form.evaluate(element => { (element as HTMLFormElement).requestSubmit(); (element as HTMLFormElement).requestSubmit(); });
    expect(emails).toEqual(["demo.user@example.invalid"]);
    releaseResponse();
    await expect(page.locator(".auth-card").getByRole("status")).toHaveText(successMessage);
    await expect(page.getByRole("link", { name: /^Вернуться ко входу/ })).toBeVisible();
    await expect(page.getByText("Fixture response; the interface must always use neutral success text.", { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("forgot-password-success-mobile.png"), fullPage: true });

    await page.getByRole("button", { name: "Указать другую почту", exact: true }).click();
    await expect(page.getByLabel("Email", { exact: true })).toHaveValue("Demo.User@example.invalid");
    await page.getByLabel("Email", { exact: true }).fill("another-account@example.invalid");
    await page.getByRole("button", { name: "Отправить ссылку", exact: true }).click();
    await expect(page.locator(".auth-card").getByRole("status")).toHaveText(successMessage);
    expect(emails).toEqual(["demo.user@example.invalid", "another-account@example.invalid"]);
    await page.getByRole("link", { name: /^Вернуться ко входу/ }).click();
    await expect(page).toHaveURL(/\/login$/);
  } finally { releaseResponse(); }
});

test("recovery preserves the email after provider and rate-limit failures and permits retry", async ({ page }) => {
  test.setTimeout(60000);
  const email = "retry-recovery@example.invalid";
  let requests = 0;
  await page.route("**/api/auth/forgot-password", async route => {
    expect(route.request().postDataJSON()).toEqual({ email });
    requests += 1;
    const result = requests === 1
      ? { status: 503, body: { error: "Сервис отправки писем временно недоступен. Попробуйте позже." } }
      : requests === 2
        ? { status: 429, body: { error: "Слишком много запросов. Попробуйте позже." } }
        : { status: 200, body: { ok: true, message: successMessage } };
    await route.fulfill({ status: result.status, contentType: "application/json", body: JSON.stringify(result.body) });
  });
  await page.goto("/forgot-password");
  const form = page.locator(".auth-card form");
  const input = form.getByLabel("Email", { exact: true });
  const submit = form.getByRole("button", { name: "Отправить ссылку", exact: true });
  await input.fill(email);
  await submit.click();
  await expect(form.getByRole("alert")).toHaveText("Сервис отправки писем временно недоступен. Попробуйте позже.");
  await expect(input).toHaveValue(email);
  await expect(input).toBeEnabled();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(form.getByRole("alert")).toHaveText("Слишком много запросов. Попробуйте позже.");
  await expect(input).toHaveValue(email);
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.locator(".auth-card").getByRole("status")).toHaveText(successMessage);
  expect(requests).toBe(3);
});
