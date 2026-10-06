"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { PhotoDTO } from "@/lib/photo-types";
import { PhotoUpload } from "@/components/photo-upload";
import { AlbumZip } from "@/components/album-zip";

type PhotoGalleryProps = { maxUploadMb: number; allowDownloads?: boolean } & (
  | { eventId: string; slug?: never; allowUploads?: boolean }
  | { eventId?: never; slug: string; allowUploads: boolean }
);
type PhotoPage = { photos: PhotoDTO[]; nextCursor: string | null; error?: string };
const statusLabels: Record<string, string> = { PENDING: "На проверке", PUBLISHED: "Опубликовано", HIDDEN: "Скрыто", DELETING: "Удаляется", UPLOADING: "Обрабатывается", PROCESSING: "Обрабатывается", FAILED: "Ошибка обработки" };

export function PhotoGallery({ eventId, slug, allowUploads = true, allowDownloads = true, maxUploadMb }: PhotoGalleryProps) {
  const router = useRouter();
  const sectionId = useId();
  const staff = Boolean(eventId);
  const endpoint = staff ? `/api/events/${eventId}/photos` : `/api/albums/${slug}/photos`;
  const [photos, setPhotos] = useState<PhotoDTO[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moderating, setModerating] = useState(false);
  const [moderationMessage, setModerationMessage] = useState("");
  const [preview, setPreview] = useState<PhotoDTO | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set());
  const [likePending, setLikePending] = useState<Set<string>>(new Set());
  const [likeErrors, setLikeErrors] = useState<Record<string, string>>({});
  const previewDialog = useRef<HTMLDialogElement>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);
  const moreController = useRef<AbortController | null>(null);
  const mutationPending = useRef(false);
  const likesInFlight = useRef(new Set<string>());

  const fetchPhotos = useCallback(async (cursor: string | null, signal?: AbortSignal) => {
    const response = await fetch(`${endpoint}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { credentials: "same-origin", cache: "no-store", signal });
    const result = await response.json() as PhotoPage;
    if (!response.ok) throw new Error(result.error || "Не удалось загрузить фотографии.");
    return result;
  }, [endpoint]);

  useEffect(() => {
    const controller = new AbortController();
    generation.current++;
    moreController.current?.abort();
    setLoading(true); setLoadingMore(false); setError(""); setPhotos([]); setNextCursor(null); setSelected(new Set()); setFailedImages(new Set());
    fetchPhotos(null, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setPhotos(result.photos); setNextCursor(result.nextCursor);
    }).catch((loadError: unknown) => {
      if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить фотографии.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); moreController.current?.abort(); };
  }, [fetchPhotos, reloadKey]);

  useEffect(() => {
    if (preview) previewDialog.current?.showModal();
  }, [preview]);

  useEffect(() => {
    if (deleteConfirm) deleteDialog.current?.showModal();
  }, [deleteConfirm]);

  async function loadMore() {
    if (!nextCursor || loadingMore || loading) return;
    const currentGeneration = generation.current;
    const controller = new AbortController();
    moreController.current = controller;
    setLoadingMore(true); setError("");
    try {
      const result = await fetchPhotos(nextCursor, controller.signal);
      if (generation.current !== currentGeneration) return;
      setPhotos((current) => {
        const existing = new Set(current.map((photo) => photo.id));
        return [...current, ...result.photos.filter((photo) => !existing.has(photo.id))];
      });
      setNextCursor(result.nextCursor);
    } catch (loadError) {
      if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить фотографии.");
    } finally {
      if (generation.current === currentGeneration) setLoadingMore(false);
    }
  }

  function toggleSelected(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else if (next.size < 100) next.add(id);
      return next;
    });
    setModerationMessage("");
  }

  async function moderate(action: "publish" | "hide" | "delete") {
    if (!eventId || !selected.size || mutationPending.current) return;
    mutationPending.current = true;
    setModerating(true); setError(""); setModerationMessage("");
    const count = selected.size;
    try {
      const response = await fetch(`/api/events/${eventId}/photos/moderate`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: Array.from(selected), action }),
      });
      const result = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok) throw new Error(result.error || "Не удалось изменить фотографии.");
      setSelected(new Set());
      setModerationMessage(action === "delete" ? `Удалено фотографий: ${count}.` : action === "publish" ? `Опубликовано фотографий: ${count}.` : `Скрыто фотографий: ${count}.`);
      setDeleteConfirm(false);
      setReloadKey((current) => current + 1);
      router.refresh();
    } catch (moderationError) {
      setError(moderationError instanceof Error ? moderationError.message : "Не удалось изменить фотографии.");
      setDeleteConfirm(false);
    } finally {
      setModerating(false); mutationPending.current = false;
    }
  }

  async function toggleLike(photo: PhotoDTO) {
    if (photo.status !== "PUBLISHED" || likesInFlight.current.has(photo.id)) return;
    likesInFlight.current.add(photo.id);
    setLikePending((current) => new Set(current).add(photo.id));
    setLikeErrors((current) => ({ ...current, [photo.id]: "" }));
    try {
      const response = await fetch(`/api/photos/${photo.id}/like`, {
        method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ liked: !photo.liked }),
      });
      const result = await response.json() as { liked?: boolean; likeCount?: number; error?: string };
      if (!response.ok) throw new Error(result.error || "Не удалось изменить лайк.");
      if (typeof result.liked !== "boolean" || typeof result.likeCount !== "number") throw new Error("Не удалось изменить лайк. Попробуйте ещё раз.");
      const liked = result.liked;
      const likeCount = result.likeCount;
      setPhotos((current) => current.map((entry) => entry.id === photo.id ? { ...entry, liked, likeCount } : entry));
      setPreview((current) => current?.id === photo.id ? { ...current, liked, likeCount } : current);
    } catch (likeError) {
      setLikeErrors((current) => ({ ...current, [photo.id]: likeError instanceof Error ? likeError.message : "Не удалось изменить лайк. Попробуйте ещё раз." }));
    } finally {
      likesInFlight.current.delete(photo.id);
      setLikePending((current) => { const next = new Set(current); next.delete(photo.id); return next; });
    }
  }

  function likeControl(photo: PhotoDTO, context: "card" | "preview") {
    if (photo.status !== "PUBLISHED") return null;
    const countId = `${sectionId}-${context}-${photo.id}-likes`;
    const errorId = `${countId}-error`;
    return <div className="photo-like-control"><button className={`photo-like${photo.liked ? " photo-like-active" : ""}`} type="button" onClick={() => toggleLike(photo)} disabled={likePending.has(photo.id)} aria-pressed={photo.liked} aria-label={`${photo.liked ? "Убрать лайк" : "Поставить лайк"} ${photo.filename}`} aria-describedby={`${countId}${likeErrors[photo.id] ? ` ${errorId}` : ""}`}><span aria-hidden="true">{photo.liked ? "♥" : "♡"}</span><span aria-hidden="true">{photo.likeCount.toLocaleString("ru-RU")}</span></button><span className="sr-only" id={countId}>{photo.likeCount.toLocaleString("ru-RU")} лайков</span>{likeErrors[photo.id] && <p className="field-error photo-like-error" id={errorId} role="alert">{likeErrors[photo.id]}</p>}</div>;
  }

  return (
    <section className="photo-gallery-section" aria-labelledby={`${sectionId}-heading`}>
      <div className="gallery-heading"><div><p className="eyebrow">{staff ? "УПРАВЛЕНИЕ ФОТОГРАФИЯМИ" : "МГНОВЕНИЯ ВАШЕГО СОБЫТИЯ"}</p><h2 id={`${sectionId}-heading`}>Фотографии</h2></div><button className="button button-outline" type="button" onClick={() => {setReloadKey((current) => current + 1);router.refresh();}} disabled={loading || moderating}>Обновить</button></div>
      {!loading && photos.length > 0 && (staff || allowDownloads) && <AlbumZip key={`${endpoint}:${reloadKey}`} endpoint={staff ? `/api/events/${eventId}/zip` : `/api/albums/${slug}/zip`} />}
      {allowUploads && <PhotoUpload endpoint={endpoint} maxUploadMb={maxUploadMb} guest={!staff} onUploaded={() => setReloadKey((current) => current + 1)} />}
      {staff && photos.length > 0 && <div className="gallery-moderation"><label className="checkbox-field"><input type="checkbox" checked={photos.length > 0 && photos.slice(0, 100).every((photo) => selected.has(photo.id))} onChange={(event) => {setSelected(event.target.checked ? new Set(photos.slice(0, 100).map((photo) => photo.id)) : new Set());setModerationMessage("");}} disabled={moderating || loading} /><span><strong>Выбрать все</strong><small>До 100 фотографий за раз.</small></span></label><p className="gallery-selection" role="status" aria-live="polite">Выбрано: {selected.size}</p><div className="moderation-actions"><button className="button button-outline" type="button" onClick={() => moderate("publish")} disabled={!selected.size || moderating || loading}>Опубликовать</button><button className="button button-outline" type="button" onClick={() => moderate("hide")} disabled={!selected.size || moderating || loading}>Скрыть</button><button className="button button-danger" type="button" onClick={() => setDeleteConfirm(true)} disabled={!selected.size || moderating || loading}>Удалить</button></div></div>}
      {moderationMessage && <p className="form-success" role="status">{moderationMessage}</p>}
      {error && <div className="gallery-error"><p className="form-error" role="alert">{error}</p>{!photos.length && !loading && <button className="text-link retry-button" type="button" onClick={() => setReloadKey((current) => current + 1)}>Попробовать ещё раз</button>}</div>}
      {loading ? <p className="gallery-loading" role="status">Загружаем фотографии…</p> : photos.length ? <div className="photo-grid">{photos.map((photo) => <article className="photo-card" key={photo.id}><div className="photo-image-wrap"><button className="photo-preview-button" type="button" onClick={() => setPreview(photo)} aria-label={`Открыть фотографию ${photo.filename}`}>{failedImages.has(photo.id) ? <span className="photo-image-error">Превью недоступно</span> : <img src={photo.thumbnailUrl} width={photo.width} height={photo.height} loading="lazy" decoding="async" alt={photo.filename} onError={() => setFailedImages((current) => new Set(current).add(photo.id))} />}</button>{staff && <label className="photo-select"><input type="checkbox" checked={selected.has(photo.id)} onChange={() => toggleSelected(photo.id)} disabled={moderating} /><span className="sr-only">Выбрать фотографию {photo.filename}</span></label>}{staff && <span className={`photo-status photo-status-${photo.status.toLowerCase()}`}>{statusLabels[photo.status] || "Обрабатывается"}</span>}</div><div className="photo-caption"><span title={photo.filename}>{photo.filename}</span><div className="photo-card-actions">{likeControl(photo, "card")}{photo.downloadUrl && (staff || allowDownloads) && <a className="photo-download" href={photo.downloadUrl} download={photo.filename} aria-label={`Скачать оригинал ${photo.filename}`}><span aria-hidden="true">↓</span></a>}</div></div></article>)}</div> : !error && <div className="gallery-empty"><span aria-hidden="true">○</span><h3>Первые моменты ещё впереди</h3><p>{allowUploads ? "Добавьте фотографии — они появятся в этом альбоме." : "Организатор ещё не опубликовал фотографии. Загляните сюда чуть позже."}</p></div>}
      {!loading && nextCursor && <div className="gallery-load-more"><button className="button button-outline" type="button" onClick={loadMore} disabled={loadingMore || moderating}>{loadingMore ? "Загружаем…" : "Показать ещё"}</button></div>}
      {preview && <dialog ref={previewDialog} className="photo-preview-dialog" aria-labelledby={`${sectionId}-preview-title`} onCancel={() => setPreview(null)} onClick={(event) => {if (event.target === event.currentTarget) setPreview(null);}}><div className="photo-preview-content"><div className="photo-preview-header"><h3 id={`${sectionId}-preview-title`}>{preview.filename}</h3><button className="dialog-close" type="button" onClick={() => setPreview(null)} aria-label="Закрыть просмотр фотографии">×</button></div><img src={preview.thumbnailUrl} width={preview.width} height={preview.height} alt={preview.filename} /><div className="photo-preview-footer"><span>Превью фотографии</span><div className="photo-preview-controls">{likeControl(preview, "preview")}{preview.downloadUrl && (staff || allowDownloads) && <a className="button button-primary" href={preview.downloadUrl} download={preview.filename}>Скачать оригинал <span aria-hidden="true">↓</span></a>}</div></div></div></dialog>}
      {deleteConfirm && <dialog ref={deleteDialog} className="confirm-dialog" aria-labelledby={`${sectionId}-delete-title`} aria-describedby={`${sectionId}-delete-description`} onCancel={(event) => {if (moderating) event.preventDefault();else setDeleteConfirm(false);}}><h3 id={`${sectionId}-delete-title`}>Удалить выбранные фотографии?</h3><p id={`${sectionId}-delete-description`}>Выбрано: {selected.size}. Фотографии исчезнут из альбома. Это действие нельзя отменить.</p><div className="confirm-actions"><button className="button button-outline" type="button" onClick={() => setDeleteConfirm(false)} disabled={moderating}>Отмена</button><button className="button button-danger" type="button" onClick={() => moderate("delete")} disabled={moderating}>{moderating ? "Удаляем…" : "Удалить фотографии"}</button></div></dialog>}
    </section>
  );
}
