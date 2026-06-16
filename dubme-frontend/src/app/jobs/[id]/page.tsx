"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  getDownloadUrls,
  getJob,
  getPreviewUrls,
  getSegmentAudioUrl,
  getSegments,
  jobSrtDownloadUrl,
  refineTranslations,
  renameJob,
  startRender,
  SUBTITLE_REF_HEIGHT,
  updateSegment,
  type Job,
  type JobStatus,
  type OutputMode,
  type Segment,
  type SubtitleAlign,
  type SubtitleText,
} from "@/lib/api";
import { CHIMEGE_VOICES, ELEVENLABS_VOICES, GEMINI_VOICES } from "@/lib/voices";

const PIPELINE_STEPS: { id: JobStatus; label: string }[] = [
  { id: "UPLOADED", label: "Орлоо" },
  { id: "DOWNLOADING", label: "Татаж байна" },
  { id: "EXTRACTING", label: "Аудио" },
  { id: "TRANSCRIBING", label: "STT" },
  { id: "TRANSLATING", label: "Орчуулга" },
  { id: "EDITING", label: "Засвар" },
  { id: "SYNTHESIZING", label: "TTS" },
  { id: "MUXING", label: "Mux" },
];

const STATUS_LABEL: Record<JobStatus, string> = {
  UPLOADED: "Видео хүлээгдэж байна",
  DOWNLOADING: "Татаж байна",
  EXTRACTING: "Аудио гаргаж байна",
  TRANSCRIBING: "Хятад транскрипц",
  TRANSLATING: "Монгол руу орчуулж байна",
  EDITING: "Засварлахад бэлэн",
  SYNTHESIZING: "Дуу үүсгэж байна",
  MUXING: "Видеотой нэгтгэж байна",
  DONE: "Бэлэн",
  FAILED: "Алдаа",
};

const STATUS_ICON: Record<JobStatus, string> = {
  UPLOADED: "📤",
  DOWNLOADING: "⬇️",
  EXTRACTING: "🔊",
  TRANSCRIBING: "🎙️",
  TRANSLATING: "🌐",
  EDITING: "✏️",
  SYNTHESIZING: "🗣️",
  MUXING: "🎞️",
  DONE: "✅",
  FAILED: "❌",
};

/** Bundled subtitle fonts — must match the backend SUBTITLE_FONTS list. */
const SUBTITLE_FONTS: { value: string; label: string }[] = [
  { value: "Noto Sans", label: "Noto Sans" },
  { value: "PT Sans", label: "PT Sans" },
  { value: "Noto Serif", label: "Noto Serif" },
];

interface SubStyle {
  fontFamily: string;
  fontSize: number; // px @ 1080p
  bold: boolean;
  italic: boolean;
  textColor: string;
  outlineWidth: number;
  outlineColor: string;
  outlineAlpha: number; // 0-100 % opaque
  shadowDepth: number;
  shadowColor: string;
  bgColor: string | null;
  bgOpacity: number; // 0-100 % opaque
  align: SubtitleAlign;
  marginHPct: number;
  letterSpacing: number;
  positionPct: number; // bottom edge, % from top
  zhScale: number;
  zhColor: string | null;
}

const DEFAULT_STYLE: SubStyle = {
  fontFamily: "Noto Sans",
  fontSize: 48,
  bold: false,
  italic: false,
  textColor: "#FFFFFF",
  outlineWidth: 3,
  outlineColor: "#000000",
  outlineAlpha: 80,
  shadowDepth: 0,
  shadowColor: "#000000",
  bgColor: null,
  bgOpacity: 75,
  align: "center",
  marginHPct: 4,
  letterSpacing: 0,
  positionPct: 88,
  zhScale: 0.8,
  zhColor: null,
};

/** One-click looks. Each is a full SubStyle the user can then tweak. */
const STYLE_PRESETS: { id: string; label: string; style: SubStyle }[] = [
  { id: "tv", label: "📺 Сонгодог ТВ", style: { ...DEFAULT_STYLE } },
  {
    id: "youtube",
    label: "▶️ YouTube",
    style: { ...DEFAULT_STYLE, fontFamily: "Noto Sans", fontSize: 44, bgColor: "#000000", bgOpacity: 70, outlineWidth: 1, positionPct: 90 },
  },
  {
    id: "cinema",
    label: "🎬 Кино шар",
    style: { ...DEFAULT_STYLE, fontFamily: "PT Sans", fontSize: 52, textColor: "#FFE234", outlineColor: "#1A1A00", outlineWidth: 3, shadowDepth: 1.5, positionPct: 88 },
  },
  {
    id: "minimal",
    label: "✨ Минимал",
    style: { ...DEFAULT_STYLE, fontFamily: "Montserrat", fontSize: 40, textColor: "#F5F5F5", outlineWidth: 1, outlineAlpha: 35, positionPct: 92 },
  },
  {
    id: "dual",
    label: "🌏 Хос хэл",
    style: { ...DEFAULT_STYLE, fontFamily: "Noto Sans", fontSize: 46, bgColor: "#000000", bgOpacity: 55, outlineWidth: 1.5, positionPct: 86, zhScale: 0.78, zhColor: "#FFD24D" },
  },
];
// "Montserrat" preset falls back gracefully (not bundled) — keep to Noto.
STYLE_PRESETS[3].style.fontFamily = "Noto Sans";

/**
 * Pre-filled style instructions for the AI refine card (genre presets).
 */
const REFINE_PRESETS: { id: string; label: string; prompt: string }[] = [
  { id: "news", label: "📰 Мэдээний нэвтрүүлэг", prompt: "Энэ бол албан ёсны мэдээний нэвтрүүлэг. Орчуулгыг objective, цэгцтэй, утга төгс мэдээний өнгөөр зас. Гуравдугаар бие, идэвхтэй өгүүлбэр хэлбэр. Бодит баримт, цаг хугацаа, газар нэрийг үнэн зөв илэрхийл. Хэт яриа, ойр дотно үгсээс зайлсхий." },
  { id: "documentary", label: "🎥 Баримтат кино", prompt: "Энэ бол баримтат кино. Орчуулгыг өгүүлэгчийн тайван, судалгаатай өнгө аястай болгож зас. Уншиж тайлбарлаж буй мэт цэгцтэй, гэхдээ сэтгэл татах байх. Объектив байдлаа барина." },
  { id: "horror", label: "👻 Аймшгийн кино", prompt: "Энэ бол аймшгийн кино. Орчуулгыг айдас, түгшүүртэй уур амьсгал төрүүлэх үгсээр зас. Богино, огцом өгүүлбэр ашигла. Чимээгүй айдас, сэжиглэл илэрхийлэх үг сонго." },
  { id: "comedy", label: "😂 Инээдмийн кино", prompt: "Энэ бол инээдмийн кино. Орчуулгыг хөгжилтэй, инээдтэй, чөлөөт ярианы аястай болго. Slang болон онигоонд ашиглагддаг хэллэг чөлөөтэй ашигла. Хараал, бүдүүлэг үг бичиж болохгүй." },
  { id: "drama", label: "💔 Драм / Сэтгэл хөдлөм", prompt: "Энэ бол драмын/сэтгэл хөдлөм кино. Орчуулгыг дотоод мэдрэмж, сэтгэлийн гүн илэрхийлэл бүхий үгсээр зас. Зүрхэнд нөлөөлөх, уянгын утгатай үг сонго." },
  { id: "action", label: "🔥 Адал явдалт (Action)", prompt: "Энэ бол адал явдалт кино. Орчуулгыг эрчимтэй, эрч хүчтэй, богино тушаалт өгүүлбэрээр зас. Өрнөлд тохирох үг сонго. Огцом тушаал ашигла." },
  { id: "kid", label: "🧸 Хүүхдэд зориулсан", prompt: "Энэ бол хүүхдэд зориулагдсан контент. Орчуулгыг хүүхдийн ойлгох энгийн, найрсаг, эерэг үгсээр зас. Айдас төрүүлэх, ярвигтай үгсээс зайлсхий. Өгүүлбэр богино, ойлгомжтой." },
  { id: "tutorial", label: "🎓 Хичээл / Туториал", prompt: "Энэ бол сурах хичээл/туториал контент. Орчуулгыг үе шаттай тайлбарласан, ойлгомжтой, заах өнгөөр зас. Техникийн нэр томьёог үндсэн утгаар нь үлдээж болно, тоонуудыг үг болгоно." },
  { id: "podcast", label: "🎙️ Подкаст / Ярилцлага", prompt: "Энэ бол подкаст эсвэл ярилцлагын бичлэг. Орчуулгыг хоёр хүн дотноор ярьж буй мэт, хагас албан ёсны, ярианы өнгөтэй болго." },
  { id: "vlog", label: "📱 Влог / Хувийн бичлэг", prompt: "Энэ бол влог эсвэл хувийн бичлэг. Орчуулгыг өөртөө ярьж буй мэт, ил тод, ярианы аястай болго. Эрч хүчтэй, эерэг өнгө аяс." },
  { id: "custom", label: "✍️ Өөрөө бичих", prompt: "" },
];

function stepStatus(current: JobStatus, step: JobStatus): "done" | "active" | "pending" {
  const order = PIPELINE_STEPS.map((s) => s.id);
  if (current === "DONE") return "done";
  if (current === "FAILED") {
    return order.indexOf(step) <= order.indexOf("EDITING") ? "done" : "pending";
  }
  const ci = order.indexOf(current);
  const si = order.indexOf(step);
  if (si < ci) return "done";
  if (si === ci) return "active";
  return "pending";
}

function hexToRgba(hex: string, alpha01: number): string {
  const m = hex.replace(/^#/, "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha01})`;
}

export default function JobPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [job, setJob] = useState<Job | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [ttsProvider, setTtsProvider] = useState<"gemini" | "chimege" | "elevenlabs">("chimege");
  const [voice, setVoice] = useState("FEMALE3v2");
  const [stylePrompt, setStylePrompt] = useState("");
  const [outputMode, setOutputMode] = useState<OutputMode>("dub");
  const [subtitleText, setSubtitleText] = useState<SubtitleText>("translated");
  const [subtitleBurn, setSubtitleBurn] = useState(true);
  const [capTo1080, setCapTo1080] = useState(true);

  const [style, setStyle] = useState<SubStyle>(DEFAULT_STYLE);
  const [presetId, setPresetId] = useState<string>("tv");

  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const contentRect = useVideoContentRect(previewVideoRef);
  const activeSeg = useActiveCue(previewVideoRef, segments);

  const [refinePresetId, setRefinePresetId] = useState<string>(REFINE_PRESETS[0].id);
  const [refinePrompt, setRefinePrompt] = useState<string>(REFINE_PRESETS[0].prompt);
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState("");
  const [previousTranslations, setPreviousTranslations] = useState<Record<string, string>>({});
  const refineSnapshotRef = useRef<Record<string, string> | null>(null);
  const wasRefiningRef = useRef(false);

  const [downloads, setDownloads] = useState<{ output?: string; subtitle?: string }>({});
  const [previews, setPreviews] = useState<{ input?: string; output?: string }>({});
  const [busy, setBusy] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [segmentAudio, setSegmentAudio] = useState<Record<string, string>>({});

  const segmentsLoadedRef = useRef(false);
  const previewsLoadedRef = useRef(false);
  const downloadsLoadedRef = useRef(false);

  const setField = useCallback(<K extends keyof SubStyle>(key: K, val: SubStyle[K]) => {
    setStyle((s) => ({ ...s, [key]: val }));
    setPresetId("custom");
  }, []);

  const applyPreset = (pid: string) => {
    const p = STYLE_PRESETS.find((x) => x.id === pid);
    if (!p) return;
    setStyle({ ...p.style });
    setPresetId(pid);
  };

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const intervalForStatus = (s: JobStatus): number => {
      switch (s) {
        case "EXTRACTING": return 4000;
        case "TRANSCRIBING": return 4000;
        case "TRANSLATING": return 3000;
        case "SYNTHESIZING": return 3000;
        case "MUXING": return 4000;
        // EDITING is a stable, user-driven pause: nothing changes until the
        // user renders or refines, so poll slowly when idle (the refining
        // override below speeds back up while a background refine runs).
        case "EDITING": return 12000;
        default: return 2500;
      }
    };

    const poll = async () => {
      try {
        const j = await getJob(id);
        if (cancelled) return;
        setJob(j);

        if (
          !segmentsLoadedRef.current &&
          (j.status === "EDITING" || j.status === "DONE" || j.status === "FAILED")
        ) {
          const segs = await getSegments(id);
          if (!cancelled) {
            setSegments(segs);
            segmentsLoadedRef.current = true;
          }
        }

        // Background AI-refine finished → refetch the rewritten segments.
        if (wasRefiningRef.current && !j.refining) {
          wasRefiningRef.current = false;
          setRefining(false);
          if (j.refineError) setRefineError(j.refineError);
          getSegments(id)
            .then((segs) => {
              if (cancelled) return;
              if (refineSnapshotRef.current && !j.refineError) {
                setPreviousTranslations(refineSnapshotRef.current);
              }
              setSegments(segs);
            })
            .catch(() => void 0);
        } else if (j.refining) {
          wasRefiningRef.current = true;
        }

        if (j.status === "DONE") {
          if (!downloadsLoadedRef.current) {
            const [dl, pv] = await Promise.all([getDownloadUrls(id), getPreviewUrls(id)]);
            if (!cancelled) {
              setDownloads(dl);
              setPreviews(pv);
              downloadsLoadedRef.current = true;
              previewsLoadedRef.current = true;
            }
          }
          return;
        }
        if (j.status === "FAILED") return;

        if (
          !previewsLoadedRef.current &&
          (j.status === "EDITING" || j.status === "TRANSCRIBING" || j.status === "TRANSLATING")
        ) {
          getPreviewUrls(id)
            .then((pv) => {
              if (cancelled) return;
              setPreviews((prev) => ({ ...prev, ...pv }));
              if (pv.input) previewsLoadedRef.current = true;
            })
            .catch(() => void 0);
        }

        // While a background refine runs, poll fast so completion is detected
        // promptly; otherwise use the per-status cadence (slow when idle).
        const nextMs = j.refining ? 2500 : intervalForStatus(j.status);
        if (!cancelled) timer = setTimeout(poll, nextMs);
      } catch (err) {
        console.error(err);
        if (!cancelled) timer = setTimeout(poll, 5000);
      }
    };
    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  const onSegmentLocalEdit = (segId: string, text: string) => {
    setSegments((prev) =>
      prev.map((s) => (s.id === segId ? { ...s, translatedText: text, edited: true } : s)),
    );
  };

  const onSegmentBlur = async (segId: string, text: string) => {
    try {
      await updateSegment(segId, text);
    } catch (err) {
      console.error("Save failed:", err);
    }
  };

  const onPresetChange = (pid: string) => {
    setRefinePresetId(pid);
    const preset = REFINE_PRESETS.find((p) => p.id === pid);
    if (preset) setRefinePrompt(preset.prompt);
  };

  const onRefine = async () => {
    const prompt = refinePrompt.trim();
    if (prompt.length < 3) {
      setRefineError("Заавар хэт богино байна — дор хаяж 3 тэмдэгт оруулна уу.");
      return;
    }
    setRefineError("");
    const snapshot: Record<string, string> = {};
    for (const s of segments) snapshot[s.id] = s.translatedText ?? "";
    refineSnapshotRef.current = snapshot;
    wasRefiningRef.current = true;
    setRefining(true);
    try {
      await refineTranslations(id, prompt); // runs in background; poll detects completion
    } catch (err) {
      wasRefiningRef.current = false;
      setRefining(false);
      setRefineError(err instanceof Error ? err.message : "Сайжруулахад алдаа гарлаа");
    }
  };

  const onUndoRefine = async (segId: string) => {
    const prev = previousTranslations[segId];
    if (prev === undefined) return;
    setSegments((cur) =>
      cur.map((s) => (s.id === segId ? { ...s, translatedText: prev, edited: true } : s)),
    );
    setPreviousTranslations((cur) => {
      const next = { ...cur };
      delete next[segId];
      return next;
    });
    try {
      await updateSegment(segId, prev);
    } catch (err) {
      console.error("undo refine failed:", err);
    }
  };

  const onAcceptRefine = () => setPreviousTranslations({});

  const onRender = async () => {
    setBusy(true);
    try {
      await startRender(id, {
        outputMode,
        subtitleText,
        subtitleBurn,
        capTo1080,
        subtitleFontFamily: style.fontFamily,
        subtitleFontSize: style.fontSize,
        subtitleBold: style.bold,
        subtitleItalic: style.italic,
        subtitleTextColor: style.textColor,
        subtitleOutlineWidth: style.outlineWidth,
        subtitleOutlineColor: style.outlineColor,
        subtitleOutlineAlpha: style.outlineAlpha,
        subtitleShadowDepth: style.shadowDepth,
        subtitleShadowColor: style.shadowColor,
        subtitleBgColor: style.bgColor,
        subtitleBgOpacity: style.bgOpacity,
        subtitleAlign: style.align,
        subtitleMarginHPct: style.marginHPct,
        subtitleLetterSpacing: style.letterSpacing,
        subtitlePositionPct: style.positionPct,
        subtitleZhScale: style.zhScale,
        subtitleZhColor: style.zhColor,
        ...(outputMode === "dub"
          ? { voiceName: voice, ttsProvider, stylePrompt: stylePrompt || undefined }
          : {}),
      });
      // Reset polling guards so the new render's progress + outputs load.
      downloadsLoadedRef.current = false;
      // Optimistically flip out of EDITING so the progress UI shows instantly
      // (the idle poll is on a slow cadence; the next tick confirms the real
      // status). Avoids a multi-second "nothing happened" gap after clicking.
      setJob((prev) =>
        prev
          ? {
              ...prev,
              status: outputMode === "dub" ? "SYNTHESIZING" : "MUXING",
              progress: 0,
              progressNote: null,
            }
          : prev,
      );
    } finally {
      setBusy(false);
    }
  };

  const onTtsProviderChange = (p: "gemini" | "chimege" | "elevenlabs") => {
    setTtsProvider(p);
    setVoice(
      p === "chimege"
        ? "FEMALE3v2"
        : p === "elevenlabs"
          ? ELEVENLABS_VOICES[0].value
          : "Kore",
    );
  };

  const loadSegmentAudio = async (segId: string) => {
    if (segmentAudio[segId]) return;
    try {
      const url = await getSegmentAudioUrl(segId);
      setSegmentAudio((prev) => ({ ...prev, [segId]: url }));
    } catch {
      setSegmentAudio((prev) => ({ ...prev, [segId]: "" }));
    }
  };

  const beginEditName = () => {
    setNameDraft(job?.name ?? "");
    setEditingName(true);
  };
  const saveName = async () => {
    const next = nameDraft.trim();
    setEditingName(false);
    try {
      const updated = await renameJob(id, next || null);
      setJob((prev) => (prev ? { ...prev, name: updated.name } : prev));
    } catch (err) {
      console.error("rename failed:", err);
    }
  };

  // Show a "scroll to top" button once the (long) editing page is scrolled.
  useEffect(() => {
    const onScroll = () => setShowScrollTop(window.scrollY > 600);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (!job) {
    return (
      <main className="shell">
        <p className="muted">Уншиж байна...</p>
      </main>
    );
  }

  const isProcessing =
    job.status !== "DONE" && job.status !== "FAILED" && job.status !== "EDITING";
  const showProgressBar =
    (job.status === "SYNTHESIZING" || job.status === "MUXING") && (job.progress ?? 0) > 0;

  return (
    <>
      <nav className="nav">
        <Link href="/" className="nav-brand" style={{ textDecoration: "none", color: "inherit" }}>
          <span className="logo" />
          <span>dubme.mn</span>
        </Link>
      </nav>

      <main className="shell">
        <section className="card">
          <div className="row" style={{ justifyContent: "space-between", marginBottom: "0.75rem" }}>
            <div>
              {editingName ? (
                <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", marginBottom: "0.25rem" }}>
                  <input
                    autoFocus
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveName();
                      if (e.key === "Escape") setEditingName(false);
                    }}
                    maxLength={200}
                    placeholder={`Job · ${id.slice(0, 8)}`}
                    style={{ fontSize: "1rem", padding: "0.35rem 0.55rem", maxWidth: 340, width: "60vw" }}
                  />
                  <button type="button" onClick={saveName} title="Хадгалах"
                    style={{ padding: "0.35rem 0.6rem", fontSize: "0.85rem", border: "1px solid var(--border)", borderRadius: 6, background: "rgba(124,92,255,0.2)", color: "var(--text)", cursor: "pointer", boxShadow: "none" }}>✓</button>
                  <button type="button" onClick={() => setEditingName(false)} title="Болих"
                    style={{ padding: "0.35rem 0.55rem", fontSize: "0.85rem", border: "1px solid var(--border)", borderRadius: 6, background: "transparent", color: "var(--text-muted)", cursor: "pointer", boxShadow: "none" }}>✕</button>
                </div>
              ) : (
                <h2 className="card-title" style={{ marginBottom: "0.25rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <span style={job.name ? undefined : { fontFamily: "ui-monospace" }}>
                    {job.name || `Job · ${id.slice(0, 8)}`}
                  </span>
                  <button type="button" onClick={beginEditName} title="Нэр засах"
                    style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: "0.85rem", padding: 2, lineHeight: 1 }}>✏️</button>
                </h2>
              )}
              <p className="muted" style={{ margin: 0 }}>
                {job.name ? `${id.slice(0, 8)} · ` : ""}
                {new Date(job.createdAt).toLocaleString()}
              </p>
            </div>
            <span
              className={
                job.status === "DONE"
                  ? "status-pill success"
                  : job.status === "FAILED"
                    ? "status-pill error"
                    : "status-pill active"
              }
            >
              <span className="dot" />
              {STATUS_ICON[job.status]} {STATUS_LABEL[job.status]}
              {showProgressBar && ` · ${job.progress}%`}
            </span>
          </div>

          <div className="stepper">
            {PIPELINE_STEPS.map((step) => {
              const s = stepStatus(job.status, step.id);
              return (
                <div key={step.id} className={`step ${s}`}>
                  <div className="step-dot" />
                  <span>{step.label}</span>
                </div>
              );
            })}
            <div className={`step ${job.status === "DONE" ? "done" : ""}`}>
              <div className="step-dot" />
              <span>Бэлэн</span>
            </div>
          </div>

          {isProcessing && !showProgressBar && (
            <div className="progress indeterminate" style={{ marginTop: "1rem" }}>
              <div />
            </div>
          )}
          {showProgressBar && (
            <div style={{ marginTop: "1rem" }}>
              <div
                style={{
                  height: 8,
                  borderRadius: 4,
                  background: "rgba(255,255,255,0.08)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${job.progress}%`,
                    height: "100%",
                    background: "linear-gradient(90deg, var(--accent), var(--accent-2))",
                    transition: "width 0.4s ease",
                  }}
                />
              </div>
              {job.progressNote && (
                <p className="muted" style={{ margin: "0.4rem 0 0", fontSize: "0.8rem" }}>
                  {job.progressNote}
                </p>
              )}
            </div>
          )}
        </section>

        {job.status === "FAILED" && job.errorMessage && (
          <section className="card">
            <h3 className="card-title">Алдаа гарлаа</h3>
            <p className="error-text" style={{ wordBreak: "break-word" }}>
              {job.errorMessage}
            </p>
          </section>
        )}

        {job.status === "EDITING" && previews.input && (
          <section className="card">
            <h2 className="card-title">Эх видео · Хадмалын засвар</h2>
            <p className="card-subtitle">
              Видеог тоглуулахад хадмал яг шарагдах байрлал, фонт, өнгөөрөө харагдана
              {!subtitleBurn && " · (хадмал шатаахыг асаавал доорх тохиргоо идэвхжинэ)"}
            </p>
            <div
              style={{
                position: "relative",
                borderRadius: "var(--radius-sm)",
                overflow: "hidden",
                background: "#000",
                maxHeight: 500,
              }}
            >
              <video
                ref={previewVideoRef}
                src={previews.input}
                controls
                preload="metadata"
                playsInline
                style={{ width: "100%", display: "block", maxHeight: 500 }}
              />
              {subtitleBurn && contentRect && (
                <SubtitlePreviewOverlay
                  rect={contentRect}
                  style={style}
                  subtitleText={subtitleText}
                  activeSegment={activeSeg}
                  videoRef={previewVideoRef}
                  onPositionChange={(pct) => setField("positionPct", pct)}
                />
              )}
            </div>

            {subtitleBurn && (
              <SubtitleStylePanel
                style={style}
                setField={setField}
                presetId={presetId}
                applyPreset={applyPreset}
                showZh={subtitleText === "both"}
              />
            )}
          </section>
        )}

        {job.status === "EDITING" && (
          <>
            <section className="card">
              <h2 className="card-title">Орчуулга шалгах</h2>
              <p className="card-subtitle">
                Зүүн талд хятад текст. Баруун талаас орчуулгыг засаж болно — өөрчлөлт
                автоматаар хадгалагдана.
              </p>

              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: "0.5rem",
                  marginBottom: "0.75rem",
                  padding: "0.6rem 0.85rem",
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                  fontSize: "0.82rem",
                }}
              >
                <span style={{ color: "var(--text-muted)", marginRight: "auto" }}>
                  📥 SRT-г одоо татаж авах:
                </span>
                <a href={jobSrtDownloadUrl(id, "translated")} download className="btn btn-secondary" style={{ padding: "0.35rem 0.7rem", fontSize: "0.78rem", fontWeight: 500 }}>
                  🇲🇳 Монгол
                </a>
                <a href={jobSrtDownloadUrl(id, "source")} download className="btn btn-secondary" style={{ padding: "0.35rem 0.7rem", fontSize: "0.78rem", fontWeight: 500 }}>
                  🌐 Эх хэл
                </a>
                <a href={jobSrtDownloadUrl(id, "both")} download className="btn btn-secondary" style={{ padding: "0.35rem 0.7rem", fontSize: "0.78rem", fontWeight: 500 }}>
                  📑 Хос
                </a>
              </div>

              {Object.keys(previousTranslations).length > 0 && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "0.75rem",
                    padding: "0.6rem 0.9rem",
                    marginBottom: "0.75rem",
                    background: "rgba(124, 92, 255, 0.08)",
                    border: "1px solid rgba(124, 92, 255, 0.4)",
                    borderRadius: "var(--radius-sm)",
                    fontSize: "0.85rem",
                  }}
                >
                  <span>
                    ✨ <strong>{Object.keys(previousTranslations).length}</strong> мөр шинэчлэгдсэн.
                    Доорх "Өмнө:" мөрийг харьцуулж шалгана уу.
                  </span>
                  <button type="button" onClick={onAcceptRefine} style={{ padding: "0.35rem 0.75rem", fontSize: "0.8rem", fontWeight: 600, border: "1px solid rgba(124, 92, 255, 0.6)", borderRadius: 6, background: "rgba(124, 92, 255, 0.2)", color: "var(--text)", cursor: "pointer", boxShadow: "none", whiteSpace: "nowrap" }}>
                    ✓ Бүгдийг хүлээн авах
                  </button>
                </div>
              )}

              <div className="segments">
                {segments.map((s) => {
                  const audioUrl = segmentAudio[s.id];
                  const prev = previousTranslations[s.id];
                  const showDiff = prev !== undefined && prev !== (s.translatedText ?? "");
                  return (
                    <div key={s.id} className="segment-row">
                      <div className="segment-time">
                        {formatTime(s.startSec)}
                        <br />→ {formatTime(s.endSec)}
                        {s.audioKey && (
                          <button type="button" onClick={() => loadSegmentAudio(s.id)} style={{ marginTop: "0.4rem", padding: "0.25rem 0.5rem", fontSize: "0.7rem", fontWeight: 500, border: "1px solid var(--border)", borderRadius: 6, background: "rgba(255,255,255,0.05)", color: "var(--text-muted)", cursor: "pointer", boxShadow: "none" }} title="TTS-ийг сонсох">
                            {audioUrl ? "🔊" : "🎧"}
                          </button>
                        )}
                      </div>
                      <div className="segment-source">{s.sourceText}</div>
                      <div className="segment-translated">
                        <textarea
                          value={s.translatedText ?? ""}
                          onChange={(e) => onSegmentLocalEdit(s.id, e.target.value)}
                          onBlur={(e) => onSegmentBlur(s.id, e.target.value)}
                        />
                        {showDiff && (
                          <div style={{ display: "flex", alignItems: "flex-start", gap: "0.4rem", marginTop: "0.4rem", padding: "0.4rem 0.55rem", background: "rgba(255,255,255,0.03)", borderLeft: "2px solid rgba(124, 92, 255, 0.5)", borderRadius: 4, fontSize: "0.78rem", color: "var(--text-muted)", lineHeight: 1.4 }}>
                            <span style={{ fontWeight: 600, color: "rgba(124, 92, 255, 0.9)", flexShrink: 0 }}>Өмнө:</span>
                            <span style={{ flex: 1, textDecoration: "line-through", textDecorationColor: "rgba(255,255,255,0.25)" }}>{prev || "(хоосон)"}</span>
                            <button type="button" onClick={() => onUndoRefine(s.id)} title="Энэ мөрийг өмнөх рүү буцаах" style={{ padding: "0.1rem 0.4rem", fontSize: "0.75rem", border: "1px solid var(--border)", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: "pointer", boxShadow: "none", flexShrink: 0 }}>↶ Буцаах</button>
                          </div>
                        )}
                        {audioUrl && (
                          <audio src={audioUrl} controls preload="metadata" style={{ width: "100%", marginTop: "0.4rem", height: 32 }} />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="card">
              <h2 className="card-title">Орчуулга сайжруулах (AI-аар)</h2>
              <p className="card-subtitle">
                Контентийн төрлийг сонгоход AI үг хэллэг, аяс, өгүүлбэрийн бүтцийг тухайн
                жанрд тохируулан дахин боловсруулна
              </p>

              <label>
                <span>Контентийн төрөл</span>
                <select value={refinePresetId} onChange={(e) => onPresetChange(e.target.value)} disabled={refining}>
                  {REFINE_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </label>

              <label>
                <span>Заавар (засаж болно)</span>
                <textarea
                  value={refinePrompt}
                  onChange={(e) => {
                    setRefinePrompt(e.target.value);
                    if (refinePresetId !== "custom") {
                      const current = REFINE_PRESETS.find((p) => p.id === refinePresetId);
                      if (current && current.prompt !== e.target.value) setRefinePresetId("custom");
                    }
                  }}
                  disabled={refining}
                  rows={5}
                  placeholder="Жишээ нь: Орчуулгыг илүү хөгжилтэй, инээдэмтэй болгож зас..."
                  style={{ width: "100%", resize: "vertical", fontFamily: "inherit" }}
                />
              </label>

              <button type="button" className="btn" onClick={onRefine} disabled={refining || refinePrompt.trim().length < 3} style={{ width: "100%" }}>
                {refining ? "✨ Сайжруулж байна... (хүлээнэ үү)" : "✨ Орчуулга сайжруулах"}
              </button>

              {refineError && (
                <p className="error-text" style={{ marginTop: "0.75rem" }}>❌ {refineError}</p>
              )}
            </section>

            {job.inputKey && (
              <section className="card">
                <h2 className="card-title">Гаргалтын тохиргоо</h2>
                <p className="card-subtitle">Монгол дуугаар дубляж хийх эсвэл зөвхөн хадмал гаргах</p>

                <label>
                  <span>Гаргах төрөл</span>
                  <select value={outputMode} onChange={(e) => setOutputMode(e.target.value as OutputMode)}>
                    <option value="dub">🎬 Дубляж — монгол дуу (хадмал нэмж болно)</option>
                    <option value="subtitle">📄 Зөвхөн хадмал — эх дуу хэвээр, TTS-гүй</option>
                  </select>
                </label>

                {outputMode === "dub" && (
                  <>
                    <label>
                      <span>TTS engine</span>
                      <select value={ttsProvider} onChange={(e) => onTtsProviderChange(e.target.value as "gemini" | "chimege" | "elevenlabs")}>
                        <option value="chimege">Chimege (монгол, чанартай) ⭐</option>
                        <option value="elevenlabs">ElevenLabs (илэрхийлэлтэй — туршилт)</option>
                        <option value="gemini">Gemini Flash TTS</option>
                      </select>
                    </label>

                    <label>
                      <span>Хоолой</span>
                      <select value={voice} onChange={(e) => setVoice(e.target.value)}>
                        {(ttsProvider === "chimege"
                          ? CHIMEGE_VOICES
                          : ttsProvider === "elevenlabs"
                            ? ELEVENLABS_VOICES
                            : GEMINI_VOICES
                        ).map((v) => (
                          <option key={v.value} value={v.value}>{v.label}</option>
                        ))}
                      </select>
                    </label>

                    {ttsProvider === "elevenlabs" && (
                      <p className="card-subtitle" style={{ marginTop: "-0.25rem", fontSize: "0.78rem", padding: "0.5rem 0.75rem", background: "rgba(255,200,0,0.08)", border: "1px solid rgba(255,200,0,0.3)", borderRadius: 4 }}>
                        ⚠️ ElevenLabs монгол хэлийг албан ёсоор дэмждэггүй — v3 уншихыг оролдоно, чанар тогтворгүй байж болзошгүй. Эх жүжигчний сэтгэл хөдлөлийг (emotion) audio tag болгон ашиглана. Туршилтаар сонсож шалгана уу.
                      </p>
                    )}

                    {ttsProvider === "gemini" && (
                      <label>
                        <span>Style instructions (optional)</span>
                        <input type="text" value={stylePrompt} onChange={(e) => setStylePrompt(e.target.value)} placeholder="Read warmly like a storyteller" />
                      </label>
                    )}
                  </>
                )}

                <label>
                  <span>Хадмалын текст</span>
                  <select value={subtitleText} onChange={(e) => setSubtitleText(e.target.value as SubtitleText)}>
                    <option value="translated">Монгол орчуулга</option>
                    <option value="source">Эх хэл (хятад)</option>
                    <option value="both">Хос (хятад + монгол)</option>
                  </select>
                </label>

                <label>
                  <span>Хадмалыг хаана гаргах</span>
                  <select value={subtitleBurn ? "burn" : "file"} onChange={(e) => setSubtitleBurn(e.target.value === "burn")}>
                    <option value="burn">🔥 Видеон дээр шатаах — нэг файл (+SRT). Дээрх preview-гээр загварыг тааруулна</option>
                    <option value="file">📄 Зөвхөн SRT файл — видеон дээр харагдахгүй</option>
                  </select>
                </label>

                {subtitleBurn && (
                  <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <input type="checkbox" checked={capTo1080} onChange={(e) => setCapTo1080(e.target.checked)} style={{ width: "auto" }} />
                    <span style={{ marginBottom: 0 }}>1080p болгож шахах (4K видеог хурдан шарна)</span>
                  </label>
                )}

                <button type="button" className="btn btn-large" onClick={onRender} disabled={busy} style={{ width: "100%", marginTop: "0.75rem" }}>
                  {busy ? "..." : outputMode === "dub" ? "🎬 Видеог үүсгэх" : subtitleBurn ? "📄 Хадмалтай видео гаргах" : "📄 Хадмал (SRT) гаргах"}
                </button>
              </section>
            )}
          </>
        )}

        {job.status === "DONE" && (
          <section className="card">
            <h2 className="card-title">🎉 Бэлэн боллоо</h2>
            <p className="card-subtitle">Видеогоо доор шууд үзэж сонсох боломжтой</p>

            {previews.output && (
              <video src={previews.output} controls preload="metadata" playsInline style={{ width: "100%", borderRadius: "var(--radius-sm)", background: "#000", marginBottom: "1rem", maxHeight: 600 }} />
            )}

            <div className="row" style={{ marginTop: "0.75rem" }}>
              {downloads.output && (
                <a href={downloads.output} download className="btn">⬇️ Видео</a>
              )}
              {downloads.subtitle && (
                <a href={downloads.subtitle} download className="btn btn-secondary">⬇️ Subtitle (srt)</a>
              )}
            </div>
          </section>
        )}
      </main>

      {showScrollTop && (
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          title="Дээш очих"
          aria-label="Дээш очих"
          style={{
            position: "fixed",
            right: "1.5rem",
            bottom: "1.5rem",
            zIndex: 50,
            width: 48,
            height: 48,
            borderRadius: "50%",
            border: "1px solid var(--border-strong)",
            background: "var(--bg-elevated)",
            backdropFilter: "blur(8px)",
            color: "var(--text)",
            fontSize: "1.25rem",
            cursor: "pointer",
            boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          ↑
        </button>
      )}
    </>
  );
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1);
  return `${m}:${s.padStart(4, "0")}`;
}

/* ─── Preview scaling: the letterboxed video content rect ────────────────── */
interface ContentRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function useVideoContentRect(
  videoRef: React.RefObject<HTMLVideoElement>,
): ContentRect | null {
  const [rect, setRect] = useState<ContentRect | null>(null);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const compute = () => {
      const vw = v.videoWidth;
      const vh = v.videoHeight;
      const ew = v.clientWidth;
      const eh = v.clientHeight;
      if (!vw || !vh || !ew || !eh) return;
      // object-fit lets the browser fit the video inside the element; we
      // replicate the contain math to find the actual picture rectangle.
      const scale = Math.min(ew / vw, eh / vh);
      const cw = vw * scale;
      const ch = vh * scale;
      setRect({ left: (ew - cw) / 2, top: (eh - ch) / 2, width: cw, height: ch });
    };
    const ro = new ResizeObserver(compute);
    ro.observe(v);
    v.addEventListener("loadedmetadata", compute);
    compute();
    return () => {
      ro.disconnect();
      v.removeEventListener("loadedmetadata", compute);
    };
  }, [videoRef]);
  return rect;
}

/* ─── Active cue tracking (frame-accurate, with paused/seek support) ─────── */
function useActiveCue(
  videoRef: React.RefObject<HTMLVideoElement>,
  segments: Segment[],
): Segment | null {
  const [active, setActive] = useState<Segment | null>(null);
  const sorted = useMemo(
    () => [...segments].sort((a, b) => a.startSec - b.startSec),
    [segments],
  );
  useEffect(() => {
    const v = videoRef.current;
    if (!v || sorted.length === 0) return;
    let vfcId = 0;
    let rafId = 0;
    let stopped = false;

    const find = (t: number): Segment | null => {
      let lo = 0;
      let hi = sorted.length - 1;
      let ans: Segment | null = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid].startSec <= t) {
          if (t < sorted[mid].endSec) ans = sorted[mid];
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return ans;
    };

    const tick = () => {
      if (stopped) return;
      const seg = find(v.currentTime);
      setActive((prev) => (prev?.id === seg?.id ? prev : seg));
      schedule();
    };
    const schedule = () => {
      // requestVideoFrameCallback fires per presented frame (incl. after a seek
      // while paused) → frame-exact, unlike the ~4Hz 'timeupdate' event.
      const anyV = v as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number;
      };
      if (typeof anyV.requestVideoFrameCallback === "function") {
        vfcId = anyV.requestVideoFrameCallback(tick);
      } else {
        rafId = requestAnimationFrame(tick);
      }
    };
    tick(); // initial paint
    const onSeek = () => tick();
    v.addEventListener("seeked", onSeek);
    return () => {
      stopped = true;
      v.removeEventListener("seeked", onSeek);
      const anyV = v as HTMLVideoElement & {
        cancelVideoFrameCallback?: (id: number) => void;
      };
      if (vfcId && anyV.cancelVideoFrameCallback) anyV.cancelVideoFrameCallback(vfcId);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [videoRef, sorted]);
  return active;
}

/* ─── Subtitle preview overlay (matches the burned .ass) ─────────────────── */
function SubtitlePreviewOverlay({
  rect,
  style,
  subtitleText,
  activeSegment,
  videoRef,
  onPositionChange,
}: {
  rect: ContentRect;
  style: SubStyle;
  subtitleText: SubtitleText;
  activeSegment: Segment | null;
  videoRef: React.RefObject<HTMLVideoElement>;
  onPositionChange: (pct: number) => void;
}) {
  // Hooks must run unconditionally (before any early return).
  const dragRef = useRef<{ startY: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);

  const fallbackZh = "示例字幕 Өө Үү";
  const fallbackMn = "Энэ бол жишээ хадмал";
  const zhRaw = activeSegment?.sourceText?.trim();
  const mnRaw = activeSegment?.translatedText?.trim();
  const isSample = !activeSegment;
  const zh = zhRaw || (isSample ? fallbackZh : "");
  const mn = mnRaw || (isSample ? fallbackMn : "");

  // Same scale the backend uses: value(px@1080) * actualHeight/1080.
  const scale = rect.height / SUBTITLE_REF_HEIGHT;
  const mainPx = style.fontSize * scale;
  const zhPx = mainPx * style.zhScale;
  const outlinePx = style.outlineWidth * scale;
  const spacingPx = style.letterSpacing * scale;
  const shadowPx = style.shadowDepth * scale;

  const outlineRgba = hexToRgba(style.outlineColor, style.outlineAlpha / 100);
  const textShadow = style.bgColor
    ? "none"
    : buildOutlineShadow(outlinePx, outlineRgba, shadowPx, style.shadowColor);

  const lines: { text: string; cjk: boolean; px: number; color: string }[] = [];
  if (subtitleText === "source") {
    lines.push({ text: zh, cjk: true, px: mainPx, color: style.textColor });
  } else if (subtitleText === "both") {
    if (zh) lines.push({ text: zh, cjk: true, px: zhPx, color: style.zhColor ?? style.textColor });
    if (mn) lines.push({ text: mn, cjk: false, px: mainPx, color: style.textColor });
  } else {
    lines.push({ text: mn, cjk: false, px: mainPx, color: style.textColor });
  }
  if (lines.every((l) => !l.text)) return null;

  // ── drag-to-position (on the text block only; threshold avoids click-jack) ──
  const clientYToPct = (clientY: number) => {
    const v = videoRef.current;
    if (!v) return style.positionPct;
    const elRect = v.getBoundingClientRect();
    const yInContent = clientY - (elRect.top + rect.top);
    return Math.max(0, Math.min(100, Math.round((yInContent / rect.height) * 100)));
  };
  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { startY: e.clientY, moved: false };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientY - d.startY) < 4) return; // ignore tiny jitter / plain clicks
    d.moved = true;
    setDragging(true);
    onPositionChange(clientYToPct(e.clientY));
  };
  const endDrag = (e: React.PointerEvent) => {
    dragRef.current = null;
    setDragging(false);
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };

  return (
    <div
      style={{
        position: "absolute",
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: `${style.marginHPct}%`,
          right: `${style.marginHPct}%`,
          top: `${style.positionPct}%`,
          transform: "translateY(-100%)", // bottom-anchored, like ASS Alignment=2
          textAlign: style.align,
          pointerEvents: "none",
        }}
      >
        <span
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          title="Чирж дээш доош зөөнө үү"
          style={{
            display: "inline-block",
            pointerEvents: "auto",
            cursor: dragging ? "grabbing" : "grab",
            userSelect: "none",
            touchAction: "none",
            fontWeight: style.bold ? 700 : 400,
            fontStyle: style.italic ? "italic" : "normal",
            letterSpacing: `${spacingPx}px`,
            lineHeight: 1.2,
            backgroundColor: style.bgColor ? hexToRgba(style.bgColor, style.bgOpacity / 100) : "transparent",
            padding: style.bgColor ? `${Math.max(2, outlinePx)}px ${Math.max(6, outlinePx * 2.5)}px` : 0,
            maxWidth: "100%",
            outline: dragging ? "1px dashed rgba(124,92,255,0.7)" : "none",
            outlineOffset: 3,
          }}
        >
          {lines.map((l, i) => (
            <div
              key={i}
              style={{
                fontFamily: l.cjk
                  ? `'Noto Sans SC', '${style.fontFamily}', sans-serif`
                  : `'${style.fontFamily}', 'Noto Sans', sans-serif`,
                fontSize: `${l.px}px`,
                color: l.color,
                textShadow,
                whiteSpace: "pre-wrap",
              }}
            >
              {l.text}
            </div>
          ))}
          {isSample && (
            <div
              style={{
                fontSize: `${Math.max(9, mainPx * 0.32)}px`,
                color: "rgba(255,255,255,0.55)",
                fontFamily: "var(--font-inter), sans-serif",
                textShadow: "none",
                fontWeight: 400,
                letterSpacing: 0,
                marginTop: 2,
              }}
            >
              жишээ
            </div>
          )}
        </span>
      </div>
    </div>
  );
}

/** Build a multi-direction text-shadow that approximates a libass outline (+ optional drop shadow). */
function buildOutlineShadow(
  outlinePx: number,
  outlineRgba: string,
  shadowPx: number,
  shadowColor: string,
): string {
  const parts: string[] = [];
  if (outlinePx > 0.1) {
    const r = outlinePx;
    for (let a = 0; a < 360; a += 45) {
      const dx = (Math.cos((a * Math.PI) / 180) * r).toFixed(2);
      const dy = (Math.sin((a * Math.PI) / 180) * r).toFixed(2);
      parts.push(`${dx}px ${dy}px 0 ${outlineRgba}`);
    }
  }
  if (shadowPx > 0.1) {
    parts.push(`${shadowPx.toFixed(2)}px ${shadowPx.toFixed(2)}px ${(shadowPx * 1.5).toFixed(2)}px ${hexToRgba(shadowColor, 0.65)}`);
  }
  return parts.length ? parts.join(", ") : "none";
}

/* ─── Style controls (live next to the video) ────────────────────────────── */
function SubtitleStylePanel({
  style,
  setField,
  presetId,
  applyPreset,
  showZh,
}: {
  style: SubStyle;
  setField: <K extends keyof SubStyle>(key: K, val: SubStyle[K]) => void;
  presetId: string;
  applyPreset: (id: string) => void;
  showZh: boolean;
}) {
  const swatch = (value: string, onChange: (v: string) => void, disabled = false) => (
    <input
      type="color"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      style={{ width: 40, height: 32, padding: 0, border: "1px solid var(--border)", borderRadius: 6, background: "transparent", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1 }}
    />
  );

  return (
    <div style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid var(--border)" }}>
      {/* Presets */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "0.9rem" }}>
        {STYLE_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => applyPreset(p.id)}
            style={{
              padding: "0.35rem 0.7rem",
              fontSize: "0.78rem",
              fontWeight: 600,
              borderRadius: 999,
              cursor: "pointer",
              boxShadow: "none",
              border: presetId === p.id ? "1px solid var(--border-glow)" : "1px solid var(--border)",
              background: presetId === p.id ? "var(--accent-soft)" : "rgba(255,255,255,0.04)",
              color: "var(--text)",
            }}
          >
            {p.label}
          </button>
        ))}
        {presetId === "custom" && (
          <span style={{ alignSelf: "center", fontSize: "0.75rem", color: "var(--text-subtle)" }}>· өөрчилсөн</span>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem 1.25rem" }}>
        <label>
          <span>Фонт</span>
          <select value={style.fontFamily} onChange={(e) => setField("fontFamily", e.target.value)}>
            {SUBTITLE_FONTS.map((f) => (
              <option key={f.value} value={f.value} style={{ fontFamily: `'${f.value}'` }}>{f.label}</option>
            ))}
          </select>
        </label>

        <label>
          <span>Үсгийн хэмжээ ({style.fontSize}px)</span>
          <input type="range" min={20} max={120} step={1} value={style.fontSize} onChange={(e) => setField("fontSize", Number(e.target.value))} style={{ width: "100%" }} />
        </label>

        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
          <label style={{ display: "flex", gap: "0.35rem", alignItems: "center", marginBottom: 0 }}>
            <input type="checkbox" checked={style.bold} onChange={(e) => setField("bold", e.target.checked)} style={{ width: "auto" }} />
            <span style={{ marginBottom: 0, fontWeight: 700 }}>Bold</span>
          </label>
          <label style={{ display: "flex", gap: "0.35rem", alignItems: "center", marginBottom: 0 }}>
            <input type="checkbox" checked={style.italic} onChange={(e) => setField("italic", e.target.checked)} style={{ width: "auto" }} />
            <span style={{ marginBottom: 0, fontStyle: "italic" }}>Italic</span>
          </label>
        </div>

        <label>
          <span>Зэрэгцүүлэлт</span>
          <div style={{ display: "flex", gap: "0.3rem" }}>
            {(["left", "center", "right"] as SubtitleAlign[]).map((a) => (
              <button key={a} type="button" onClick={() => setField("align", a)} style={{ flex: 1, padding: "0.4rem", fontSize: "0.8rem", borderRadius: 6, cursor: "pointer", boxShadow: "none", border: style.align === a ? "1px solid var(--border-glow)" : "1px solid var(--border)", background: style.align === a ? "var(--accent-soft)" : "rgba(255,255,255,0.04)", color: "var(--text)" }}>
                {a === "left" ? "⬅" : a === "center" ? "⬛" : "➡"}
              </button>
            ))}
          </div>
        </label>

        <label>
          <span>Үсгийн өнгө</span>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            {swatch(style.textColor, (v) => setField("textColor", v))}
            <code style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{style.textColor.toUpperCase()}</code>
          </div>
        </label>

        <label>
          <span>Контурын зузаан ({style.outlineWidth})</span>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <input type="range" min={0} max={8} step={0.5} value={style.outlineWidth} onChange={(e) => setField("outlineWidth", Number(e.target.value))} style={{ flex: 1 }} />
            {swatch(style.outlineColor, (v) => setField("outlineColor", v))}
          </div>
        </label>

        <label>
          <span>Контурын тунгалаг ({style.outlineAlpha}%)</span>
          <input type="range" min={0} max={100} step={5} value={style.outlineAlpha} onChange={(e) => setField("outlineAlpha", Number(e.target.value))} style={{ width: "100%" }} />
        </label>

        <label>
          <span>Сүүдэр ({style.shadowDepth}){style.bgColor ? " — дэвсгэртэй үед идэвхгүй" : ""}</span>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <input type="range" min={0} max={6} step={0.5} value={style.shadowDepth} disabled={!!style.bgColor} onChange={(e) => setField("shadowDepth", Number(e.target.value))} style={{ flex: 1, opacity: style.bgColor ? 0.4 : 1 }} />
            {swatch(style.shadowColor, (v) => setField("shadowColor", v), !!style.bgColor)}
          </div>
        </label>

        <label>
          <span>Дэвсгэр хайрцаг</span>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <label style={{ display: "flex", gap: "0.3rem", alignItems: "center", marginBottom: 0, fontSize: "0.82rem", color: "var(--text-muted)" }}>
              <input type="checkbox" checked={style.bgColor !== null} onChange={(e) => setField("bgColor", e.target.checked ? "#000000" : null)} style={{ width: "auto" }} />
              Асаах
            </label>
            {swatch(style.bgColor ?? "#000000", (v) => setField("bgColor", v), style.bgColor === null)}
          </div>
        </label>

        {style.bgColor !== null && (
          <label>
            <span>Хайрцгийн тунгалаг ({style.bgOpacity}%)</span>
            <input type="range" min={0} max={100} step={5} value={style.bgOpacity} onChange={(e) => setField("bgOpacity", Number(e.target.value))} style={{ width: "100%" }} />
          </label>
        )}

        <label>
          <span>Хажуугийн зай ({style.marginHPct}%)</span>
          <input type="range" min={0} max={30} step={1} value={style.marginHPct} onChange={(e) => setField("marginHPct", Number(e.target.value))} style={{ width: "100%" }} />
        </label>

        <label>
          <span>Үсэг хоорондын зай ({style.letterSpacing})</span>
          <input type="range" min={-1} max={8} step={0.5} value={style.letterSpacing} onChange={(e) => setField("letterSpacing", Number(e.target.value))} style={{ width: "100%" }} />
        </label>

        <label style={{ gridColumn: "1 / -1" }}>
          <span>Босоо байрлал ({style.positionPct}% — дээр 0 ↔ доор 100)</span>
          <input type="range" min={0} max={100} step={1} value={style.positionPct} onChange={(e) => setField("positionPct", Number(e.target.value))} style={{ width: "100%" }} />
          <span className="muted" style={{ display: "block", fontSize: "0.74rem", marginTop: "0.2rem" }}>
            Preview видеон дээрх хадмалыг чирж зөөж ч болно.
          </span>
        </label>

        {showZh && (
          <>
            <label>
              <span>Хятад мөрийн хэмжээ ({Math.round(style.zhScale * 100)}%)</span>
              <input type="range" min={40} max={120} step={2} value={Math.round(style.zhScale * 100)} onChange={(e) => setField("zhScale", Number(e.target.value) / 100)} style={{ width: "100%" }} />
            </label>
            <label>
              <span>Хятад мөрийн өнгө</span>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <label style={{ display: "flex", gap: "0.3rem", alignItems: "center", marginBottom: 0, fontSize: "0.82rem", color: "var(--text-muted)" }}>
                  <input type="checkbox" checked={style.zhColor !== null} onChange={(e) => setField("zhColor", e.target.checked ? "#FFD24D" : null)} style={{ width: "auto" }} />
                  Тусгай
                </label>
                {swatch(style.zhColor ?? "#FFD24D", (v) => setField("zhColor", v), style.zhColor === null)}
              </div>
            </label>
          </>
        )}
      </div>
    </div>
  );
}
