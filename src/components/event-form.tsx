"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { EventDTO } from "@/lib/event-types";

function localDateInput(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dateFromInput(value: FormDataEntryValue | null) {
  return value ? new Date(String(value)).toISOString() : null;
}

export function EventForm({ event }: { event?: EventDTO }) {
  const router = useRouter();
  const formId = useId();
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [changePassword, setChangePassword] = useState(false);
  const [startsAt, setStartsAt] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const isEditing = Boolean(event);
  const errorId = `${formId}-error`;

  useEffect(() => {
    setStartsAt(localDateInput(event?.startsAt));
    setExpiresAt(localDateInput(event?.expiresAt));
    setReady(true);
  }, [event?.startsAt, event?.expiresAt]);

  async function handleSubmit(submitEvent: FormEvent<HTMLFormElement>) {
    submitEvent.preventDefault();
    if (submitting.current || !ready) return;
    const formData = new FormData(submitEvent.currentTarget);
    setSaved(false);
    setError("");

    const validationErrors: Record<string, string> = {};
    const title = String(formData.get("title") ?? "").trim();
    const description = String(formData.get("description") ?? "").trim();
    const slug = String(formData.get("slug") ?? "").trim().toLowerCase();
    const password = String(formData.get("password") ?? "");
    if (title.length < 2 || title.length > 120) validationErrors.title = "Название должно содержать от 2 до 120 символов.";
    if (description.length > 2000) validationErrors.description = "Описание может содержать до 2000 символов.";
    if (slug && (slug.length < 3 || slug.length > 64 || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug))) validationErrors.slug = "Адрес должен содержать 3–64 латинские буквы, цифры или дефисы и начинаться и заканчиваться буквой или цифрой.";
    if ((!event || changePassword) && password && (password.length < 3 || password.length > 128)) validationErrors.password = "Пароль альбома должен содержать от 3 до 128 символов.";
    for (const [name, min, max, message] of [
      ["maxPhotos", 1, 10000, "Укажите целое количество от 1 до 10 000 фотографий."],
      ["maxStorageMb", 10, 102400, "Укажите целый объём от 10 до 102 400 МБ."],
      ["maxUploadMb", 1, 25, "Укажите целый размер от 1 до 25 МБ."],
    ] as const) {
      const value = Number(formData.get(name));
      if (!Number.isInteger(value) || value < min || value > max) validationErrors[name] = message;
    }
    if (Number(formData.get("maxUploadMb")) > Number(formData.get("maxStorageMb"))) validationErrors.maxUploadMb = "Размер одной фотографии не может превышать объём альбома.";
    for (const name of ["startsAt", "expiresAt"]) {
      const value = String(formData.get(name) ?? "");
      const input = submitEvent.currentTarget.elements.namedItem(name);
      if ((input instanceof HTMLInputElement && input.validity.badInput) || (value && !Number.isFinite(new Date(value).getTime()))) validationErrors[name] = "Введите корректную дату и время.";
    }
    if (startsAt && expiresAt && new Date(expiresAt).getTime() <= new Date(startsAt).getTime()) validationErrors.expiresAt = "Срок доступа к альбому должен быть позже начала мероприятия.";
    setFieldErrors(validationErrors);
    if (Object.keys(validationErrors).length) {
      const firstField = submitEvent.currentTarget.elements.namedItem(Object.keys(validationErrors)[0]);
      if (firstField instanceof HTMLInputElement || firstField instanceof HTMLTextAreaElement) firstField.focus();
      return;
    }

    try {
      const values: Record<string, string | number | boolean | null> = {
        title,
        description,
        startsAt: dateFromInput(formData.get("startsAt")),
        expiresAt: dateFromInput(formData.get("expiresAt")),
        allowGuestUploads: formData.has("allowGuestUploads"),
        moderateUploads: formData.has("moderateUploads"),
        allowDownloads: formData.has("allowDownloads"),
        maxPhotos: Number(formData.get("maxPhotos")),
        maxStorageMb: Number(formData.get("maxStorageMb")),
        maxUploadMb: Number(formData.get("maxUploadMb")),
      };
      // Preserve the original seconds/offset when the displayed local time was not edited.
      if (event && String(formData.get("startsAt") ?? "") === localDateInput(event.startsAt)) delete values.startsAt;
      if (event && String(formData.get("expiresAt") ?? "") === localDateInput(event.expiresAt)) delete values.expiresAt;
      if (!event || slug !== event.slug) values.slug = slug;
      if (!event || changePassword) values.password = password;

      submitting.current = true;
      setPending(true);
      const response = await fetch(event ? `/api/events/${event.id}` : "/api/events", {
        method: event ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(values),
      });
      const result = await response.json() as { event?: EventDTO; error?: string };
      if (!response.ok) {
        setError(typeof result.error === "string" ? result.error : "Не удалось сохранить мероприятие. Попробуйте ещё раз.");
        return;
      }
      if (!result.event?.id) throw new Error("Invalid event response");

      if (event) {
        setSaved(true);
        setChangePassword(false);
        router.refresh();
      } else {
        router.replace(`/dashboard/events/${result.event.id}`);
        router.refresh();
      }
    } catch {
      setError("Не удалось связаться с сервером. Попробуйте ещё раз.");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  function fieldA11y(name: string, helpId?: string) {
    const ids = [helpId, fieldErrors[name] ? `${formId}-${name}-error` : undefined].filter(Boolean).join(" ");
    return { "aria-invalid": Boolean(fieldErrors[name]), "aria-describedby": ids || undefined };
  }

  function fieldMessage(name: string) {
    return fieldErrors[name] ? <p className="field-error" id={`${formId}-${name}-error`} role="alert">{fieldErrors[name]}</p> : null;
  }

  return (
    <form noValidate className="event-form" onSubmit={handleSubmit} onChange={(changeEvent) => {
      setSaved(false);setError("");
      const target = changeEvent.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) setFieldErrors((current) => ({...current, [target.name]: ""}));
    }} aria-busy={pending} aria-describedby={error ? errorId : undefined}>
      <fieldset className="event-form-fields" disabled={pending || !ready}>
        <legend className="sr-only">{isEditing ? "Настройки мероприятия" : "Новое мероприятие"}</legend>
        <section className="event-form-section" aria-labelledby={`${formId}-main-heading`}>
          <div className="event-section-heading"><span>01</span><div><h2 id={`${formId}-main-heading`}>О мероприятии</h2><p>Название, описание и ссылка для гостей.</p></div></div>
          <div className="form-field">
            <label htmlFor={`${formId}-title`}>Название мероприятия</label>
            <input id={`${formId}-title`} name="title" type="text" minLength={2} maxLength={120} defaultValue={event?.title ?? ""} placeholder="Например, день рождения Алии" {...fieldA11y("title")} required />
            {fieldMessage("title")}
          </div>
          <div className="form-field">
            <label htmlFor={`${formId}-description`}>Описание <span className="optional-label">необязательно</span></label>
            <textarea id={`${formId}-description`} name="description" rows={3} maxLength={2000} defaultValue={event?.description ?? ""} placeholder="Что нужно знать гостям о вашем альбоме" {...fieldA11y("description")} />
            {fieldMessage("description")}
          </div>
          <div className="form-field">
            <label htmlFor={`${formId}-slug`}>Адрес альбома <span className="optional-label">необязательно</span></label>
            <div className="slug-input"><span aria-hidden="true">/e/</span><input id={`${formId}-slug`} name="slug" type="text" minLength={3} maxLength={64} autoCapitalize="none" autoComplete="off" spellCheck={false} defaultValue={event?.slug ?? ""} placeholder="my-event" {...fieldA11y("slug", `${formId}-slug-help`)} /></div>
            <p className="field-help" id={`${formId}-slug-help`}>Латинские строчные буквы, цифры и дефисы. Оставьте пустым, чтобы создать адрес автоматически.</p>
            {fieldMessage("slug")}
          </div>
          <div className="event-field-grid">
            <div className="form-field"><label htmlFor={`${formId}-starts-at`}>Начало мероприятия</label><input id={`${formId}-starts-at`} name="startsAt" type="datetime-local" value={startsAt} onChange={(changeEvent) => setStartsAt(changeEvent.target.value)} {...fieldA11y("startsAt")} />{fieldMessage("startsAt")}</div>
            <div className="form-field"><label htmlFor={`${formId}-expires-at`}>Доступ к альбому до</label><input id={`${formId}-expires-at`} name="expiresAt" type="datetime-local" value={expiresAt} onChange={(changeEvent) => setExpiresAt(changeEvent.target.value)} {...fieldA11y("expiresAt")} />{fieldMessage("expiresAt")}</div>
          </div>
          <p className="field-help">Время в вашем часовом поясе. Пустой срок доступа — альбом без ограничения по времени.</p>
        </section>

        <section className="event-form-section" aria-labelledby={`${formId}-access-heading`}>
          <div className="event-section-heading"><span>02</span><div><h2 id={`${formId}-access-heading`}>Доступ и фотографии</h2><p>Выберите, что смогут делать гости.</p></div></div>
          <label className="checkbox-field"><input name="allowGuestUploads" type="checkbox" defaultChecked={event?.allowGuestUploads ?? false} /><span><strong>Гости могут добавлять фотографии</strong><small>Разрешить загрузку по гостевой ссылке.</small></span></label>
          <label className="checkbox-field"><input name="moderateUploads" type="checkbox" defaultChecked={event?.moderateUploads ?? true} /><span><strong>Проверять фотографии гостей</strong><small>Публиковать гостевые снимки после одобрения организатором.</small></span></label>
          <label className="checkbox-field"><input name="allowDownloads" type="checkbox" defaultChecked={event?.allowDownloads ?? true} /><span><strong>Разрешить скачивание</strong><small>Гости смогут сохранять фотографии альбома.</small></span></label>
          {event && (
            <div className="password-setting">
              <p className="field-help">Сейчас альбом {event.hasPassword ? "защищён паролем" : "доступен без пароля"}.</p>
              <label className="checkbox-field"><input type="checkbox" checked={changePassword} onChange={(changeEvent) => setChangePassword(changeEvent.target.checked)} /><span><strong>Изменить пароль альбома</strong><small>Текущий пароль сохраняется, пока вы не включите эту настройку.</small></span></label>
            </div>
          )}
          {(!event || changePassword) && <div className="form-field"><label htmlFor={`${formId}-password`}>{event ? "Новый пароль альбома" : "Пароль альбома"} <span className="optional-label">необязательно</span></label><input id={`${formId}-password`} name="password" type="password" autoComplete="new-password" minLength={3} maxLength={128} {...fieldA11y("password", `${formId}-password-help`)} /><p className="field-help" id={`${formId}-password-help`}>{event ? "Оставьте пустым, чтобы убрать пароль и открыть доступ по ссылке." : "Оставьте пустым для доступа без пароля."} Для защиты используйте от 3 до 128 символов.</p>{fieldMessage("password")}</div>}
        </section>

        <section className="event-form-section" aria-labelledby={`${formId}-limits-heading`}>
          <div className="event-section-heading"><span>03</span><div><h2 id={`${formId}-limits-heading`}>Лимиты альбома</h2><p>Сколько фотографий сможет вместить мероприятие.</p></div></div>
          <div className="event-field-grid event-field-grid-three">
            <div className="form-field"><label htmlFor={`${formId}-max-photos`}>Количество фото</label><input id={`${formId}-max-photos`} name="maxPhotos" type="number" min={1} max={10000} step={1} defaultValue={event?.maxPhotos ?? 1000} {...fieldA11y("maxPhotos")} required />{fieldMessage("maxPhotos")}</div>
            <div className="form-field"><label htmlFor={`${formId}-max-storage`}>Объём альбома, МБ</label><input id={`${formId}-max-storage`} name="maxStorageMb" type="number" min={10} max={102400} step={1} defaultValue={event?.maxStorageMb ?? 10240} {...fieldA11y("maxStorageMb")} required />{fieldMessage("maxStorageMb")}</div>
            <div className="form-field"><label htmlFor={`${formId}-max-upload`}>Размер фото, МБ</label><input id={`${formId}-max-upload`} name="maxUploadMb" type="number" min={1} max={25} step={1} defaultValue={event?.maxUploadMb ?? 25} {...fieldA11y("maxUploadMb")} required />{fieldMessage("maxUploadMb")}</div>
          </div>
        </section>
        <div className="event-form-actions"><button className="button button-primary" type="submit" disabled={pending || !ready}>{pending ? "Сохраняем…" : (event ? "Сохранить изменения" : "Создать мероприятие")}<span aria-hidden="true">↗</span></button>{!event && <Link className="text-link" href="/dashboard">Отмена</Link>}</div>
      </fieldset>
      <div className="form-feedback" aria-live="polite" aria-atomic="true">{error && <p className="form-error" id={errorId} role="alert">{error}</p>}{saved && <p className="form-success" role="status">Настройки сохранены.</p>}</div>
    </form>
  );
}
