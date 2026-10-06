"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";

type AuthFormProps = {
  mode: "login" | "register";
};

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const inputId = useId();
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const isRegister = mode === "register";
  const errorId = `${inputId}-error`;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;

    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    const name = String(formData.get("name") ?? "").trim();
    const validationErrors: Record<string, string> = {};
    if (isRegister && (name.length < 2 || name.length > 80)) validationErrors.name = "Введите имя от 2 до 80 символов.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) validationErrors.email = "Введите корректный email, например you@example.com.";
    if (password.length < 8 || password.length > 128) validationErrors.password = "Пароль должен содержать от 8 до 128 символов.";
    setFieldErrors(validationErrors);
    setError("");
    if (Object.keys(validationErrors).length) {
      const firstField = event.currentTarget.elements.namedItem(Object.keys(validationErrors)[0]);
      if (firstField instanceof HTMLInputElement) firstField.focus();
      return;
    }
    const values = isRegister
      ? { name, email, password }
      : { email, password };

    submitting.current = true;
    setPending(true);
    setError("");

    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(values),
      });
      const result: unknown = await response.json();

      if (!response.ok) {
        const message =
          typeof result === "object" &&
          result !== null &&
          "error" in result &&
          typeof result.error === "string"
            ? result.error
            : (isRegister ? "Не удалось создать аккаунт. Попробуйте ещё раз." : "Не удалось войти. Попробуйте ещё раз.");
        setError(message);
        submitting.current = false;
        setPending(false);
        return;
      }

      router.replace("/dashboard");
      router.refresh();
    } catch {
      setError("Не удалось связаться с сервером. Проверьте подключение и попробуйте ещё раз.");
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <div className="auth-card">
      <div className="auth-card-heading">
        <span className="auth-card-mark" aria-hidden="true">p.</span>
        <h2>{isRegister ? "Создать аккаунт" : "Войти в аккаунт"}</h2>
        <p>{isRegister ? "Начните с аккаунта организатора." : "Ваши события начинаются здесь."}</p>
      </div>
      <form noValidate onSubmit={handleSubmit} onChange={(event) => {
        const target = event.target;
        if (target instanceof HTMLInputElement) setFieldErrors((current) => ({ ...current, [target.name]: "" }));
        setError("");
      }} aria-describedby={error ? errorId : undefined} aria-busy={pending}>
        <fieldset className="auth-fields" disabled={pending}>
          <legend className="sr-only">{isRegister ? "Данные нового аккаунта" : "Данные для входа"}</legend>
          {isRegister && (
            <div className="form-field">
              <label htmlFor={`${inputId}-name`}>Ваше имя</label>
              <input
                id={`${inputId}-name`}
                name="name"
                type="text"
                autoComplete="name"
                minLength={2}
                maxLength={80}
                placeholder="Как к вам обращаться"
                aria-invalid={Boolean(fieldErrors.name)}
                aria-describedby={fieldErrors.name ? `${inputId}-name-error` : undefined}
                required
              />
              {fieldErrors.name && <p className="field-error" id={`${inputId}-name-error`} role="alert">{fieldErrors.name}</p>}
            </div>
          )}
          <div className="form-field">
            <label htmlFor={`${inputId}-email`}>Email</label>
            <input
              id={`${inputId}-email`}
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={254}
              placeholder="you@example.com"
              aria-invalid={Boolean(fieldErrors.email)}
              aria-describedby={fieldErrors.email ? `${inputId}-email-error` : undefined}
              required
            />
            {fieldErrors.email && <p className="field-error" id={`${inputId}-email-error`} role="alert">{fieldErrors.email}</p>}
          </div>
          <div className="form-field">
            <label htmlFor={`${inputId}-password`}>Пароль</label>
            <input
              id={`${inputId}-password`}
              name="password"
              type="password"
              autoComplete={isRegister ? "new-password" : "current-password"}
              minLength={8}
              maxLength={128}
              aria-invalid={Boolean(fieldErrors.password)}
              aria-describedby={`${inputId}-password-help${fieldErrors.password ? ` ${inputId}-password-error` : ""}`}
              required
            />
            <p className="field-help" id={`${inputId}-password-help`}>От 8 до 128 символов.</p>
            {fieldErrors.password && <p className="field-error" id={`${inputId}-password-error`} role="alert">{fieldErrors.password}</p>}
          </div>
          <button className="button button-primary auth-submit" type="submit" disabled={pending}>
            {pending ? (isRegister ? "Создаём аккаунт…" : "Входим…") : (isRegister ? "Создать аккаунт" : "Войти")}
            {!pending && <span aria-hidden="true">↗</span>}
          </button>
        </fieldset>
        <div className="form-feedback" aria-live="polite" aria-atomic="true">
          {error && <p className="form-error" id={errorId} role="alert">{error}</p>}
        </div>
      </form>
      <p className="auth-switch">
        {isRegister ? "Уже есть аккаунт? " : "Впервые здесь? "}
        <Link href={isRegister ? "/login" : "/register"}>{isRegister ? "Войти" : "Создать аккаунт"}</Link>
      </p>
    </div>
  );
}
