"use client";

import { useId, useState } from "react";
import type { EventDTO } from "@/lib/event-types";

export function EventShare({ event }: { event: Pick<EventDTO, "id" | "url" | "code" | "slug"> }) {
  const inputId = useId();
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [qrError, setQrError] = useState(false);
  const qrUrl = `/api/events/${event.id}/qr`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(event.url);
      setError(false);
      setMessage("Ссылка скопирована.");
    } catch {
      setError(true);
      setMessage("Не удалось скопировать автоматически. Выделите ссылку и скопируйте её вручную.");
    }
  }

  return (
    <section className="event-share-card" aria-labelledby={`${inputId}-heading`}>
      <p className="eyebrow">ПРИГЛАСИТЕ ГОСТЕЙ</p>
      <h2 id={`${inputId}-heading`}>Одна ссылка для всех</h2>
      <p className="event-share-intro">Отправьте ссылку гостям или разместите QR-код на мероприятии.</p>
      <div className="form-field"><label htmlFor={`${inputId}-url`}>Ссылка на альбом</label><input id={`${inputId}-url`} type="text" readOnly value={event.url} onFocus={(focusEvent) => focusEvent.target.select()} /></div>
      <button className="button button-outline copy-link-button" type="button" onClick={copyLink}>Скопировать ссылку <span aria-hidden="true">↗</span></button>
      <p className={`copy-feedback${error ? " copy-feedback-error" : ""}`} role="status" aria-live="polite">{message}</p>
      <div className="event-access-code"><span>Код мероприятия</span><strong>{event.code}</strong></div>
      <div className="qr-preview">{qrError ? <p className="field-help">Не удалось загрузить QR-код. Обновите страницу или поделитесь ссылкой.</p> : <img src={qrUrl} width={220} height={220} alt={`QR-код для доступа к альбому ${event.slug}`} onError={() => setQrError(true)} />}</div>
      {!qrError && <a className="text-link qr-download" href={`${qrUrl}?download=1`} download={`partyphoto-${event.slug}.png`}>Скачать QR-код</a>}
      <a className="button button-primary open-album-button" href={event.url} target="_blank" rel="noopener noreferrer">Открыть альбом <span aria-hidden="true">↗</span><span className="sr-only">в новой вкладке</span></a>
    </section>
  );
}
