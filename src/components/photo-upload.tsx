"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { PhotoDTO } from "@/lib/photo-types";

type UploadItem = { file: File; status: "ready" | "uploading" | "uploaded" | "pending" | "error"; message?: string; retryable?: boolean };
type PhotoUploadProps = { endpoint: string; maxUploadMb: number; guest?: boolean; onUploaded: () => void };

export function PhotoUpload({ endpoint, maxUploadMb, guest = false, onUploaded }: PhotoUploadProps) {
  const router = useRouter();
  const inputId = useId();
  const uploading = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [batch, setBatch] = useState({ completed: 0, total: 0 });
  const uploadable = items.filter((item) => item.status === "ready" || (item.status === "error" && item.retryable));

  useEffect(() => () => controller.current?.abort(), []);

  function selectFiles(files: FileList | null) {
    setError("");
    setBatch({ completed: 0, total: 0 });
    if (!files) return;
    if (files.length > 20) {
      setError("За один раз можно загрузить до 20 фотографий. Выберите меньше файлов.");
      setItems([]);
      return;
    }
    setItems(Array.from(files).map((file) => {
      if (!(["image/jpeg", "image/png", "image/webp"].includes(file.type) || (!file.type && /\.(jpe?g|png|webp)$/i.test(file.name)))) return { file, status: "error", message: "Поддерживаются только JPEG, PNG и WebP." };
      if (!file.size || file.size > maxUploadMb * 1024 * 1024) return { file, status: "error", message: `Файл должен быть непустым и не больше ${maxUploadMb} МБ.` };
      return { file, status: "ready" };
    }));
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (uploading.current) return;
    const targets = items.map((item, index) => ({ ...item, index })).filter((item) => item.status === "ready" || (item.status === "error" && item.retryable));
    if (!targets.length) {
      setError("Выберите фотографии в формате JPEG, PNG или WebP.");
      return;
    }
    uploading.current = true;
    controller.current = new AbortController();
    const signal = controller.current.signal;
    setPending(true);
    setError("");
    setBatch({ completed: 0, total: targets.length });
    let uploaded = 0;

    for (const [position, item] of targets.entries()) {
      if (signal.aborted) break;
      setItems((current) => current.map((entry, index) => index === item.index ? { ...entry, status: "uploading", message: undefined } : entry));
      try {
        const body = new FormData();
        const inferredType = /\.png$/i.test(item.file.name) ? "image/png" : /\.webp$/i.test(item.file.name) ? "image/webp" : "image/jpeg";
        const file = item.file.type ? item.file : new File([item.file], item.file.name, { type: inferredType, lastModified: item.file.lastModified });
        body.append("file", file);
        const response = await fetch(endpoint, { method: "POST", credentials: "same-origin", body, signal });
        const result = await response.json() as { photo?: PhotoDTO; error?: string };
        if (!response.ok || !result.photo) throw new Error(result.error || "Не удалось загрузить фотографию.");
        const status = result.photo.status === "PENDING" ? "pending" : "uploaded";
        setItems((current) => current.map((entry, index) => index === item.index ? { ...entry, status, retryable: false } : entry));
        uploaded++;
      } catch (uploadError) {
        if (signal.aborted) break;
        setItems((current) => current.map((entry, index) => index === item.index ? { ...entry, status: "error", retryable: true, message: uploadError instanceof Error ? uploadError.message : "Ошибка загрузки. Попробуйте ещё раз." } : entry));
      }
      setBatch({ completed: position + 1, total: targets.length });
    }

    if (!signal.aborted) {
      setPending(false);
      uploading.current = false;
      if (uploaded) { onUploaded(); router.refresh(); }
    }
  }

  const statusLabels = { ready: "Готово к загрузке", uploading: "Загружается…", uploaded: "Загружено", pending: "Отправлено на проверку", error: "Не загружено" };

  return (
    <form noValidate className="photo-upload" onSubmit={upload} aria-busy={pending}>
      <div className="photo-upload-heading"><div><h3>{guest ? "Поделитесь своими снимками" : "Добавьте фотографии"}</h3><p>JPEG, PNG или WebP. До {maxUploadMb} МБ на фотографию, до 20 файлов за раз.</p></div><span aria-hidden="true">↑</span></div>
      <div className="form-field"><label htmlFor={inputId}>Выберите фотографии</label><input id={inputId} name="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={pending} onChange={(event) => selectFiles(event.target.files)} aria-describedby={`${inputId}-help${error ? ` ${inputId}-error` : ""}`} aria-invalid={Boolean(error)} /><p className="field-help" id={`${inputId}-help`}>Фотографии загружаются по очереди. Не закрывайте страницу до завершения.</p></div>
      {items.length > 0 && <ul className="upload-file-list">{items.map((item, index) => <li key={`${item.file.name}-${index}`} className={`upload-file upload-file-${item.status}`}><div><strong>{item.file.name}</strong><small>{(item.file.size / (1024 * 1024)).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ</small></div><span>{item.message || statusLabels[item.status]}</span></li>)}</ul>}
      {batch.total > 0 && <div className="upload-progress"><progress value={batch.completed} max={batch.total} aria-label="Прогресс загрузки" /><p role="status" aria-live="polite">{pending ? `Загрузка: ${batch.completed} из ${batch.total}.` : `Обработано ${batch.completed} из ${batch.total} фотографий.`}{!pending && items.some((item) => item.status === "pending") ? " Фотографии на проверке появятся в альбоме после одобрения организатором." : ""}</p></div>}
      <button className="button button-primary" type="submit" disabled={pending || (items.length > 0 && uploadable.length === 0)}>{pending ? "Загружаем фотографии…" : (items.some((item) => item.status === "error" && item.retryable) ? "Повторить загрузку" : "Загрузить фотографии")}<span aria-hidden="true">↑</span></button>
      {error && <p className="form-error" id={`${inputId}-error`} role="alert">{error}</p>}
    </form>
  );
}
