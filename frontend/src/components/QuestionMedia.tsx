import { useEffect, useRef, useState } from "react";
import { Mic, Square, Trash2, Upload, Video, Volume2 } from "lucide-react";
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
    return kind === "audio"
      ? { mime: "audio/webm", ext: "webm" }
      : { mime: "video/webm", ext: "webm" };
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
  return kind === "audio"
    ? { mime: "audio/webm", ext: "webm" }
    : { mime: "video/webm", ext: "webm" };
}

export function questionDisplayText(
  q: { text?: string | null; mediaType?: string | null; imageUrl?: string | null },
  t: (s: string) => string,
): string {
  if (q.text?.trim()) return q.text.trim();
  if (q.mediaType === "video") return t("Video question");
  if (q.mediaType === "audio") return t("Voice recording question");
  if (q.imageUrl) return t("Image question");
  return t("Media question");
}

export function QuestionMediaPlayer({
  mediaUrl,
  mediaType,
  compact = false,
}: {
  mediaUrl?: string | null;
  mediaType?: "audio" | "video" | string | null;
  compact?: boolean;
}) {
  const t = useT();
  if (!mediaUrl || !mediaType) return null;
  const src = mediaUrl.startsWith("/") ? apiUrl(mediaUrl) : mediaUrl;
  const isVideo = mediaType === "video";
  return (
    <div className={`q-media-player ${compact ? "compact" : ""}`}>
      <div className="q-media-player-head">
        <span className="media-type-chip">
          {isVideo ? <Video size={12} /> : <Volume2 size={12} />}
          {isVideo ? t("Video attachment") : t("Voice recording")}
        </span>
      </div>
      {isVideo ? (
        <video
          src={src}
          controls
          playsInline
          preload="metadata"
          className={`q-media-video ${compact ? "compact" : ""}`}
        />
      ) : (
        <audio
          src={src}
          controls
          preload="metadata"
          className="q-media-audio"
        />
      )}
    </div>
  );
}

export interface QuestionMediaEditorProps {
  existingMediaUrl?: string | null;
  existingMediaType?: "audio" | "video" | null;
  pendingFile?: File | null;
  pendingMediaType?: "audio" | "video" | null;
  onPendingChange: (file: File | null, mediaType: "audio" | "video" | null) => void;
  onDeleteExisting?: () => Promise<void>;
  busy?: boolean;
}

export function QuestionMediaEditor({
  existingMediaUrl,
  existingMediaType,
  pendingFile,
  pendingMediaType,
  onPendingChange,
  onDeleteExisting,
  busy = false,
}: QuestionMediaEditorProps) {
  const t = useT();
  const [mode, setMode] = useState<"upload" | "audio" | "video">("upload");
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [mediaErr, setMediaErr] = useState("");
  const [removing, setRemoving] = useState(false);
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

  useEffect(
    () => () => {
      try {
        recorderRef.current?.stop();
      } catch {
        /* ignore */
      }
      stopTracks();
    },
    [],
  );

  function acceptFile(file: File, kind: "audio" | "video") {
    setMediaErr("");
    if (file.size > MAX_BYTES) {
      setMediaErr(t("Media file must be 25 MB or smaller."));
      return;
    }
    onPendingChange(file, kind);
  }

  function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const lower = file.name.toLowerCase();
    const isAudio =
      file.type.startsWith("audio/") ||
      [".mp3", ".wav", ".ogg", ".m4a"].some((ext) => lower.endsWith(ext));
    acceptFile(file, isAudio ? "audio" : "video");
  }

  async function startRecording(kind: "audio" | "video") {
    setMediaErr("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMediaErr(
        t("In-browser recording is not supported on this device. Upload an audio or video file instead."),
      );
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
        const blob = new Blob(chunksRef.current, {
          type: chosen.mime || (kind === "audio" ? "audio/webm" : "video/webm"),
        });
        if (blob.size === 0) return;
        const file = new File([blob], `question-${kind}.${chosen.ext}`, { type: blob.type });
        acceptFile(file, kind);
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

  async function handleRemove() {
    setMediaErr("");
    if (pendingFile) {
      onPendingChange(null, null);
      return;
    }
    if (existingMediaUrl && onDeleteExisting) {
      setRemoving(true);
      try {
        await onDeleteExisting();
      } catch (err) {
        setMediaErr(err instanceof Error ? err.message : t("Could not remove media."));
      } finally {
        setRemoving(false);
      }
    }
  }

  const previewSrc =
    localPreviewUrl ??
    (existingMediaUrl
      ? existingMediaUrl.startsWith("/")
        ? apiUrl(existingMediaUrl)
        : existingMediaUrl
      : null);
  const previewType: "audio" | "video" | null = pendingMediaType ?? existingMediaType ?? null;
  const hasMedia = !!previewSrc && !!previewType;
  const locked = busy || removing;

  return (
    <div className="field">
      <div className="instructions-media-box">
        <div className="instructions-media-head">
          <span className="field-label">{t("Voice recording or video (optional)")}</span>
          <div className="seg-pick compact" role="tablist" aria-label={t("Question media mode")}>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "upload"}
              className={mode === "upload" ? "on" : ""}
              disabled={recording || locked}
              onClick={() => setMode("upload")}
            >
              <Upload size={13} /> {t("Upload")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "audio"}
              className={mode === "audio" ? "on" : ""}
              disabled={recording || locked}
              onClick={() => setMode("audio")}
            >
              <Mic size={13} /> {t("Record voice")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "video"}
              className={mode === "video" ? "on" : ""}
              disabled={recording || locked}
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
              disabled={locked}
              onChange={handleFilePick}
              className="sr-only"
              id="question-media-input"
            />
            <button
              type="button"
              className="secondary"
              disabled={locked}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={15} />
              {hasMedia ? t("Replace audio / video") : t("Choose audio or video file")}
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
                  disabled={locked}
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
                {previewType === "video" ? t("Video question media") : t("Voice recording")}
                {pendingFile ? ` · ${fmtSize(pendingFile.size)}` : ""}
              </span>
              <button
                type="button"
                className="text-button danger"
                disabled={locked}
                onClick={() => void handleRemove()}
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
      </div>
    </div>
  );
}
