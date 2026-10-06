"use client";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

export function AlbumAccess({ slug }: { slug?: string }) {
  const router = useRouter();
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const data = new FormData(event.currentTarget);
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
  return <form onSubmit={submit} className="album-access" aria-busy={pending}>
    <div className="form-field">
      <label htmlFor={slug ? "album-password" : "album-code"}>{slug ? "Пароль альбома" : "Код мероприятия"}</label>
      <input id={slug ? "album-password" : "album-code"} name={slug ? "password" : "code"} type={slug ? "password" : "text"} required minLength={slug ? 1 : 8} maxLength={slug ? 128 : 8} autoComplete={slug ? "current-password" : "off"} autoCapitalize={slug ? "none" : "characters"} spellCheck={false} disabled={pending}/>
    </div>
    <button type="submit" className="button button-primary" disabled={pending}>{pending ? "Открываем…" : "Открыть альбом"}</button>
    {error && <p className="form-error" role="alert">{error}</p>}
  </form>;
}
