"use client";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";

export function AlbumAccess({ slug }: { slug?: string }) {
  const router = useRouter();
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState("");
  const inputId = useId();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const data = new FormData(event.currentTarget);
    const value = String(data.get(slug ? "password" : "code") ?? "");
    const validationError = slug
      ? (value.length < 3 || value.length > 128 ? "Пароль альбома должен содержать от 3 до 128 символов." : "")
      : (!/^[a-z0-9]{8}$/i.test(value.trim()) ? "Введите код мероприятия из 8 букв и цифр." : "");
    setError(""); setFieldError(validationError);
    if (validationError) {
      const input = event.currentTarget.elements.namedItem(slug ? "password" : "code");
      if (input instanceof HTMLInputElement) input.focus();
      return;
    }
    submitting.current = true; setPending(true); setError("");
    try {
      const response = await fetch(slug ? `/api/albums/${slug}/unlock` : "/api/albums/resolve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(slug ? { password: String(data.get("password") ?? "") } : { code: String(data.get("code") ?? "") }),
      });
      const result = await response.json();
      if (!response.ok) { setError(result.error ?? "Не удалось открыть альбом."); return; }
      if (!slug) router.push(result.url);
      router.refresh();
    } catch { setError("Не удалось связаться с сервером. Попробуйте ещё раз."); }
    finally { submitting.current = false; setPending(false); }
  }
  return <form noValidate onSubmit={submit} className="album-access" aria-busy={pending}>
    <div className="form-field">
      <label htmlFor={inputId}>{slug ? "Пароль альбома" : "Код мероприятия"}</label>
      <input id={inputId} name={slug ? "password" : "code"} type={slug ? "password" : "text"} required minLength={slug ? 3 : 8} maxLength={slug ? 128 : 8} autoComplete={slug ? "current-password" : "off"} autoCapitalize={slug ? "none" : "characters"} spellCheck={false} disabled={pending} aria-invalid={Boolean(fieldError)} aria-describedby={`${inputId}-help${fieldError ? ` ${inputId}-error` : ""}`} onChange={() => {setFieldError("");setError("");}}/>
      <p className="field-help" id={`${inputId}-help`}>{slug ? "От 3 до 128 символов. Пароль можно получить у организатора." : "Код из 8 символов указан в приглашении от организатора."}</p>
      {fieldError && <p className="field-error" id={`${inputId}-error`} role="alert">{fieldError}</p>}
    </div>
    <button type="submit" className="button button-primary" disabled={pending}>{pending ? "Открываем…" : "Открыть альбом"}</button>
    {error && <p className="form-error" role="alert">{error}</p>}
  </form>;
}
