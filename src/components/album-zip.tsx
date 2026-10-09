"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { ZipDTO } from "@/lib/zip-types";

export function AlbumZip({ endpoint, compact = false }: { endpoint: string; compact?: boolean }) {
  const [job, setJob] = useState<ZipDTO | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [checkingDownload, setCheckingDownload] = useState(false);
  const [error, setError] = useState("");
  const requestPending = useRef(false);
  const requestController = useRef<AbortController | null>(null);
  const downloadPending = useRef(false);
  const downloadController = useRef<AbortController | null>(null);
  const active = job?.status === "QUEUED" || job?.status === "RUNNING";
  const ready = job?.status === "DONE" && Boolean(job.downloadUrl);

  useEffect(() => {
    const controller = new AbortController();
    setJob(null); setInitializing(true); setError("");
    async function initialize() {
      try {
        const response = await fetch(endpoint, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        const result = await response.json() as { job?: ZipDTO | null; error?: string };
        if (!response.ok) throw new Error(result.error || "Не удалось проверить готовность архива.");
        if (!controller.signal.aborted) setJob(result.job ?? null);
      } catch (loadError) {
        if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : "Не удалось проверить готовность архива.");
      } finally {
        if (!controller.signal.aborted) setInitializing(false);
      }
    }
    void initialize();
    return () => { controller.abort(); requestController.current?.abort(); downloadController.current?.abort(); };
  }, [endpoint]);

  useEffect(() => {
    if (job?.status !== "DONE" || !job.expiresAt) return;
    const jobId = job.id;
    const expiresAt = new Date(job.expiresAt).getTime();
    if (!Number.isFinite(expiresAt)) return;
    let timer: ReturnType<typeof setTimeout>;
    function expire() {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        setJob((current) => current?.id === jobId && current.status === "DONE" ? null : current);
      } else {
        timer = setTimeout(expire, Math.min(remaining, 2147483647));
      }
    }
    expire();
    return () => clearTimeout(timer);
  }, [job?.id, job?.status, job?.expiresAt]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch(endpoint, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        const result = await response.json() as { job?: ZipDTO | null; error?: string };
        if (!response.ok) throw new Error(result.error || "Не удалось проверить готовность архива.");
        if (!controller.signal.aborted) { setJob(result.job ?? null); setError(""); }
      } catch (pollError) {
        if (!controller.signal.aborted) setError(pollError instanceof Error ? pollError.message : "Не удалось проверить готовность архива.");
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
      }
    }
    timer = setTimeout(poll, 2000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [active, endpoint, job?.id]);

  async function requestArchive() {
    if (requestPending.current || active || initializing) return;
    requestPending.current = true;
    requestController.current = new AbortController();
    const signal = requestController.current.signal;
    setRequesting(true); setError("");
    try {
      const response = await fetch(endpoint, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}", signal });
      const result = await response.json() as { job?: ZipDTO; error?: string };
      if (!response.ok || !result.job) throw new Error(result.error || "Не удалось собрать архив.");
      if (!signal.aborted) setJob(result.job);
    } catch (requestError) {
      if (!signal.aborted) setError(requestError instanceof Error ? requestError.message : "Не удалось собрать архив. Попробуйте ещё раз.");
    } finally {
      requestPending.current = false;
      if (!signal.aborted) setRequesting(false);
    }
  }

  async function downloadArchive(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    if (downloadPending.current) return;
    downloadPending.current = true;
    downloadController.current = new AbortController();
    const signal = downloadController.current.signal;
    setCheckingDownload(true); setError("");
    try {
      const response = await fetch(endpoint, { credentials: "same-origin", cache: "no-store", signal });
      const result = await response.json() as { job?: ZipDTO | null; error?: string };
      if (!response.ok) throw new Error(result.error || "Не удалось проверить доступ к архиву.");
      if (signal.aborted) return;
      const currentJob = result.job ?? null;
      setJob(currentJob);
      if (currentJob?.status !== "DONE" || !currentJob.downloadUrl || (currentJob.expiresAt && new Date(currentJob.expiresAt).getTime() <= Date.now())) {
        if (currentJob?.status === "DONE") setJob(null);
        setError("Альбом изменился или срок архива истёк. Соберите ZIP ещё раз.");
        return;
      }
      window.location.assign(currentJob.downloadUrl);
    } catch (downloadError) {
      if (!signal.aborted) setError(downloadError instanceof Error ? downloadError.message : "Не удалось проверить доступ к архиву. Попробуйте ещё раз.");
    } finally {
      downloadPending.current = false;
      if (!signal.aborted) setCheckingDownload(false);
    }
  }

  return (
    <section className={`album-zip${compact ? " album-zip-compact" : ""}`} aria-label="Скачать фотографии архивом" aria-busy={requesting || active || checkingDownload}>
      <div className="album-zip-heading">{!compact && <div><h3>Все моменты — одним архивом</h3><p>Скачайте опубликованные фотографии в оригинальном качестве.</p></div>}{ready && job?.downloadUrl ? <a className="button button-primary" href={job.downloadUrl} download="partyphoto-album.zip" onClick={downloadArchive} aria-disabled={checkingDownload}>{checkingDownload ? "Проверяем архив…" : "Скачать готовый ZIP"} <span aria-hidden="true">↓</span></a> : <button className="button button-outline" type="button" onClick={requestArchive} disabled={initializing || requesting || active || checkingDownload}>{requesting || active ? "Готовим ZIP…" : "Скачать всё ZIP"}<span aria-hidden="true">↓</span></button>}</div>
      {active && job && <div className="zip-progress"><progress max={Math.max(job.totalPhotos, 1)} value={job.totalPhotos ? Math.min(job.processedPhotos, job.totalPhotos) : undefined} aria-label="Подготовка ZIP-архива" /><p role="status" aria-live="polite">{job.status === "QUEUED" ? "Архив ожидает обработки." : "Собираем архив."}{job.totalPhotos > 0 ? ` Готово ${job.processedPhotos} из ${job.totalPhotos} фотографий.` : ""} Можно оставить эту страницу открытой — ссылка появится автоматически.</p></div>}
      {ready && <p className="zip-ready" role="status">Архив готов.{job?.expiresAt ? <> Ссылка доступна до <time dateTime={job.expiresAt}>{new Date(job.expiresAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}</time>.</> : " Можно скачать фотографии по ссылке."}</p>}
      {job?.status === "FAILED" && !error && <p className="form-error" role="alert">{job.error || "Не удалось собрать архив. Нажмите «Скачать всё ZIP», чтобы попробовать ещё раз."}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}
