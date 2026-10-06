import "server-only";
import { z } from "zod";
import { AuthError } from "./auth-http";

const email = z.string().trim().toLowerCase().max(254).email();
const password = z.string().max(128);
const registration = z.object({ name: z.string().trim().min(2).max(80), email, password: password.min(8) }).strict();
const login = z.object({ email, password: password.min(8) }).strict();

export function parseRegistration(input: unknown) {
  const result = registration.safeParse(input);
  if (!result.success) throw new AuthError(400, "Укажите имя (2–80 символов), корректный email и пароль (8–128 символов).");
  return result.data;
}

export function parseLogin(input: unknown) {
  const result = login.safeParse(input);
  if (!result.success) throw new AuthError(400, "Укажите корректный email и пароль (8–128 символов).");
  return result.data;
}
