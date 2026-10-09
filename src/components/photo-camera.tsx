"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

type PhotoCameraProps = {
  maxUploadMb: number;
  onUpload: (file: File) => Promise<void>;
  onClose: () => void;
  onChooseFile: () => void;
};

type CameraState = "starting" | "live" | "paused" | "error";
type Snapshot = { file: File; url: string };

function cameraError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Нет доступа к камере. Разрешите его в настройках браузера или выберите готовое фото с устройства.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "Камера не найдена. Подключите её или выберите фото с устройства.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "Не удалось включить камеру. Возможно, она используется другим приложением. Закройте его и попробуйте ещё раз.";
  }
  return "Не удалось запустить камеру. Попробуйте ещё раз или выберите фото с устройства.";
}

export function PhotoCamera({ maxUploadMb, onUpload, onClose, onChooseFile }: PhotoCameraProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const uploadButton = useRef<HTMLButtonElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const snapshotUrl = useRef<string | null>(null);
  const active = useRef(false);
  const generation = useRef(0);
  const facingMode = useRef<"environment" | "user">("environment");
  const uploading = useRef(false);
  const takingPhoto = useRef(false);
  const [state, setState] = useState<CameraState>("starting");
  const [ready, setReady] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const stopCamera = useCallback(() => {
    const currentStream = stream.current;
    stream.current = null;
    currentStream?.getTracks().forEach((track) => track.stop());
    if (video.current) video.current.srcObject = null;
  }, []);

  const clearSnapshot = useCallback(() => {
    if (snapshotUrl.current) URL.revokeObjectURL(snapshotUrl.current);
    snapshotUrl.current = null;
    setSnapshot(null);
  }, []);

  const startCamera = useCallback(async () => {
    const request = ++generation.current;
    stopCamera();
    takingPhoto.current = false;
    setCapturing(false);
    setReady(false);
    setError("");
    setState("starting");

    if (document.visibilityState === "hidden") {
      setState("paused");
      return;
    }
    if (!window.isSecureContext) {
      setError("Для камеры откройте сайт по HTTPS. Сейчас можно выбрать фото с устройства.");
      setState("error");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Этот браузер не поддерживает встроенную камеру. Выберите фото с устройства или откройте сайт в другом браузере.");
      setState("error");
      return;
    }

    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: facingMode.current },
          width: { ideal: 1920 },
          height: { ideal: 1440 },
        },
      });
      // A permission prompt can resolve after closing, hiding, or restarting the camera.
      if (!active.current || request !== generation.current || document.hidden) {
        nextStream.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = nextStream;
      const preview = video.current;
      if (!preview) {
        stopCamera();
        return;
      }
      preview.srcObject = nextStream;
      nextStream.getVideoTracks().forEach((track) => track.addEventListener("ended", () => {
        if (!active.current || request !== generation.current || stream.current !== nextStream) return;
        generation.current++;
        stopCamera();
        takingPhoto.current = false;
        setCapturing(false);
        setReady(false);
        setState("paused");
      }, { once: true }));
      await preview.play();
      if (!active.current || request !== generation.current) return;
      setReady(preview.readyState >= 2 && preview.videoWidth > 0 && preview.videoHeight > 0);
      setState("live");
    } catch (cameraFailure) {
      if (!active.current || request !== generation.current) return;
      stopCamera();
      setError(cameraError(cameraFailure));
      setState("error");
    }
  }, [stopCamera]);

  useEffect(() => {
    active.current = true;
    const element = dialog.current;
    element?.showModal();
    void startCamera();

    function pauseCamera() {
      generation.current++;
      stopCamera();
      takingPhoto.current = false;
      setCapturing(false);
      setReady(false);
      if (!snapshotUrl.current) setState("paused");
    }
    function visibilityChanged() {
      if (document.visibilityState === "hidden") pauseCamera();
    }
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("pagehide", pauseCamera);
    return () => {
      active.current = false;
      generation.current++;
      stopCamera();
      if (snapshotUrl.current) URL.revokeObjectURL(snapshotUrl.current);
      snapshotUrl.current = null;
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("pagehide", pauseCamera);
      element?.close();
    };
  }, [startCamera, stopCamera]);

  useEffect(() => {
    if (snapshot) uploadButton.current?.focus();
  }, [snapshot]);

  function closeCamera() {
    if (uploading.current) return;
    generation.current++;
    stopCamera();
    onClose();
  }

  function chooseFile() {
    if (uploading.current) return;
    generation.current++;
    stopCamera();
    onChooseFile();
  }

  async function capture() {
    const preview = video.current;
    if (takingPhoto.current || uploading.current || !preview || !stream.current || state !== "live") return;
    if (preview.readyState < 2 || !preview.videoWidth || !preview.videoHeight) {
      setError("Камера ещё готовится. Подождите появления изображения и попробуйте снова.");
      return;
    }
    takingPhoto.current = true;
    setCapturing(true);
    setError("");
    const request = generation.current;
    const canvas = document.createElement("canvas");
    try {
      // Preserve the whole frame while staying within the demo's 6 MP photo limit.
      const scale = Math.min(1, 2560 / Math.max(preview.videoWidth, preview.videoHeight), Math.sqrt(6_000_000 / (preview.videoWidth * preview.videoHeight)));
      canvas.width = Math.max(1, Math.floor(preview.videoWidth * scale));
      canvas.height = Math.max(1, Math.floor(preview.videoHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Не удалось сделать снимок. Попробуйте ещё раз.");
      context.drawImage(preview, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      if (!active.current || request !== generation.current) return;
      if (!blob?.size) throw new Error("Не удалось сохранить снимок. Попробуйте ещё раз.");
      if (blob.size > maxUploadMb * 1024 * 1024) throw new Error(`Снимок превышает лимит ${maxUploadMb} МБ. Переснимите его или выберите другое фото с устройства.`);
      const file = new File([blob], `partyphoto-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`, { type: "image/jpeg" });
      clearSnapshot();
      const url = URL.createObjectURL(file);
      snapshotUrl.current = url;
      setSnapshot({ file, url });
      stopCamera();
      setReady(false);
    } catch (captureFailure) {
      if (active.current && request === generation.current) {
        setError(captureFailure instanceof Error ? captureFailure.message : "Не удалось сделать снимок. Попробуйте ещё раз.");
      }
    } finally {
      canvas.width = 0;
      canvas.height = 0;
      if (active.current && request === generation.current) {
        takingPhoto.current = false;
        setCapturing(false);
      }
    }
  }

  function retake() {
    if (uploading.current) return;
    clearSnapshot();
    void startCamera();
  }

  async function uploadSnapshot() {
    if (!snapshot || uploading.current) return;
    uploading.current = true;
    setPending(true);
    setError("");
    try {
      await onUpload(snapshot.file);
      if (active.current) onClose();
    } catch (uploadFailure) {
      if (active.current) setError(uploadFailure instanceof Error ? uploadFailure.message : "Не удалось загрузить снимок. Попробуйте ещё раз.");
    } finally {
      uploading.current = false;
      if (active.current) setPending(false);
    }
  }

  return (
    <dialog ref={dialog} className="camera-dialog" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={pending} onCancel={(event) => { event.preventDefault(); closeCamera(); }}>
      <div className="camera-header"><h2 id={titleId}>Камера</h2><button type="button" className="camera-close" aria-label="Закрыть камеру" onClick={closeCamera} disabled={pending} autoFocus>×</button></div>
      <p id={descriptionId} className="camera-description">{snapshot ? "Проверьте снимок и добавьте его в альбом." : "Сделайте снимок — перед загрузкой его можно переснять."}</p>
      <div className="camera-stage">
        <video ref={video} autoPlay playsInline muted aria-label="Изображение с камеры" hidden={Boolean(snapshot) || state === "error" || state === "paused"} onLoadedData={() => {
          const preview = video.current;
          if (preview && stream.current && preview.srcObject === stream.current) setReady(preview.videoWidth > 0 && preview.videoHeight > 0);
        }} />
        {/* A local blob URL requires a native image element, not Next image optimization. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {snapshot && <img src={snapshot.url} alt="Снимок перед загрузкой" />}
        {!snapshot && state !== "live" && <p className="camera-placeholder" role="status">{state === "starting" ? "Включаем камеру… Разрешите доступ в браузере." : state === "paused" ? "Камера приостановлена. Включите её, когда будете готовы." : "Камера недоступна"}</p>}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="camera-actions">
        {snapshot ? <>
          <button ref={uploadButton} type="button" className="button button-primary" onClick={() => void uploadSnapshot()} disabled={pending}>{pending ? "Загружаем снимок…" : "Загрузить в альбом"}</button>
          <button type="button" className="button button-outline" onClick={retake} disabled={pending}>Переснять</button>
        </> : <>
          {(state === "live" || state === "starting") && <button type="button" className="button button-primary" onClick={() => void capture()} disabled={state !== "live" || !ready || capturing}>{capturing ? "Сохраняем снимок…" : "Сделать снимок"}</button>}
          {state === "live" && <button type="button" className="button button-outline" disabled={capturing} onClick={() => { facingMode.current = facingMode.current === "environment" ? "user" : "environment"; void startCamera(); }}>Сменить камеру</button>}
          {(state === "error" || state === "paused") && <button type="button" className="button button-primary" onClick={() => void startCamera()}>{state === "paused" ? "Включить камеру" : "Повторить попытку"}</button>}
        </>}
      </div>
      <div className="camera-secondary-actions"><button type="button" className="button button-outline" onClick={chooseFile} disabled={pending}>Выбрать фото с устройства</button></div>
      {pending && <p className="camera-status" role="status">Загружаем фото в альбом. Не закрывайте страницу.</p>}
    </dialog>
  );
}
