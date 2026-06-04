"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createJob,
  createJobFromSrt,
  createJobFromSrtUpload,
  createJobFromUrl,
  listJobs,
  startJob,
  uploadToS3,
  type Job,
  type JobStatus,
} from "@/lib/api";

const STATUS_LABEL: Record<JobStatus, string> = {
  UPLOADED: "📤 Хүлээгдэж буй",
  DOWNLOADING: "⬇️ Татаж байна",
  EXTRACTING: "🔊 Аудио",
  TRANSCRIBING: "🎙️ STT",
  TRANSLATING: "🌐 Орчуулга",
  EDITING: "✏️ Засвар хүлээгдэж буй",
  SYNTHESIZING: "🗣️ Дуу үүсгэж буй",
  MUXING: "🎞️ Mux",
  DONE: "✅ Бэлэн",
  FAILED: "❌ Алдаа",
};

function statusClass(s: JobStatus): string {
  if (s === "DONE") return "status-pill success";
  if (s === "FAILED") return "status-pill error";
  return "status-pill active";
}

type ImportMode = "upload" | "url" | "srt";

const TABS: { id: ImportMode; label: string; sub: string }[] = [
  { id: "upload", label: "📁 Файл оруулах", sub: "Видеогоо browser-ээс upload хийнэ" },
  { id: "url", label: "🔗 URL-аас", sub: "Сервер шууд тат - upload хүлээх шаардлагагүй" },
  { id: "srt", label: "📄 SRT + Видео", sub: "Бэлэн хадмалыг орчуулаад mux хийнэ" },
];

/**
 * Languages the user can pick as the SOURCE for translation. Target is always
 * Mongolian (mn) — that's the product. Whisper/Gemini handle all of these
 * out of the box; the prompt is templated as "${src} → ${tgt}".
 */
const SOURCE_LANGUAGES: { code: string; label: string }[] = [
  { code: "zh", label: "🇨🇳 Хятад (Mandarin)" },
  { code: "en", label: "🇬🇧 Англи" },
  { code: "ko", label: "🇰🇷 Солонгос" },
  { code: "ja", label: "🇯🇵 Япон" },
  { code: "ru", label: "🇷🇺 Орос" },
  { code: "es", label: "🇪🇸 Испани" },
  { code: "fr", label: "🇫🇷 Франц" },
  { code: "de", label: "🇩🇪 Герман" },
  { code: "tr", label: "🇹🇷 Турк" },
  { code: "vi", label: "🇻🇳 Вьетнам" },
  { code: "th", label: "🇹🇭 Тайланд" },
  { code: "id", label: "🇮🇩 Индонез" },
  { code: "hi", label: "🇮🇳 Хинди" },
  { code: "ar", label: "🇸🇦 Араб" },
  { code: "pt", label: "🇵🇹 Португал" },
  { code: "it", label: "🇮🇹 Итали" },
];

export default function Home() {
  const [mode, setMode] = useState<ImportMode>("upload");
  const [sourceLanguage, setSourceLanguage] = useState("zh");

  // upload mode
  const [file, setFile] = useState<File | null>(null);
  const [uploadPct, setUploadPct] = useState(0);
  const [dragOver, setDragOver] = useState(false);

  // url + srt modes share videoUrl
  const [videoUrl, setVideoUrl] = useState("");

  // srt mode
  const [srtContent, setSrtContent] = useState("");
  const [srtFilename, setSrtFilename] = useState("");
  /** SRT mode sub-toggle — paste a video URL OR upload the video from disk. */
  const [srtVideoSource, setSrtVideoSource] = useState<"url" | "upload">(
    "url",
  );
  const [srtVideoFile, setSrtVideoFile] = useState<File | null>(null);

  // common
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    const refresh = () => {
      listJobs()
        .then((j) => setJobs(j))
        .catch((err) => console.error("listJobs:", err))
        .finally(() => setJobsLoading(false));
    };
    refresh();
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const onSubmit = async () => {
    setError("");
    setBusy(true);
    setUploadPct(0);
    try {
      if (mode === "upload") {
        if (!file) throw new Error("Файл сонгоно уу");
        const { jobId, uploadUrl, contentType } = await createJob(
          file.name,
          sourceLanguage,
        );
        await uploadToS3(uploadUrl, file, contentType, setUploadPct);
        await startJob(jobId);
        router.push(`/jobs/${jobId}`);
      } else if (mode === "url") {
        if (!videoUrl.trim()) throw new Error("URL оруулна уу");
        const { jobId } = await createJobFromUrl(
          videoUrl.trim(),
          sourceLanguage,
        );
        router.push(`/jobs/${jobId}`);
      } else {
        if (!srtContent.trim()) throw new Error("SRT файлаа оруулна уу");
        if (srtVideoSource === "url") {
          if (!videoUrl.trim()) throw new Error("Видео URL оруулна уу");
          const { jobId } = await createJobFromSrt(
            videoUrl.trim(),
            srtContent,
            sourceLanguage,
          );
          router.push(`/jobs/${jobId}`);
        } else {
          if (!srtVideoFile) throw new Error("Видео файлаа сонгоно уу");
          const { jobId, uploadUrl, contentType } =
            await createJobFromSrtUpload(
              srtVideoFile.name,
              srtContent,
              sourceLanguage,
            );
          await uploadToS3(uploadUrl, srtVideoFile, contentType, setUploadPct);
          await startJob(jobId);
          router.push(`/jobs/${jobId}`);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const onDrop = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f && f.type.startsWith("video/")) setFile(f);
  };

  const onSrtFile = async (f: File | null) => {
    if (!f) return;
    const text = await f.text();
    setSrtContent(text);
    setSrtFilename(f.name);
  };

  const canSubmit =
    !busy &&
    ((mode === "upload" && !!file) ||
      (mode === "url" && !!videoUrl.trim()) ||
      (mode === "srt" &&
        !!srtContent.trim() &&
        (srtVideoSource === "url"
          ? !!videoUrl.trim()
          : !!srtVideoFile)));

  return (
    <>
      <nav className="nav">
        <div className="nav-brand">
          <span className="logo" />
          <span>dubme.mn</span>
        </div>
      </nav>

      <main className="shell">
        <div className="orb orb-1" />
        <div className="orb orb-2" />

        <section className="hero">
          <span className="hero-eyebrow">AI dubbing platform</span>
          <h1>
            Хятад видеогоо <span className="accent">монгол хэлээр</span>
            <br />
            автоматаар орчуул
          </h1>
          <p>
            Whisper-ээр транскрипц, Gemini 2.5 Pro-оор орчуулга. 2-цаг хүртэлх
            киног минутын дотор хадмалтай болгоно.
          </p>
        </section>

        <section className="card card-featured">
          <h2 className="card-title">Бичлэг оруулах</h2>
          <p className="card-subtitle">
            {TABS.find((t) => t.id === mode)?.sub}
          </p>

          {/* Source language */}
          <label style={{ marginBottom: "1rem" }}>
            <span>Эх хэл (орчуулагдах хэл)</span>
            <select
              value={sourceLanguage}
              onChange={(e) => setSourceLanguage(e.target.value)}
              disabled={busy}
            >
              {SOURCE_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
            <span
              className="muted"
              style={{
                display: "block",
                fontSize: "0.75rem",
                marginTop: "0.4rem",
              }}
            >
              Эцсийн орчуулга үргэлж <strong>монгол</strong> хэлээр.
            </span>
          </label>

          {/* Mode selector tabs */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: "0.4rem",
              marginBottom: "1rem",
              padding: "0.25rem",
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
            }}
          >
            {TABS.map((t) => {
              const active = t.id === mode;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setMode(t.id);
                    setError("");
                  }}
                  disabled={busy}
                  style={{
                    padding: "0.6rem 0.5rem",
                    border: "none",
                    borderRadius: "calc(var(--radius-sm) - 4px)",
                    background: active ? "var(--accent)" : "transparent",
                    color: active ? "#fff" : "var(--text-muted)",
                    fontWeight: active ? 600 : 500,
                    fontSize: "0.85rem",
                    cursor: busy ? "not-allowed" : "pointer",
                    transition: "background 0.15s, color 0.15s",
                    boxShadow: "none",
                  }}
                >
                  {t.label}
                </button>
              );
            })}
          </div>

          {/* Mode-specific input */}
          {mode === "upload" && (
            <label
              htmlFor="file-input"
              className={`dropzone${dragOver ? " dragover" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
            >
              <div className="dropzone-icon">{file ? "🎬" : "📁"}</div>
              <div className="dropzone-title">
                {file ? file.name : "Файлаа энд чирж тавь, эсвэл сонго"}
              </div>
              <div className="muted">
                {file
                  ? `${(file.size / 1024 / 1024).toFixed(1)} MB`
                  : ".mp4 · .mov · .webm · .mkv — 2GB хүртэл"}
              </div>
              <input
                id="file-input"
                type="file"
                accept="video/*"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                disabled={busy}
                style={{ display: "none" }}
              />
            </label>
          )}

          {mode === "url" && (
            <label style={{ marginBottom: "1rem" }}>
              <span>Видеоны URL</span>
              <input
                type="url"
                value={videoUrl}
                onChange={(e) => setVideoUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=... эсвэл https://example.com/video.mp4"
                disabled={busy}
                autoFocus
              />
              <span
                className="muted"
                style={{
                  display: "block",
                  fontSize: "0.75rem",
                  marginTop: "0.4rem",
                  lineHeight: 1.5,
                }}
              >
                Дэмжсэн: <strong>YouTube</strong>, <strong>Bilibili</strong>,{" "}
                <strong>Vimeo</strong>, <strong>TikTok</strong>,{" "}
                <strong>Youku</strong>, <strong>iQiyi</strong>, Twitter/X,
                Facebook, Reddit гэх мэт ~1000 сайт (yt-dlp-аар), эсвэл шууд
                .mp4 · .mov · .webm · .mkv линк. 1080p хүртэлх чанараар татна.
              </span>
            </label>
          )}

          {mode === "srt" && (
            <>
              <label style={{ marginBottom: "0.5rem" }}>
                <span>Видео хаанаас</span>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "0.4rem",
                  }}
                >
                  {(["url", "upload"] as const).map((src) => {
                    const active = srtVideoSource === src;
                    return (
                      <button
                        key={src}
                        type="button"
                        onClick={() => setSrtVideoSource(src)}
                        disabled={busy}
                        style={{
                          padding: "0.5rem",
                          border: "1px solid var(--border)",
                          borderRadius: "var(--radius-sm)",
                          background: active
                            ? "var(--bg-card-hover)"
                            : "transparent",
                          color: active ? "var(--text)" : "var(--text-muted)",
                          fontWeight: active ? 600 : 500,
                          fontSize: "0.85rem",
                          cursor: busy ? "not-allowed" : "pointer",
                          boxShadow: "none",
                        }}
                      >
                        {src === "url" ? "🔗 URL" : "📁 Файл upload"}
                      </button>
                    );
                  })}
                </div>
              </label>

              {srtVideoSource === "url" ? (
                <label style={{ marginBottom: "0.75rem" }}>
                  <span>Видеоны URL</span>
                  <input
                    type="url"
                    value={videoUrl}
                    onChange={(e) => setVideoUrl(e.target.value)}
                    placeholder="https://www.youtube.com/watch?v=... эсвэл https://example.com/movie.mp4"
                    disabled={busy}
                  />
                </label>
              ) : (
                <label style={{ marginBottom: "0.75rem" }}>
                  <span>Видео файл</span>
                  <div
                    style={{
                      display: "flex",
                      gap: "0.5rem",
                      alignItems: "center",
                    }}
                  >
                    <input
                      type="file"
                      accept="video/*"
                      onChange={(e) =>
                        setSrtVideoFile(e.target.files?.[0] ?? null)
                      }
                      disabled={busy}
                      style={{ flex: 1 }}
                    />
                    {srtVideoFile && (
                      <span
                        className="muted"
                        style={{ fontSize: "0.8rem" }}
                      >
                        🎬 {(srtVideoFile.size / 1024 / 1024).toFixed(1)} MB
                      </span>
                    )}
                  </div>
                </label>
              )}

              <label style={{ marginBottom: "0.75rem" }}>
                <span>SRT файл</span>
                <div
                  style={{
                    display: "flex",
                    gap: "0.5rem",
                    alignItems: "center",
                  }}
                >
                  <input
                    type="file"
                    accept=".srt,text/plain"
                    onChange={(e) => onSrtFile(e.target.files?.[0] ?? null)}
                    disabled={busy}
                    style={{ flex: 1 }}
                  />
                  {srtFilename && (
                    <span
                      className="muted"
                      style={{ fontSize: "0.8rem" }}
                    >
                      📄 {srtFilename}
                    </span>
                  )}
                </div>
              </label>

              <label style={{ marginBottom: "1rem" }}>
                <span>
                  SRT агуулга (засаж болно — {srtContent.length} тэмдэгт)
                </span>
                <textarea
                  value={srtContent}
                  onChange={(e) => setSrtContent(e.target.value)}
                  disabled={busy}
                  rows={8}
                  placeholder={`1\n00:00:01,000 --> 00:00:04,000\nFirst subtitle line\n\n2\n00:00:04,500 --> 00:00:07,000\nSecond line`}
                  style={{
                    width: "100%",
                    resize: "vertical",
                    fontFamily: "ui-monospace, monospace",
                    fontSize: "0.85rem",
                  }}
                />
              </label>
            </>
          )}

          {busy && uploadPct > 0 && (
            <div style={{ marginBottom: "1rem" }}>
              <div
                className="row"
                style={{
                  justifyContent: "space-between",
                  marginBottom: "0.4rem",
                }}
              >
                <span className="muted">
                  Файлыг хадгалалт руу хуулж байна...
                </span>
                <span
                  className="muted"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {uploadPct.toFixed(0)}%
                </span>
              </div>
              <div className="progress">
                <div
                  style={{ width: `${uploadPct}%`, position: "static" }}
                />
              </div>
            </div>
          )}

          <button
            type="button"
            className="btn btn-large"
            onClick={onSubmit}
            disabled={!canSubmit}
            style={{ width: "100%" }}
          >
            {busy ? "Илгээж байна..." : "Эхлэх →"}
          </button>

          {error && (
            <p
              className="error-text"
              style={{ marginTop: "0.75rem" }}
            >
              ❌ {error}
            </p>
          )}
        </section>

        {jobs.length > 0 && (
          <section className="card">
            <h2 className="card-title">Сүүлийн ажлууд</h2>
            <p className="card-subtitle">
              Үүсгэсэн ажлуудаа эндээс үргэлжлүүлж эсвэл татаж авна
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {jobs.slice(0, 10).map((j) => (
                <Link
                  key={j.id}
                  href={`/jobs/${j.id}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto auto",
                    gap: "0.85rem",
                    alignItems: "center",
                    padding: "0.75rem 0.95rem",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--border)",
                    background: "var(--bg-card)",
                    color: "var(--text)",
                    textDecoration: "none",
                    transition: "border-color 0.15s, background 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "var(--border-strong)";
                    e.currentTarget.style.background = "var(--bg-card-hover)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "var(--border)";
                    e.currentTarget.style.background = "var(--bg-card)";
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontFamily: "ui-monospace, monospace",
                        fontSize: "0.85rem",
                        fontWeight: 500,
                      }}
                    >
                      {j.id.slice(0, 8)}
                    </div>
                    <div className="muted" style={{ fontSize: "0.75rem", marginTop: "0.15rem" }}>
                      {new Date(j.createdAt).toLocaleString()} ·{" "}
                      {j.sourceLanguage} → {j.targetLanguage}
                      {j.voiceName ? ` · ${j.voiceName}` : ""}
                    </div>
                  </div>
                  <span className={statusClass(j.status)}>
                    <span className="dot" />
                    {STATUS_LABEL[j.status]}
                  </span>
                  <span className="muted" style={{ fontSize: "1.1rem" }}>›</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {!jobsLoading && jobs.length === 0 && (
          <section className="card">
            <h2 className="card-title">Сүүлийн ажлууд</h2>
            <p className="muted" style={{ margin: 0 }}>
              Хараахан ажил үүсгэгдээгүй байна.
            </p>
          </section>
        )}

        <section className="card">
          <h2 className="card-title">Хэрхэн ажилладаг вэ</h2>
          <p className="card-subtitle">
            3 төрлийн оролт · ижил quality pipeline
          </p>

          <div className="feature-grid">
            <div className="feature-pill">
              <div className="feature-icon">📁</div>
              <div className="feature-label">Файл upload</div>
              <div className="feature-sub">Browser → DO Spaces (2GB хүртэл)</div>
            </div>
            <div className="feature-pill">
              <div className="feature-icon">🔗</div>
              <div className="feature-label">URL-аас тат</div>
              <div className="feature-sub">Сервер шууд татна — хязгааргүй</div>
            </div>
            <div className="feature-pill">
              <div className="feature-icon">📄</div>
              <div className="feature-label">SRT + видео</div>
              <div className="feature-sub">Бэлэн хадмалыг орчуулаад mux</div>
            </div>
            <div className="feature-pill">
              <div className="feature-icon">🎙️</div>
              <div className="feature-label">Транскрипц</div>
              <div className="feature-sub">Groq Whisper-large-v3</div>
            </div>
            <div className="feature-pill">
              <div className="feature-icon">🌐</div>
              <div className="feature-label">Орчуулга</div>
              <div className="feature-sub">Gemini 2.5 Pro + thinking</div>
            </div>
            <div className="feature-pill">
              <div className="feature-icon">🎞️</div>
              <div className="feature-label">SRT / Burned</div>
              <div className="feature-sub">ffmpeg + libass</div>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
