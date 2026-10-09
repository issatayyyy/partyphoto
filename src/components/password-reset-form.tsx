"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

export function PasswordResetForm() {
  const formId = useId();
  const fragmentRead = useRef(false);
  const submitting = useRef(false);
  const [initialized, setInitialized] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [linkError, setLinkError] = useState("");
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (fragmentRead.current) return;
    fragmentRead.current = true;
    const fragment = window.location.hash;
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    const parameters = new URLSearchParams(fragment.slice(1));
    const fragmentToken = parameters.get("token");
    if (parameters.getAll("token").length === 1 && fragmentToken && /^[a-f0-9]{64}$/.test(fragmentToken)) {
      setToken(fragmentToken);
    } else {
      setLinkError("Ссылка для смены пароля недействительна. Откройте полную ссылку, которую вы получили, или получите новую.");
    }
    setInitialized(true);
  }, []);

  async function resetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || !token || !initialized) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = String(data.get("password") ?? "");
    const confirmation = String(data.get("confirmation") ?? "");
    const validationErrors: Record<string, string> = {};
    if (password.length < 8 || password.length > 128) validationErrors.password = "Пароль должен содержать от 8 до 128 символов.";
    if (confirmation.length < 8 || confirmation.length > 128) validationErrors.confirmation = "Повторите пароль от 8 до 128 символов.";
    else if (confirmation !== password) validationErrors.confirmation = "Пароли должны совпадать.";
    setFieldErrors(validationErrors); setError("");
    if (Object.keys(validationErrors).length) {
      const firstInput = form.elements.namedItem(Object.keys(validationErrors)[0]);
      if (firstInput instanceof HTMLInputElement) firstInput.focus();
      return;
    }
    submitting.current = true;
    setPending(true);
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, password }),
      });
      const result = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok) { setError(typeof result.error === "string" ? result.error : "Не удалось изменить пароль. Попробуйте ещё раз."); return; }
      if (result.ok !== true) throw new Error("Invalid reset response");
      form.reset();
      setToken(null);
      setSuccess(true);
    } catch {
      setError("Не удалось связаться с сервером. Проверьте подключение и попробуйте ещё раз.");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <div className="auth-card">
      <div className="auth-card-heading"><span className="auth-card-mark" aria-hidden="true">p.</span><h2>{success ? "Пароль обновлён" : "Смена пароля"}</h2><p>{success ? "Теперь вы можете войти с новым паролем." : "Выберите новый пароль для вашего аккаунта."}</p></div>
      {!initialized ? <p className="field-help" role="status">Проверяем ссылку…</p> : success ? <>
        <p className="form-success" role="status">Вы вышли из аккаунта на всех устройствах.</p>
        <Link className="button button-primary auth-submit" href="/login" prefetch={false}>Войти с новым паролем <span aria-hidden="true">↗</span></Link>
      </> : linkError ? <>
        <p className="form-error" role="alert">{linkError}</p>
        <p className="auth-switch"><Link href="/login" prefetch={false}>Вернуться ко входу</Link></p>
      </> : <form noValidate onSubmit={resetPassword} aria-busy={pending} aria-describedby={error ? `${formId}-error` : undefined} onChange={(event) => {
        const input = event.target;
        if (input instanceof HTMLInputElement) setFieldErrors((current) => ({...current, [input.name]: "", ...(input.name === "password" ? { confirmation: "" } : {})}));
        setError("");
      }}>
        <fieldset className="auth-fields" disabled={pending}>
          <legend className="sr-only">Новый пароль аккаунта</legend>
          <div className="form-field"><label htmlFor={`${formId}-password`}>Новый пароль</label><input id={`${formId}-password`} name="password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required aria-invalid={Boolean(fieldErrors.password)} aria-describedby={`${formId}-password-help${fieldErrors.password ? ` ${formId}-password-error` : ""}`} /><p className="field-help" id={`${formId}-password-help`}>От 8 до 128 символов.</p>{fieldErrors.password && <p className="field-error" id={`${formId}-password-error`} role="alert">{fieldErrors.password}</p>}</div>
          <div className="form-field"><label htmlFor={`${formId}-confirmation`}>Повторите пароль</label><input id={`${formId}-confirmation`} name="confirmation" type="password" autoComplete="new-password" minLength={8} maxLength={128} required aria-invalid={Boolean(fieldErrors.confirmation)} aria-describedby={fieldErrors.confirmation ? `${formId}-confirmation-error` : undefined} />{fieldErrors.confirmation && <p className="field-error" id={`${formId}-confirmation-error`} role="alert">{fieldErrors.confirmation}</p>}</div>
          <button className="button button-primary auth-submit" type="submit" disabled={pending}>{pending ? "Обновляем пароль…" : "Сохранить новый пароль"}<span aria-hidden="true">↗</span></button>
        </fieldset>
        <div className="form-feedback" aria-live="polite" aria-atomic="true">{error && <p className="form-error" id={`${formId}-error`} role="alert">{error}</p>}</div>
      </form>}
    </div>
  );
}
