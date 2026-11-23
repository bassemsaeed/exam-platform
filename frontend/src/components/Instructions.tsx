import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  FileText,
  Mic,
  Square,
  Trash2,
  Upload,
  Video,
  Volume2,
  AlertCircle,
} from "lucide-react";
import { useT } from "../lib/i18n";
import { apiUrl } from "../lib/seb";
import { Feedback } from "./ui";

const MAX_BYTES = 25 * 1024 * 1024;
const ACCEPT = "audio/*,video/*,.mp3,.wav,.ogg,.m4a,.webm,.mp4,.mov";

function fmtTimer(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function pickMime(kind: "audio" | "video"): { mime: string; ext: string } {
  if (typeof MediaRecorder === "undefined") {
    return kind === "audio" ? { mime: "audio/webm", ext: "webm" } : { mime: "video/webm", ext: "webm" };
  }
  const candidates =
    kind === "audio"
      ? [
          { mime: "audio/webm;codecs=opus", ext: "webm" },
          { mime: "audio/webm", ext: "webm" },
          { mime: "audio/ogg;codecs=opus", ext: "ogg" },
          { mime: "audio/mp4", ext: "m4a" },
        ]
      : [
          { mime: "video/webm;codecs=vp9,opus", ext: "webm" },
          { mime: "video/webm;codecs=vp8,opus", ext: "webm" },
          { mime: "video/webm", ext: "webm" },
          { mime: "video/mp4", ext: "mp4" },
        ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c.mime)) return c;
  }
  return kind === "audio" ? { mime: "audio/webm", ext: "webm" } : { mime: "video/webm", ext: "webm" };
}

export interface InstructionsEditorProps {
  text: string;
  onTextChange: (v: string) => void;
  requireCompletion: boolean;
  onRequireCompletionChange: (v: boolean) => void;
  existingMediaUrl?: string | null;
  existingMediaType?: "audio" | "video" | null;
  pendingFile?: File | null;
  pendingMediaType?: "audio" | "video" | null;
  /** Deferred mode (ExamWizard): hold File locally until exam is created. */
  onPendingMediaChange?: (file: File | null, mediaType: "audio" | "video" | null) => void;
  /** Live mode (ExamDetail): upload immediately to server. */
  onUploadLive?: (file: File, mediaType: "audio" | "video") => Promise<void>;
  onDeleteLive?: () => Promise<void>;
  busy?: boolean;
  disabled?: boolean;
}

export function InstructionsEditor({
  text,
  onTextChange,
  requireCompletion,
  onRequireCompletionChange,
  existingMediaUrl,
  existingMediaType,
  pendingFile,
  pendingMediaType,
  onPendingMediaChange,
  onUploadLive,
  onDeleteLive,
  busy = false,
  disabled = false,
}: InstructionsEditorProps) {
  const t = useT();
  const [mode, setMode] = useState<"upload" | "audio" | "video">("upload");
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [mediaErr, setMediaErr] = useState("");
  const [uploading, setUploading] = useState(false);
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const liveVideoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!pendingFile) {
      setLocalPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(pendingFile);
    setLocalPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingFile]);

  function stopTracks() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    if (liveVideoRef.current) liveVideoRef.current.srcObject = null;
  }

  useEffect(() => () => {
    try {
      recorderRef.current?.stop();
    } catch {
      /* ignore */
    }
    stopTracks();
  }, []);

  async function commitMedia(file: File, kind: "audio" | "video") {
    setMediaErr("");
    if (file.size > MAX_BYTES) {
      setMediaErr(t("Media file must be 25 MB or smaller."));
      return;
    }
    if (onUploadLive) {
      setUploading(true);
      try {
        await onUploadLive(file, kind);
      } catch (err) {
        setMediaErr(err instanceof Error ? err.message : t("Upload failed."));
      } finally {
        setUploading(false);
      }
    } else if (onPendingMediaChange) {
      onPendingMediaChange(file, kind);
    }
  }

  function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const lower = file.name.toLowerCase();
    const isAudio =
      file.type.startsWith("audio/") ||
      [".mp3", ".wav", ".ogg", ".m4a"].some((ext) => lower.endsWith(ext));
    const kind: "audio" | "video" = isAudio ? "audio" : "video";
    void commitMedia(file, kind);
  }

  async function startRecording(kind: "audio" | "video") {
    setMediaErr("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMediaErr(t("In-browser recording is not supported on this device. Upload an audio or video file instead."));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(
        kind === "video"
          ? { audio: true, video: { width: { ideal: 960 }, height: { ideal: 540 } } }
          : { audio: true },
      );
      streamRef.current = stream;
      if (kind === "video" && liveVideoRef.current) {
        liveVideoRef.current.srcObject = stream;
        void liveVideoRef.current.play().catch(() => {});
      }
      const chosen = pickMime(kind);
      const rec = new MediaRecorder(stream, chosen.mime ? { mimeType: chosen.mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      rec.onstop = () => {
        stopTracks();
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: chosen.mime || (kind === "audio" ? "audio/webm" : "video/webm") });
        if (blob.size === 0) return;
        const file = new File([blob], `briefing-${kind}.${chosen.ext}`, { type: blob.type });
        void commitMedia(file, kind);
      };
      recorderRef.current = rec;
      rec.start(500);
      setRecSeconds(0);
      setRecording(true);
      timerRef.current = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    } catch (err) {
      stopTracks();
      setMediaErr(
        err instanceof Error && err.name === "NotAllowedError"
          ? t("Microphone/camera permission was denied. Allow access in your browser or upload a file instead.")
          : t("Could not start recording. Check microphone/camera permissions or upload a file."),
      );
    }
  }

  function stopRecording() {
    try {
      recorderRef.current?.stop();
    } catch {
      stopTracks();
      setRecording(false);
    }
  }

  async function removeMedia() {
    setMediaErr("");
    if (onDeleteLive && existingMediaUrl) {
      setUploading(true);
      try {
        await onDeleteLive();
        onRequireCompletionChange(false);
      } catch (err) {
        setMediaErr(err instanceof Error ? err.message : t("Could not remove media."));
      } finally {
        setUploading(false);
      }
    } else if (onPendingMediaChange) {
      onPendingMediaChange(null, null);
      onRequireCompletionChange(false);
    }
  }

  const previewSrc =
    localPreviewUrl ??
    (existingMediaUrl ? (existingMediaUrl.startsWith("/") ? apiUrl(existingMediaUrl) : existingMediaUrl) : null);
  const previewType: "audio" | "video" | null = pendingMediaType ?? existingMediaType ?? null;
  const hasMedia = !!previewSrc && !!previewType;
  const isLocked = disabled || busy || uploading;

  return (
    <div className="instructions-editor">
      <div className="field">
        <div className="field-label-row">
          <label htmlFor="exam-instructions-text">
            <FileText size={14} /> {t("Written instructions (optional)")}
          </label>
          <span className="subtle">{text.length} / 10,000</span>
        </div>
        <textarea
          id="exam-instructions-text"
          rows={4}
          maxLength={10000}
          disabled={isLocked}
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          placeholder={t(
            "Share exam rules, allowed materials, grading notes, or guidance students should read before starting…",
          )}
        />
      </div>

      <div className="instructions-media-box">
        <div className="instructions-media-head">
          <span className="field-label">{t("Voice or video briefing (optional)")}</span>
          <div className="seg-pick compact" role="tablist" aria-label={t("Briefing media mode")}>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "upload"}
              className={mode === "upload" ? "on" : ""}
              disabled={recording || isLocked}
              onClick={() => setMode("upload")}
            >
              <Upload size={13} /> {t("Upload")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "audio"}
              className={mode === "audio" ? "on" : ""}
              disabled={recording || isLocked}
              onClick={() => setMode("audio")}
            >
              <Mic size={13} /> {t("Record voice")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "video"}
              className={mode === "video" ? "on" : ""}
              disabled={recording || isLocked}
              onClick={() => setMode("video")}
            >
              <Video size={13} /> {t("Record video")}
            </button>
          </div>
        </div>

        {mode === "upload" && (
          <div className="media-upload-row">
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT}
              disabled={isLocked}
              onChange={handleFilePick}
              className="sr-only"
              id="instructions-media-input"
            />
            <button
              type="button"
              className="secondary"
              disabled={isLocked}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={15} />
              {uploading
                ? t("Uploading…")
                : hasMedia
                  ? t("Replace audio / video")
                  : t("Choose audio or video file")}
            </button>
            <span className="subtle">
              {t("MP3, WAV, OGG, M4A, MP4, WebM, or MOV · up to 25 MB")}
            </span>
          </div>
        )}

        {(mode === "audio" || mode === "video") && (
          <div className="media-recorder-box">
            {mode === "video" && (
              <video
                ref={liveVideoRef}
                muted
                playsInline
                className={`recorder-preview ${recording ? "live" : "hidden"}`}
              />
            )}
            <div className="media-recorder-controls">
              {!recording ? (
                <button
                  type="button"
                  className="secondary"
                  disabled={isLocked}
                  onClick={() => void startRecording(mode)}
                >
                  {mode === "audio" ? <Mic size={15} /> : <Video size={15} />}
                  {mode === "audio" ? t("Start voice recording") : t("Start video recording")}
                </button>
              ) : (
                <>
                  <span className="rec-pill" role="status">
                    <i className="rec-dot" /> {t("Recording")} {fmtTimer(recSeconds)}
                  </span>
                  <button type="button" className="primary" onClick={stopRecording}>
                    <Square size={13} /> {t("Stop & attach")}
                  </button>
                </>
              )}
              {!recording && (
                <span className="subtle">
                  {mode === "audio"
                    ? t("Records directly from your microphone.")
                    : t("Records directly from your camera & microphone.")}
                </span>
              )}
            </div>
          </div>
        )}

        <Feedback error={mediaErr || undefined} />

        {hasMedia && (
          <div className="media-attached-card">
            <div className="media-attached-top">
              <span className="media-type-chip">
                {previewType === "video" ? <Video size={13} /> : <Volume2 size={13} />}
                {previewType === "video" ? t("Video briefing") : t("Voice briefing")}
                {pendingFile ? ` · ${fmtSize(pendingFile.size)}` : ""}
              </span>
              <button
                type="button"
                className="text-button danger"
                disabled={isLocked}
                onClick={() => void removeMedia()}
              >
                <Trash2 size={14} /> {t("Remove")}
              </button>
            </div>
            {previewType === "video" ? (
              <video src={previewSrc} controls playsInline className="briefing-video" />
            ) : (
              <audio src={previewSrc} controls className="briefing-audio" />
            )}
          </div>
        )}

        {hasMedia && (
          <label className="toggle-card compact">
            <input
              type="checkbox"
              checked={requireCompletion}
              disabled={isLocked}
              onChange={(e) => onRequireCompletionChange(e.target.checked)}
            />
            <div>
              <b>{t("Require students to finish listening/watching before starting")}</b>
              <small>
                {t("Locks the Start button until the briefing finishes playing (resumes are never blocked).")}
              </small>
            </div>
          </label>
        )}
      </div>
    </div>
  );
}

export function BriefingPlayer({
  text,
  mediaUrl,
  mediaType,
  requireCompletion = false,
  completed = false,
  onComplete,
  compact = false,
}: {
  text?: string | null;
  mediaUrl?: string | null;
  mediaType?: "audio" | "video" | null;
  requireCompletion?: boolean;
  completed?: boolean;
  onComplete?: () => void;
  compact?: boolean;
}) {
  const t = useT();
  const [pct, setPct] = useState(completed ? 100 : 0);
  const src = mediaUrl ? (mediaUrl.startsWith("/") ? apiUrl(mediaUrl) : mediaUrl) : null;
  const hasText = Boolean(text?.trim());
  const hasMedia = Boolean(src && mediaType);
  if (!hasText && !hasMedia) return null;

  function handleProgress(e: React.SyntheticEvent<HTMLMediaElement>) {
    const el = e.currentTarget;
    if (!Number.isFinite(el.duration) || el.duration <= 0) return;
    const p = Math.min(100, Math.round((el.currentTime / el.duration) * 100));
    setPct((prev) => Math.max(prev, p));
    if (p >= 95 && !completed) onComplete?.();
  }

  function handleEnded() {
    setPct(100);
    if (!completed) onComplete?.();
  }

  return (
    <section className={`briefing-card ${compact ? "compact" : ""}`} aria-label={t("Instructor instructions")}>
      <div className="briefing-card-head">
        <div className="briefing-card-title">
          {mediaType === "video" ? (
            <Video size={17} />
          ) : mediaType === "audio" ? (
            <Volume2 size={17} />
          ) : (
            <FileText size={17} />
          )}
          <h3>{t("Instructor instructions")}</h3>
        </div>
        {requireCompletion && hasMedia && (
          <span className={`briefing-gate-pill ${completed ? "done" : "pending"}`} role="status">
            {completed ? (
              <>
                <CheckCircle2 size={13} /> {t("Briefing completed")}
              </>
            ) : (
              <>
                <AlertCircle size={13} />{" "}
                {pct > 0
                  ? t("Required · {0}% played", { "0": pct })
                  : mediaType === "video"
                    ? t("Watch before starting")
                    : t("Listen before starting")}
              </>
            )}
          </span>
        )}
      </div>

      {hasText && <div className="briefing-text">{text}</div>}

      {hasMedia && src && (
        <div className="briefing-media-wrap">
          {mediaType === "video" ? (
            <video
              src={src}
              controls
              playsInline
              className="briefing-video"
              onTimeUpdate={handleProgress}
              onEnded={handleEnded}
            />
          ) : (
            <audio
              src={src}
              controls
              className="briefing-audio"
              onTimeUpdate={handleProgress}
              onEnded={handleEnded}
            />
          )}
        </div>
      )}
    </section>
  );
}
