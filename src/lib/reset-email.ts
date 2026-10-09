import "server-only";
import { z } from "zod";

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";
const emailSchema = z.string().trim().toLowerCase().max(254).email();
type FailureCategory = "unauthorized" | "sender_rejected" | "rate_limited" | "unavailable";

export class MailDeliveryError extends Error {
  readonly category: FailureCategory;

  constructor(category: FailureCategory) {
    // Never include provider responses: they can contain recipients or secrets.
    super("Password reset email delivery failed");
    this.name = "MailDeliveryError";
    this.category = category;
  }
}

export function getResetMailConfig(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.BREVO_API_KEY?.trim();
  const sender = emailSchema.safeParse(env.MAIL_FROM_EMAIL);
  const name = env.MAIL_FROM_NAME?.trim() || "PartyPhoto";
  if (!apiKey || apiKey.length > 1024 || /[^\x21-\x7e]/.test(apiKey)
    || !sender.success || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) {
    throw new Error("Password reset email is not configured");
  }

  let endpoint = BREVO_ENDPOINT;
  if (env.EMAIL_TEST_API_URL !== undefined) {
    // Integration tests never call a real provider. No endpoint override is
    // permitted in production, even if it happens to target a loopback address.
    if (!["development", "test"].includes(env.NODE_ENV ?? "")) {
      throw new Error("Test email endpoint is forbidden outside development/test");
    }
    let testEndpoint: URL;
    try { testEndpoint = new URL(env.EMAIL_TEST_API_URL); }
    catch { throw new Error("Invalid test email endpoint"); }
    if (testEndpoint.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(testEndpoint.hostname)
      || testEndpoint.username || testEndpoint.password || testEndpoint.search || testEndpoint.hash
      || testEndpoint.pathname !== "/v3/smtp/email") {
      throw new Error("Test email endpoint must be a local HTTP fixture");
    }
    endpoint = testEndpoint.href;
  }
  return { apiKey, sender: { email: sender.data, name }, endpoint };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export async function sendPasswordResetEmail(
  config: ReturnType<typeof getResetMailConfig>,
  { to, resetUrl }: { to: string; resetUrl: string },
) {
  const recipient = emailSchema.safeParse(to);
  let link: URL;
  try { link = new URL(resetUrl); }
  catch { throw new MailDeliveryError("unavailable"); }
  const localLink = process.env.NODE_ENV !== "production"
    && link.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(link.hostname);
  if (!recipient.success || (link.protocol !== "https:" && !localLink)
    || link.username || link.password || link.search || link.pathname !== "/reset-password"
    || !/^#token=[a-f0-9]{64}$/.test(link.hash)) {
    throw new MailDeliveryError("unavailable");
  }

  const textContent = [
    "Восстановление пароля PartyPhoto",
    "",
    "Чтобы установить новый пароль, откройте ссылку:",
    link.href,
    "",
    "Ссылка действует 30 минут и только один раз. При новом запросе прежняя ссылка перестаёт работать.",
    "Если вы не запрашивали смену пароля, просто проигнорируйте это письмо. Ваш пароль не изменён.",
  ].join("\n");

  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: { "api-key": config.apiKey, "Content-Type": "application/json", Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        sender: config.sender,
        to: [{ email: recipient.data }],
        subject: "Восстановление пароля — PartyPhoto",
        textContent,
        htmlContent: `<html lang="ru"><body><h1>Восстановление пароля PartyPhoto</h1><p><a href="${escapeHtml(link.href)}">Установить новый пароль</a></p><p>Ссылка действует 30 минут и только один раз. При новом запросе прежняя ссылка перестаёт работать.</p><p>Если кнопка не открывается, скопируйте этот адрес в браузер:</p><p>${escapeHtml(link.href)}</p><p>Если вы не запрашивали смену пароля, просто проигнорируйте это письмо. Ваш пароль не изменён.</p></body></html>`,
        tags: ["password-reset"],
      }),
    });
    // Status alone is sufficient; don't retain or log message IDs/body contents.
    await response.body?.cancel().catch(() => {});
    if (response.status !== 201) {
      const category = response.status === 401 ? "unauthorized"
        : [400, 403].includes(response.status) ? "sender_rejected"
          : response.status === 429 ? "rate_limited" : "unavailable";
      throw new MailDeliveryError(category);
    }
  } catch (error) {
    if (error instanceof MailDeliveryError) throw error;
    throw new MailDeliveryError("unavailable");
  }
}
