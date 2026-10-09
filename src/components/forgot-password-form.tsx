"use client";

import Link from "next/link";
import { useId, useRef, useState, type FormEvent } from "react";

const successMessage = "Если для этой почты есть активный аккаунт, мы отправим ссылку для смены пароля. Проверьте также папку «Спам».";

export function ForgotPasswordForm() {
  const formId = useId();
  const emailInput = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState(false);

  async function requestReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const normalizedEmail = email.trim().toLowerCase();
    setError("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) {
      setFieldError("Введите корректный email, например you@example.com.");
      emailInput.current?.focus();
      return;
    }
    setFieldError("");
    submitting.current = true;
    setPending(true);
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: normalizedEmail }),
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        setError(typeof result === "object" && result !== null && "error" in result && typeof result.error === "string" ? result.error : "Не удалось отправить запрос. Попробуйте ещё раз.");
        return;
      }
      if (typeof result !== "object" || result === null || !("ok" in result) || result.ok !== true) throw new Error("Invalid recovery response");
      setSuccess(true);
    } catch {
      setError("Не удалось связаться с сервером. Проверьте подключение и попробуйте ещё раз.");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  function changeEmail() {
    setSuccess(false);
    setError("");
    setFieldError("");
    requestAnimationFrame(() => emailInput.current?.focus());
  }

  return <div className="auth-card">
    <div className="auth-card-heading"><span className="auth-card-mark" aria-hidden="true">p.</span><h2>Восстановление доступа</h2><p>Запросите ссылку для смены пароля на почту вашего аккаунта.</p></div>
    {success ? <div className="auth-fields">
      <p className="form-success" role="status">{successMessage}</p>
      <Link className="button button-primary auth-submit" href="/login" prefetch={false}>Вернуться ко входу <span aria-hidden="true">↗</span></Link>
      <button className="button button-outline" type="button" onClick={changeEmail}>Указать другую почту</button>
    </div> : <>
      <form noValidate onSubmit={requestReset} aria-busy={pending} aria-describedby={error ? `${formId}-error` : undefined}>
        <fieldset className="auth-fields" disabled={pending}>
          <legend className="sr-only">Почта для восстановления доступа</legend>
          <div className="form-field"><label htmlFor={`${formId}-email`}>Email</label><input ref={emailInput} id={`${formId}-email`} name="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={254} required value={email} placeholder="you@example.com" aria-invalid={Boolean(fieldError)} aria-describedby={fieldError ? `${formId}-email-error` : undefined} onChange={(event) => { setEmail(event.target.value); setFieldError(""); setError(""); }} />{fieldError && <p className="field-error" id={`${formId}-email-error`} role="alert">{fieldError}</p>}</div>
          <button className="button button-primary auth-submit" type="submit" disabled={pending}>{pending ? "Отправляем…" : "Отправить ссылку"}{!pending && <span aria-hidden="true">↗</span>}</button>
        </fieldset>
        <div className="form-feedback" aria-live="polite" aria-atomic="true">{error && <p className="form-error" id={`${formId}-error`} role="alert">{error}</p>}</div>
      </form>
      <p className="auth-switch"><Link href="/login" prefetch={false}>Вернуться ко входу</Link></p>
    </>}
  </div>;
}
