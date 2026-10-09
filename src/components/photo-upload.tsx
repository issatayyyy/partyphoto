"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { photoFileError, uploadPhotoFile } from "@/lib/photo-upload-client";
import { PhotoCamera } from "@/components/photo-camera";
import { UiIcon } from "@/components/ui-icon";

type UploadItem = { file: File; status: "ready" | "uploading" | "uploaded" | "error"; message?: string; retryable?: boolean };
type PhotoUploadProps = { endpoint: string; maxUploadMb: number; guest?: boolean; compact?: boolean; onUploaded: () => void };

export function PhotoUpload({ endpoint, maxUploadMb, guest = false, compact = false, onUploaded }: PhotoUploadProps) {
  const router = useRouter();
  const inputId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadForm = useRef<HTMLFormElement>(null);
  const scrollToSelection = useRef(false);
  const cameraTrigger = useRef<HTMLButtonElement>(null);
  const uploading = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraMessage, setCameraMessage] = useState("");
  const [batch, setBatch] = useState({ completed: 0, total: 0 });
  const compactGuest = guest && compact;
  const uploadable = items.filter((item) => item.status === "ready" || (item.status === "error" && item.retryable));

  useEffect(() => () => controller.current?.abort(), []);

  useEffect(() => {
    if (!compactGuest || !scrollToSelection.current || !uploadForm.current || uploadForm.current.hidden) return;
    const frame = requestAnimationFrame(() => {
      scrollToSelection.current = false;
      fileInput.current?.focus({ preventScroll: true });
      uploadForm.current?.scrollIntoView({
        block: "start",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [compactGuest, items, error]);

  function selectFiles(files: FileList | null) {
    if (uploading.current) return;
    setError("");
    setCameraMessage("");
    setBatch({ completed: 0, total: 0 });
    if (!files) return;
    scrollToSelection.current = compactGuest && files.length > 0;
    if (files.length > 20) {
      setError("За один раз можно загрузить до 20 фотографий. Выберите меньше файлов.");
      setItems([]);
      return;
    }
    setItems(Array.from(files).map((file) => {
      const message = photoFileError(file, maxUploadMb);
      if (message) return { file, status: "error", message };
      return { file, status: "ready" };
    }));
  }

  function openCamera() {
    if (uploading.current) return;
    setCameraMessage("");
    setCameraOpen(true);
  }

  function closeCamera() {
    setCameraOpen(false);
    requestAnimationFrame(() => cameraTrigger.current?.focus());
  }

  async function uploadCapture(file: File) {
    if (uploading.current) throw new Error("Дождитесь завершения текущей загрузки.");
    const message = photoFileError(file, maxUploadMb);
    if (message) throw new Error(message);
    uploading.current = true;
    controller.current = new AbortController();
    const signal = controller.current.signal;
    setPending(true);
    try {
      await uploadPhotoFile(endpoint, file, signal);
      if (!signal.aborted) {
        setCameraMessage("Снимок добавлен в альбом.");
        onUploaded();
        router.refresh();
      }
    } finally {
      uploading.current = false;
      if (!signal.aborted) setPending(false);
    }
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
    setCameraMessage("");
    setBatch({ completed: 0, total: targets.length });
    let uploaded = 0;

    for (const [position, item] of targets.entries()) {
      if (signal.aborted) break;
      setItems((current) => current.map((entry, index) => index === item.index ? { ...entry, status: "uploading", message: undefined } : entry));
      try {
        await uploadPhotoFile(endpoint, item.file, signal);
        setItems((current) => current.map((entry, index) => index === item.index ? { ...entry, status: "uploaded", retryable: false } : entry));
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

  const statusLabels = { ready: "Готово к загрузке", uploading: "Загружается…", uploaded: "Добавлено в альбом", error: "Не загружено" };

  return (
    <>
    {guest && !compactGuest && <div className="guest-photo-cta"><div><strong>Ваши фотки — в общем альбоме</strong><p>Сделайте фото сейчас или выберите готовые снимки. Они появятся в альбоме сразу.</p></div><div className="photo-source-actions"><button ref={cameraTrigger} className="button button-primary" type="button" onClick={openCamera} disabled={pending}><UiIcon name="camera" />Сделать фото</button><button className="button button-outline" type="button" onClick={() => fileInput.current?.click()} disabled={pending}>Добавить фотки <span aria-hidden="true">↑</span></button></div></div>}
    {cameraMessage && <p className="form-success" role="status">{cameraMessage}</p>}
    <form ref={uploadForm} noValidate className="photo-upload" hidden={compactGuest && items.length === 0 && !error} onSubmit={upload} aria-busy={pending}>
      <div className="photo-upload-heading"><div><h3>{guest ? "Поделитесь своими снимками" : "Добавьте фотографии"}</h3><p>JPEG, PNG или WebP. До {maxUploadMb} МБ на фотографию, до 20 файлов за раз.</p></div>{!guest && <button ref={cameraTrigger} className="button button-outline photo-camera-trigger" type="button" onClick={openCamera} disabled={pending}><UiIcon name="camera" />Сделать фото</button>}</div>
      <div className="form-field"><label htmlFor={inputId}>Выберите фотографии</label><input ref={fileInput} id={inputId} name="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={pending} onChange={(event) => selectFiles(event.target.files)} aria-describedby={`${inputId}-help${error ? ` ${inputId}-error` : ""}`} aria-invalid={Boolean(error)} /><p className="field-help" id={`${inputId}-help`}>Фотографии загружаются по очереди. Не закрывайте страницу до завершения.</p></div>
      {items.length > 0 && <ul className="upload-file-list">{items.map((item, index) => <li key={`${item.file.name}-${index}`} className={`upload-file upload-file-${item.status}`}><div><strong>{item.file.name}</strong><small>{(item.file.size / (1024 * 1024)).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ</small></div><span>{item.message || statusLabels[item.status]}</span></li>)}</ul>}
      {batch.total > 0 && <div className="upload-progress"><progress value={batch.completed} max={batch.total} aria-label="Прогресс загрузки" /><p role="status" aria-live="polite">{pending ? `Загрузка: ${batch.completed} из ${batch.total}.` : `Обработано ${batch.completed} из ${batch.total} фотографий.`}{!pending && items.some((item) => item.status === "uploaded") ? " Загруженные фотографии уже видны в альбоме." : ""}</p></div>}
      <button className="button button-primary" type="submit" disabled={pending || (items.length > 0 && uploadable.length === 0)}>{pending ? "Загружаем фотографии…" : (items.some((item) => item.status === "error" && item.retryable) ? "Повторить загрузку" : "Загрузить фотографии")}<span aria-hidden="true">↑</span></button>
      {error && <p className="form-error" id={`${inputId}-error`} role="alert">{error}</p>}
    </form>
    {compactGuest && <nav className="site-navigation guest-navigation" aria-label="Навигация мероприятия">
      <div className="site-navigation-inner">
        <a href="#guest-gallery" className={`site-navigation-link${cameraOpen ? "" : " is-active"}`} aria-current={cameraOpen ? undefined : "location"}><UiIcon name="album" /><span>Галерея</span></a>
        <button ref={cameraTrigger} type="button" className={`site-navigation-link${cameraOpen ? " is-active" : ""}`} aria-label="Сделать фото" onClick={openCamera} disabled={pending}><UiIcon name="camera" /><span>Камера</span></button>
        <button type="button" className="site-navigation-link" aria-label="Добавить фотки" onClick={() => fileInput.current?.click()} disabled={pending}><UiIcon name="plus" /><span>Добавить</span></button>
      </div>
    </nav>}
    {cameraOpen && <PhotoCamera maxUploadMb={maxUploadMb} onUpload={uploadCapture} onClose={closeCamera} onChooseFile={() => { setCameraOpen(false); fileInput.current?.click(); }} />}
    </>
  );
}
