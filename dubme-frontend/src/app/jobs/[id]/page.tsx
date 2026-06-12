"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  getDownloadUrls,
  getJob,
  getPreviewUrls,
  getSegmentAudioUrl,
  getSegments,
  jobSrtDownloadUrl,
  refineTranslations,
  startRender,
  updateSegment,
  type Job,
  type JobStatus,
  type OutputMode,
  type Segment,
  type SubtitlePosition,
  type SubtitleText,
} from "@/lib/api";
import { CHIMEGE_VOICES, GEMINI_VOICES } from "@/lib/voices";


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
  DOWNLOADING: "URL-аас татаж байна",
  EXTRACTING: "Аудио гаргаж байна",
  TRANSCRIBING: "Хятад транскрипц",
  TRANSLATING: "Монгол руу орчуулж байна",
  EDITING: "Засварлахад бэлэн",
  SYNTHESIZING: "Дуу үүсгэж байна",
  MUXING: "Видеотой нэгтгэж байна",
  DONE: "Бэлэн",
  FAILED: "Алдаа",
};

/**
 * Pre-filled style instructions for the "Орчуулга сайжруулах" card.
 * Genre-driven — picking a preset tells Gemini what kind of content it's
 * dubbing so it adapts vocabulary, register, and pacing accordingly.
 * The textarea is always editable; "Өөрөө бичих" just clears it.
 */
const REFINE_PRESETS: { id: string; label: string; prompt: string }[] = [
  {
    id: "news",
    label: "📰 Мэдээний нэвтрүүлэг",
    prompt:
      "Энэ бол албан ёсны мэдээний нэвтрүүлэг. Орчуулгыг objective, цэгцтэй, " +
      "утга төгс мэдээний өнгөөр зас. Гуравдугаар бие, идэвхтэй өгүүлбэр " +
      "хэлбэр. Бодит баримт, цаг хугацаа, газар нэрийг үнэн зөв илэрхийл. " +
      "Хэт яриа, ойр дотно үгсээс зайлсхий. 'Мэдэгдсэн', 'явагдаж байна', " +
      "'тогтоосон', 'олон нийтийн анхааралд' гэх мэт мэдээний нийтлэг хэллэг " +
      "ашигла. Хүндэт хүмүүсийг нэр + албан тушаалаар нь дурдана.",
  },
  {
    id: "documentary",
    label: "🎥 Баримтат кино",
    prompt:
      "Энэ бол баримтат кино. Орчуулгыг өгүүлэгчийн (narrator) тайван, " +
      "судалгаатай өнгө аястай болгож зас. Уншиж тайлбарлаж буй мэт " +
      "цэгцтэй, гэхдээ мэдээллээс илүү сэтгэл татах байх. Дүрсэлсэн үг " +
      "хэрэглэж болно ('энэхүү ховор амьтан', 'тухайн үед', 'үе үе') " +
      "гэхдээ объектив байдлаа барина.",
  },
  {
    id: "horror",
    label: "👻 Аймшгийн кино",
    prompt:
      "Энэ бол аймшгийн кино. Орчуулгыг айдас, түгшүүртэй уур амьсгал " +
      "төрүүлэх үгсээр зас. Богино, огцом өгүүлбэр ашигла. Чимээгүй айдас, " +
      "сэжиглэл илэрхийлэх үг сонго ('сэжиглэх', 'шивнэх', 'чичрэх', " +
      "'ширтэх', 'нууцлаг', 'мөрөөр нь', 'юу нуугдаж байгаа юм бэ'). " +
      "Өчүүхэн зүйлийг ч нууцлаг, сөрөг утгатайгаар илэрхийл. Тоглогчийн " +
      "хоолой чичрэх, шивгэнэхэд тохирох үгийн сонголт хий — гэхдээ кинонд " +
      "хэрэглэгдэхүйц байх ёстой, хийсвэр болгож болохгүй.",
  },
  {
    id: "comedy",
    label: "😂 Инээдмийн кино",
    prompt:
      "Энэ бол инээдмийн кино. Орчуулгыг хөгжилтэй, инээдтэй, чөлөөт " +
      "ярианы аястай болго. Slang болон онигоонд ашиглагддаг хэллэг " +
      "('тийм кони', 'ёстой шал', 'ёо ёо', 'юу гэх вэ дээ', 'наанаас нь', " +
      "'аа тоо', 'үнэхээр зөв') чөлөөтэй ашигла. Адал сэтгэл хөдлөл, " +
      "элэглэх, гайхах өнгө аяс илэрхийлэхэд тохирох богино тодорхой " +
      "үгсийг сонго. Хараал, бүдүүлэг үг бичиж болохгүй ч ширүүн " +
      "илэрхийлэл ('адар', 'өл', 'юу гэв ээ') зөвшөөрөгдөнө.",
  },
  {
    id: "drama",
    label: "💔 Драм / Сэтгэл хөдлөм",
    prompt:
      "Энэ бол драмын/сэтгэл хөдлөм кино. Орчуулгыг дотоод мэдрэмж, " +
      "сэтгэлийн гүн илэрхийлэл бүхий үгсээр зас. Зүрхэнд нөлөөлөх, " +
      "уянгын утгатай үг сонго ('хүсэн хүлээх', 'санах', 'өвдөх', " +
      "'гэгээрэх', 'асгарах нулимс', 'санасан зүйлс минь', 'зүрх зүсэх'). " +
      "Уулзалт, салалт, эргэлзээ, хайр, найдвар зэрэг сэтгэл хөдлөлийг " +
      "тодорхой илэрхийл. Өгүүлбэрийг чөлөөтэй болгож болно гэхдээ " +
      "дубляжид тохирох уртаар үлдээ.",
  },
  {
    id: "action",
    label: "🔥 Адал явдалт (Action)",
    prompt:
      "Энэ бол адал явдалт (action) кино. Орчуулгыг эрчимтэй, эрч хүчтэй, " +
      "богино тушаалт өгүүлбэрээр зас. Зэвсэг, тулаан, мөшгөлт зэрэг " +
      "өрнөлд тохирох үг ('сум', 'дайралт', 'гар', 'ширт', 'явъя', " +
      "'болих хэрэгтэй', 'бид гарна') сонго. Үсрэх, цохих, хашгирах " +
      "хөдөлгөөнийг тодорхой илэрхийл. Огцом тушаал: 'Бүгд гадагш!', " +
      "'Унагах!', 'Хурдан!' гэх мэтийг хэлэгдсэн газарт нь ашиглана.",
  },
  {
    id: "kid",
    label: "🧸 Хүүхдэд зориулсан",
    prompt:
      "Энэ бол хүүхдэд зориулагдсан контент. Орчуулгыг хүүхдийн ойлгох " +
      "энгийн, найрсаг, эерэг үгсээр зас. Айдас төрүүлэх, хүчтэй сэтгэл " +
      "хөдлөлтэй, ярвигтай үгсээс зайлсхий. Хөгжилтэй, ойлгомжтой, дотно " +
      "үг хэрэглэ ('амьтад', 'хөгжилтэй', 'найзууд', 'явцгаая', 'тоглоё', " +
      "'хараач'). Өгүүлбэр богино, ойлгомжтой бүтэцтэй.",
  },
  {
    id: "tutorial",
    label: "🎓 Хичээл / Туториал",
    prompt:
      "Энэ бол сурах хичээл/туториал контент. Орчуулгыг сурагчдад үе " +
      "шаттай тайлбарласан, ойлгомжтой, заах өнгөөр зас. 'Эхлээд...', " +
      "'Дараа нь...', 'Жишээ нь...', 'Анхааралтай байгаарай', 'Дашрамд " +
      "хэлэхэд' гэх мэт зааж сургах хэллэг тохиромжтой газарт нь оруул. " +
      "Техникийн нэр томьёог үндсэн утгаар нь үлдээж болно, гэхдээ " +
      "тоонуудыг үг болгох ёстой.",
  },
  {
    id: "podcast",
    label: "🎙️ Подкаст / Ярилцлага",
    prompt:
      "Энэ бол подкаст эсвэл ярилцлагын бичлэг. Орчуулгыг хоёр хүн " +
      "дотноор ярьж буй мэт, хагас албан ёсны, ярианы өнгөтэй болго. " +
      "Анхааралтай сонсогдох бодолт, дамжих үгс ('тийм ээ', 'тэгээд " +
      "яасан гэхэд', 'байж болох уу', 'миний бодлоор', 'үнэндээ') " +
      "тохиромжтой газарт ашигла. Гэхдээ хэт ярианы 'юу', 'хм' зэргийг " +
      "хэт олон оруулахгүй.",
  },
  {
    id: "vlog",
    label: "📱 Влог / Хувийн бичлэг",
    prompt:
      "Энэ бол влог эсвэл хувийн бичлэг (vlog). Орчуулгыг өөртөө ярьж " +
      "буй мэт, ил тод, ярианы аястай болго. 'Би', 'миний', 'танд' гэх " +
      "мэт хувийн үгсийг чөлөөтэй ашигла. Эрч хүчтэй, эерэг өнгө аяс " +
      "('өнөөдөр энэ юу хийе гэж бодож байна', 'ёстой их сонирхолтой " +
      "юм', 'та нар яалт ч үгүй харах хэрэгтэй'). Залуу үзэгчдэд тохирох " +
      "чөлөөт хэллэг зөвшөөрөгдөнө.",
  },
  {
    id: "custom",
    label: "✍️ Өөрөө бичих",
    prompt: "",
  },
];

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

function stepStatus(
  current: JobStatus,
  step: JobStatus,
): "done" | "active" | "pending" {
  const order = PIPELINE_STEPS.map((s) => s.id);
  // After EDITING, the rest of the pipeline (SYNTHESIZING, MUXING) follows.
  // DONE means everything done.
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

export default function JobPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [job, setJob] = useState<Job | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [ttsProvider, setTtsProvider] = useState<"gemini" | "chimege">("chimege");
  const [voice, setVoice] = useState("FEMALE3v2");
  const [stylePrompt, setStylePrompt] = useState("");
  const [outputMode, setOutputMode] = useState<OutputMode>("dub");
  const [subtitleText, setSubtitleText] = useState<SubtitleText>("translated");
  // Default to burning subtitles onto the video — most users uploading a
  // video expect to see subs ON the video itself, not download a side file.
  const [subtitleBurn, setSubtitleBurn] = useState(true);
  const [subtitleFontSize, setSubtitleFontSize] = useState(22);
  const [subtitleTextColor, setSubtitleTextColor] = useState("#FFFFFF");
  const [subtitleBgColor, setSubtitleBgColor] = useState<string | null>(null);
  const [subtitlePosition, setSubtitlePosition] =
    useState<SubtitlePosition>("bottom");
  // Continuous vertical position: 0 = top of frame, 100 = bottom. Default
  // 88 matches the classic "lower-third subtitle" placement.
  const [subtitlePositionPct, setSubtitlePositionPct] = useState(88);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const [previewActiveSeg, setPreviewActiveSeg] = useState<Segment | null>(null);
  const [refinePresetId, setRefinePresetId] = useState<string>(REFINE_PRESETS[0].id);
  const [refinePrompt, setRefinePrompt] = useState<string>(REFINE_PRESETS[0].prompt);
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState("");
  /**
   * Snapshot of each segment's translatedText right before refine runs.
   * Lets us render an "Өмнө:" line under each row so the user can see what
   * changed, and offer per-row undo (↶) to revert just that segment.
   */
  const [previousTranslations, setPreviousTranslations] = useState<
    Record<string, string>
  >({});
  const [downloads, setDownloads] = useState<{ output?: string; subtitle?: string }>({});
  const [previews, setPreviews] = useState<{ input?: string; output?: string }>({});
  const [busy, setBusy] = useState(false);
  /** segment.id → presigned audio URL, lazily loaded when user clicks ▶︎. */
  const [segmentAudio, setSegmentAudio] = useState<Record<string, string>>({});

  // Polling guards. The poll function below recurses inside a single effect
  // closure, so reading React state from it would always see the captured
  // (stale) value — causing /segments and /preview to refire every cycle.
  // Refs side-step the closure: once a fetch lands, the ref flips true and
  // subsequent polls skip the call.
  const segmentsLoadedRef = useRef(false);
  const previewsLoadedRef = useRef(false);
  const downloadsLoadedRef = useRef(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    // Slow phases (uploading, ffmpeg) shouldn't be polled aggressively —
    // they last 10-30+ seconds and the answer rarely changes inside 2s.
    const intervalForStatus = (s: JobStatus): number => {
      switch (s) {
        case "EXTRACTING": return 5000;
        case "TRANSCRIBING": return 4000;
        case "TRANSLATING": return 3000;
        case "SYNTHESIZING": return 5000;
        case "MUXING": return 5000;
        default: return 2500;
      }
    };

    const poll = async () => {
      try {
        const j = await getJob(id);
        if (cancelled) return;
        setJob(j);

        // Segments — fetch ONCE when we first see a status where they exist.
        // Subsequent updates flow through user edits / refine and don't need
        // polling.
        if (
          !segmentsLoadedRef.current &&
          (j.status === "EDITING" ||
            j.status === "DONE" ||
            j.status === "FAILED")
        ) {
          const segs = await getSegments(id);
          if (!cancelled) {
            setSegments(segs);
            segmentsLoadedRef.current = true;
          }
        }

        if (j.status === "DONE") {
          if (!downloadsLoadedRef.current) {
            const [dl, pv] = await Promise.all([
              getDownloadUrls(id),
              getPreviewUrls(id),
            ]);
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

        // Surface the input video for preview as soon as it's available,
        // without re-fetching every poll cycle.
        if (
          !previewsLoadedRef.current &&
          (j.status === "EDITING" ||
            j.status === "TRANSCRIBING" ||
            j.status === "TRANSLATING")
        ) {
          getPreviewUrls(id)
            .then((pv) => {
              if (cancelled) return;
              setPreviews((prev) => ({ ...prev, ...pv }));
              if (pv.input) previewsLoadedRef.current = true;
            })
            .catch(() => void 0);
        }

        if (!cancelled) timer = setTimeout(poll, intervalForStatus(j.status));
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

  // Wire the preview video's playback time to the segment list so the
  // overlay text mirrors what would actually appear at that moment.
  useEffect(() => {
    const video = previewVideoRef.current;
    if (!video || segments.length === 0) return;
    const onTimeUpdate = () => {
      const t = video.currentTime;
      const active = segments.find((s) => t >= s.startSec && t < s.endSec);
      setPreviewActiveSeg(active ?? null);
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);
  }, [segments]);

  /** Update local state on every keystroke so the textarea stays in sync
   *  with state changes (e.g. refine writes new values into segments). */
  const onSegmentLocalEdit = (segId: string, text: string) => {
    setSegments((prev) =>
      prev.map((s) =>
        s.id === segId ? { ...s, translatedText: text, edited: true } : s,
      ),
    );
  };

  /** Persist to the backend when the textarea loses focus. */
  const onSegmentBlur = async (segId: string, text: string) => {
    try {
      await updateSegment(segId, text);
    } catch (err) {
      console.error("Save failed:", err);
    }
  };

  const onPresetChange = (id: string) => {
    setRefinePresetId(id);
    const preset = REFINE_PRESETS.find((p) => p.id === id);
    if (preset) setRefinePrompt(preset.prompt);
  };

  const onRefine = async () => {
    const prompt = refinePrompt.trim();
    if (prompt.length < 3) {
      setRefineError("Заавар хэт богино байна — дор хаяж 3 тэмдэгт оруулна уу.");
      return;
    }
    setRefineError("");
    setRefining(true);
    // Snapshot current translations so the UI can render before/after.
    const snapshot: Record<string, string> = {};
    for (const s of segments) {
      snapshot[s.id] = s.translatedText ?? "";
    }
    try {
      const updated = await refineTranslations(id, prompt);
      setPreviousTranslations(snapshot);
      setSegments(updated);
    } catch (err) {
      setRefineError(
        err instanceof Error ? err.message : "Сайжруулахад алдаа гарлаа",
      );
    } finally {
      setRefining(false);
    }
  };

  /** Revert a single segment to its pre-refine translation. */
  const onUndoRefine = async (segId: string) => {
    const prev = previousTranslations[segId];
    if (prev === undefined) return;
    // Optimistic local update first so the UI snaps back instantly.
    setSegments((cur) =>
      cur.map((s) =>
        s.id === segId ? { ...s, translatedText: prev, edited: true } : s,
      ),
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

  /** Discard all pre-refine snapshots — the user is happy with the rewrite. */
  const onAcceptRefine = () => setPreviousTranslations({});

  const onRender = async () => {
    setBusy(true);
    try {
      await startRender(id, {
        outputMode,
        subtitleText,
        subtitleBurn,
        subtitleFontSize,
        subtitleTextColor,
        subtitleBgColor,
        subtitlePosition,
        subtitlePositionPct,
        ...(outputMode === "dub"
          ? { voiceName: voice, ttsProvider, stylePrompt: stylePrompt || undefined }
          : {}),
      });
    } finally {
      setBusy(false);
    }
  };

  // Switching provider resets the voice choice to that provider's default.
  const onTtsProviderChange = (p: "gemini" | "chimege") => {
    setTtsProvider(p);
    setVoice(p === "chimege" ? "FEMALE3v2" : "Kore");
  };

  /** Lazy-fetch a segment's TTS audio URL the first time the user expands it. */
  const loadSegmentAudio = async (segId: string) => {
    if (segmentAudio[segId]) return; // already loaded
    try {
      const url = await getSegmentAudioUrl(segId);
      setSegmentAudio((prev) => ({ ...prev, [segId]: url }));
    } catch {
      // No audio yet (job hasn't been rendered). Mark with empty string so
      // we don't keep retrying on every render.
      setSegmentAudio((prev) => ({ ...prev, [segId]: "" }));
    }
  };

  if (!job) {
    return (
      <main className="shell">
        <p className="muted">Уншиж байна...</p>
      </main>
    );
  }

  const isProcessing =
    job.status !== "DONE" && job.status !== "FAILED" && job.status !== "EDITING";
  const hasVideoInput = !!job.inputKey && !isAudioInputKey(job.inputKey);
  const hasAudioInput = !!job.inputKey && isAudioInputKey(job.inputKey);

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
              <h2 className="card-title" style={{ marginBottom: "0.25rem" }}>
                Job · <span style={{ fontFamily: "ui-monospace" }}>{id.slice(0, 8)}</span>
              </h2>
              <p className="muted" style={{ margin: 0 }}>
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
            <div
              className={`step ${
                job.status === "DONE" ? "done" : job.status === "FAILED" ? "" : ""
              }`}
            >
              <div className="step-dot" />
              <span>Бэлэн</span>
            </div>
          </div>

          {isProcessing && (
            <div className="progress indeterminate" style={{ marginTop: "1rem" }}>
              <div />
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

        {job.status === "EDITING" && hasVideoInput && previews.input && (
          <section className="card">
            <h2 className="card-title">Эх видео</h2>
            <p className="card-subtitle">
              Орчуулгыг засах зуураа дэлгэц дээр харж сонсож болно
              {subtitleBurn && " · видеог тоглуулахад хадмалын харагдац шинэчлэгдэнэ"}
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
                style={{
                  width: "100%",
                  display: "block",
                  maxHeight: 500,
                }}
              />
              {subtitleBurn && (
                <SubtitlePreviewOverlay
                  activeSegment={previewActiveSeg}
                  subtitleText={subtitleText}
                  fontSize={subtitleFontSize}
                  textColor={subtitleTextColor}
                  bgColor={subtitleBgColor}
                  positionPct={subtitlePositionPct}
                  onPositionChange={setSubtitlePositionPct}
                />
              )}
            </div>
          </section>
        )}

        {job.status === "EDITING" && hasAudioInput && previews.input && (
          <section className="card">
            <h2 className="card-title">Эх аудио</h2>
            <p className="card-subtitle">
              MP3-аас хийсэн транскрипц ба орчуулгыг засах зуураа аудиогоо шууд сонсож болно
            </p>
            <audio
              src={previews.input}
              controls
              preload="metadata"
              style={{ width: "100%" }}
            />
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
                  📥 SRT-г одоо татаж авах (видеог mux хийхгүй):
                </span>
                <a
                  href={jobSrtDownloadUrl(id, "translated")}
                  download
                  className="btn btn-secondary"
                  style={{
                    padding: "0.35rem 0.7rem",
                    fontSize: "0.78rem",
                    fontWeight: 500,
                  }}
                >
                  🇲🇳 Монгол
                </a>
                <a
                  href={jobSrtDownloadUrl(id, "source")}
                  download
                  className="btn btn-secondary"
                  style={{
                    padding: "0.35rem 0.7rem",
                    fontSize: "0.78rem",
                    fontWeight: 500,
                  }}
                >
                  🌐 Эх хэл
                </a>
                <a
                  href={jobSrtDownloadUrl(id, "both")}
                  download
                  className="btn btn-secondary"
                  style={{
                    padding: "0.35rem 0.7rem",
                    fontSize: "0.78rem",
                    fontWeight: 500,
                  }}
                >
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
                    ✨ <strong>{Object.keys(previousTranslations).length}</strong>{" "}
                    мөр шинэчлэгдсэн. Доорх "Өмнө:" мөрийг харьцуулж шалгана уу.
                  </span>
                  <button
                    type="button"
                    onClick={onAcceptRefine}
                    style={{
                      padding: "0.35rem 0.75rem",
                      fontSize: "0.8rem",
                      fontWeight: 600,
                      border: "1px solid rgba(124, 92, 255, 0.6)",
                      borderRadius: 6,
                      background: "rgba(124, 92, 255, 0.2)",
                      color: "var(--text)",
                      cursor: "pointer",
                      boxShadow: "none",
                      whiteSpace: "nowrap",
                    }}
                  >
                    ✓ Бүгдийг хүлээн авах
                  </button>
                </div>
              )}

              <div className="segments">
                {segments.map((s) => {
                  const audioUrl = segmentAudio[s.id];
                  const prev = previousTranslations[s.id];
                  const showDiff =
                    prev !== undefined && prev !== (s.translatedText ?? "");
                  return (
                    <div key={s.id} className="segment-row">
                      <div className="segment-time">
                        {formatTime(s.startSec)}
                        <br />→ {formatTime(s.endSec)}
                        {s.audioKey && (
                          <button
                            type="button"
                            onClick={() => loadSegmentAudio(s.id)}
                            style={{
                              marginTop: "0.4rem",
                              padding: "0.25rem 0.5rem",
                              fontSize: "0.7rem",
                              fontWeight: 500,
                              border: "1px solid var(--border)",
                              borderRadius: 6,
                              background: "rgba(255,255,255,0.05)",
                              color: "var(--text-muted)",
                              cursor: "pointer",
                              boxShadow: "none",
                            }}
                            title="TTS-ийг сонсох"
                          >
                            {audioUrl ? "🔊" : "🎧"}
                          </button>
                        )}
                      </div>
                      <div className="segment-source">{s.sourceText}</div>
                      <div className="segment-translated">
                        <textarea
                          value={s.translatedText ?? ""}
                          onChange={(e) =>
                            onSegmentLocalEdit(s.id, e.target.value)
                          }
                          onBlur={(e) => onSegmentBlur(s.id, e.target.value)}
                        />
                        {showDiff && (
                          <div
                            style={{
                              display: "flex",
                              alignItems: "flex-start",
                              gap: "0.4rem",
                              marginTop: "0.4rem",
                              padding: "0.4rem 0.55rem",
                              background: "rgba(255,255,255,0.03)",
                              borderLeft: "2px solid rgba(124, 92, 255, 0.5)",
                              borderRadius: 4,
                              fontSize: "0.78rem",
                              color: "var(--text-muted)",
                              lineHeight: 1.4,
                            }}
                          >
                            <span
                              style={{
                                fontWeight: 600,
                                color: "rgba(124, 92, 255, 0.9)",
                                flexShrink: 0,
                              }}
                            >
                              Өмнө:
                            </span>
                            <span
                              style={{
                                flex: 1,
                                textDecoration: "line-through",
                                textDecorationColor: "rgba(255,255,255,0.25)",
                              }}
                            >
                              {prev || "(хоосон)"}
                            </span>
                            <button
                              type="button"
                              onClick={() => onUndoRefine(s.id)}
                              title="Энэ мөрийг өмнөх руу буцаах"
                              style={{
                                padding: "0.1rem 0.4rem",
                                fontSize: "0.75rem",
                                border: "1px solid var(--border)",
                                borderRadius: 4,
                                background: "transparent",
                                color: "var(--text-muted)",
                                cursor: "pointer",
                                boxShadow: "none",
                                flexShrink: 0,
                              }}
                            >
                              ↶ Буцаах
                            </button>
                          </div>
                        )}
                        {audioUrl && (
                          <audio
                            src={audioUrl}
                            controls
                            preload="metadata"
                            style={{
                              width: "100%",
                              marginTop: "0.4rem",
                              height: 32,
                            }}
                          />
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
                Контентийн төрлийг сонгоход AI үг хэллэг, аяс, өгүүлбэрийн
                бүтцийг тухайн жанрд тохируулан дахин боловсруулна
              </p>

              <label>
                <span>Контентийн төрөл</span>
                <select
                  value={refinePresetId}
                  onChange={(e) => onPresetChange(e.target.value)}
                  disabled={refining}
                >
                  {REFINE_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>Заавар (засаж болно)</span>
                <textarea
                  value={refinePrompt}
                  onChange={(e) => {
                    setRefinePrompt(e.target.value);
                    // User started editing → switch the dropdown to "custom"
                    // so the next preset click doesn't silently overwrite.
                    if (refinePresetId !== "custom") {
                      const current = REFINE_PRESETS.find(
                        (p) => p.id === refinePresetId,
                      );
                      if (current && current.prompt !== e.target.value) {
                        setRefinePresetId("custom");
                      }
                    }
                  }}
                  disabled={refining}
                  rows={5}
                  placeholder="Жишээ нь: Орчуулгыг илүү хөгжилтэй, инээдэмтэй болгож зас..."
                  style={{
                    width: "100%",
                    resize: "vertical",
                    fontFamily: "inherit",
                  }}
                />
              </label>

              <button
                type="button"
                className="btn"
                onClick={onRefine}
                disabled={refining || refinePrompt.trim().length < 3}
                style={{ width: "100%" }}
              >
                {refining
                  ? "✨ Сайжруулж байна..."
                  : "✨ Орчуулга сайжруулах"}
              </button>

              {refineError && (
                <p className="error-text" style={{ marginTop: "0.75rem" }}>
                  ❌ {refineError}
                </p>
              )}
            </section>

            {hasVideoInput && (
            <section className="card">
              <h2 className="card-title">Гаргалтын тохиргоо</h2>
              <p className="card-subtitle">
                Монгол дуугаар дубляж хийх эсвэл зөвхөн хадмал гаргах
              </p>

              <label>
                <span>Гаргах төрөл</span>
                <select
                  value={outputMode}
                  onChange={(e) => setOutputMode(e.target.value as OutputMode)}
                >
                  <option value="dub">
                    🎬 Дубляж — монгол дуу (хадмал нэмж болно)
                  </option>
                  <option value="subtitle">
                    📄 Зөвхөн хадмал — эх дуу хэвээр, TTS-гүй
                  </option>
                </select>
              </label>

              {outputMode === "dub" && (
                <>
                  <label>
                    <span>TTS engine</span>
                    <select
                      value={ttsProvider}
                      onChange={(e) =>
                        onTtsProviderChange(e.target.value as "gemini" | "chimege")
                      }
                    >
                      <option value="chimege">
                        Chimege (mongol-native, чанартай) ⭐
                      </option>
                      <option value="gemini">Gemini 3.1 Flash TTS</option>
                    </select>
                  </label>

                  <label>
                    <span>Хоолой</span>
                    <select value={voice} onChange={(e) => setVoice(e.target.value)}>
                      {(ttsProvider === "chimege" ? CHIMEGE_VOICES : GEMINI_VOICES).map(
                        (v) => (
                          <option key={v.value} value={v.value}>
                            {v.label}
                          </option>
                        ),
                      )}
                    </select>
                  </label>

                  {ttsProvider === "gemini" && (
                    <label>
                      <span>Style instructions (optional)</span>
                      <input
                        type="text"
                        value={stylePrompt}
                        onChange={(e) => setStylePrompt(e.target.value)}
                        placeholder="Read warmly like a storyteller"
                      />
                    </label>
                  )}
                </>
              )}

              <label>
                <span>Хадмалын текст</span>
                <select
                  value={subtitleText}
                  onChange={(e) => setSubtitleText(e.target.value as SubtitleText)}
                >
                  <option value="translated">Монгол орчуулга</option>
                  <option value="source">Эх хэл (хятад)</option>
                  <option value="both">Хос (хятад + монгол)</option>
                </select>
              </label>

              <label>
                <span>Хадмалыг хаана гаргах</span>
                <select
                  value={subtitleBurn ? "burn" : "file"}
                  onChange={(e) => setSubtitleBurn(e.target.value === "burn")}
                >
                  <option value="burn">
                    🔥 Видеон дээр шатаах — хадмал видеотойгоо нэг файл болж харагдана (+SRT)
                  </option>
                  <option value="file">
                    📄 Зөвхөн SRT файл — видеон дээр харагдахгүй, тусдаа татна
                  </option>
                </select>
              </label>
              {!subtitleBurn && (
                <p
                  className="card-subtitle"
                  style={{
                    marginTop: "-0.25rem",
                    marginBottom: "0.5rem",
                    padding: "0.5rem 0.75rem",
                    background: "rgba(255, 200, 0, 0.08)",
                    border: "1px solid rgba(255, 200, 0, 0.3)",
                    borderRadius: 4,
                    fontSize: "0.78rem",
                  }}
                >
                  ⚠️ Анхааруулга: эцсийн видео дээр хадмал{" "}
                  <strong>харагдахгүй</strong>. Зөвхөн SRT файлыг тусдаа татаж
                  VLC/Premiere/YouTube-д оруулж ашиглана.
                </p>
              )}

              {subtitleBurn && (
                <>
                  <p
                    className="card-subtitle"
                    style={{ marginTop: "0.25rem", marginBottom: "0.25rem" }}
                  >
                    Хадмалын харагдац — дээрх видеогоо тоглуулж жинхэнэ
                    харагдацыг шалгана уу
                  </p>

                  <label>
                    <span>Үсгийн хэмжээ ({subtitleFontSize}px)</span>
                    <input
                      type="range"
                      min={12}
                      max={48}
                      step={1}
                      value={subtitleFontSize}
                      onChange={(e) =>
                        setSubtitleFontSize(Number(e.target.value))
                      }
                      style={{ width: "100%" }}
                    />
                  </label>

                  <label>
                    <span>Үсгийн өнгө</span>
                    <div
                      style={{
                        display: "flex",
                        gap: "0.5rem",
                        alignItems: "center",
                      }}
                    >
                      <input
                        type="color"
                        value={subtitleTextColor}
                        onChange={(e) => setSubtitleTextColor(e.target.value)}
                        style={{
                          width: 48,
                          height: 36,
                          padding: 0,
                          border: "1px solid var(--border)",
                          borderRadius: 6,
                          background: "transparent",
                          cursor: "pointer",
                        }}
                      />
                      <code
                        style={{
                          fontSize: "0.85rem",
                          color: "var(--text-muted)",
                        }}
                      >
                        {subtitleTextColor.toUpperCase()}
                      </code>
                    </div>
                  </label>

                  <label>
                    <span>Дэвсгэрийн өнгө</span>
                    <div
                      style={{
                        display: "flex",
                        gap: "0.5rem",
                        alignItems: "center",
                      }}
                    >
                      <label
                        style={{
                          display: "flex",
                          gap: "0.35rem",
                          alignItems: "center",
                          fontSize: "0.85rem",
                          color: "var(--text-muted)",
                          marginBottom: 0,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={subtitleBgColor !== null}
                          onChange={(e) =>
                            setSubtitleBgColor(
                              e.target.checked ? "#000000" : null,
                            )
                          }
                        />
                        Дэвсгэртэй
                      </label>
                      <input
                        type="color"
                        value={subtitleBgColor ?? "#000000"}
                        onChange={(e) => setSubtitleBgColor(e.target.value)}
                        disabled={subtitleBgColor === null}
                        style={{
                          width: 48,
                          height: 36,
                          padding: 0,
                          border: "1px solid var(--border)",
                          borderRadius: 6,
                          background: "transparent",
                          cursor:
                            subtitleBgColor === null ? "not-allowed" : "pointer",
                          opacity: subtitleBgColor === null ? 0.4 : 1,
                        }}
                      />
                      <code
                        style={{
                          fontSize: "0.85rem",
                          color: "var(--text-muted)",
                        }}
                      >
                        {subtitleBgColor
                          ? subtitleBgColor.toUpperCase()
                          : "(өнгөгүй, зөвхөн контур)"}
                      </code>
                    </div>
                  </label>

                  <label>
                    <span>
                      Босоо байрлал ({subtitlePositionPct}% — дээр 0 ↔ 100 доор)
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={subtitlePositionPct}
                      onChange={(e) =>
                        setSubtitlePositionPct(Number(e.target.value))
                      }
                      style={{ width: "100%" }}
                    />
                    <span
                      className="muted"
                      style={{
                        display: "block",
                        fontSize: "0.75rem",
                        marginTop: "0.25rem",
                      }}
                    >
                      Preview видеон дээрх хадмалыг хулганаар дээш доош зөөж
                      ч болно.
                    </span>
                  </label>
                </>
              )}

              <button
                type="button"
                className="btn btn-large"
                onClick={onRender}
                disabled={busy}
                style={{ width: "100%" }}
              >
                {busy
                  ? "..."
                  : outputMode === "dub"
                    ? "🎬 Видеог үүсгэх"
                    : subtitleBurn
                      ? "📄 Хадмалтай видео гаргах"
                      : "📄 Хадмал (SRT) гаргах"}
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
              <video
                src={previews.output}
                controls
                preload="metadata"
                playsInline
                style={{
                  width: "100%",
                  borderRadius: "var(--radius-sm)",
                  background: "#000",
                  marginBottom: "1rem",
                  maxHeight: 600,
                }}
              />
            )}

            <div className="row" style={{ marginTop: "0.75rem" }}>
              {downloads.output && (
                <a href={downloads.output} download className="btn">
                  ⬇️ Видео
                </a>
              )}
              {downloads.subtitle && (
                <a href={downloads.subtitle} download className="btn btn-secondary">
                  ⬇️ Subtitle (srt)
                </a>
              )}
            </div>
          </section>
        )}
      </main>
    </>
  );
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1);
  return `${m}:${s.padStart(4, "0")}`;
}

function isAudioInputKey(inputKey: string): boolean {
  const lower = inputKey.toLowerCase();
  return (
    lower.endsWith(".mp3") ||
    lower.endsWith(".wav") ||
    lower.endsWith(".m4a") ||
    lower.endsWith(".ogg")
  );
}

/**
 * Live overlay on top of the input video that mirrors how the burned-in
 * subtitle will look. Text comes from whatever segment is active at the
 * current playback time; if none, a static sample is shown so the user can
 * still see styling changes when the video is paused.
 *
 * The overlay is draggable vertically — mouse-down + drag updates
 * `positionPct` (0-100% from top of video) so the user can position the
 * subtitle by feel rather than only via the slider.
 */
function SubtitlePreviewOverlay({
  activeSegment,
  subtitleText,
  fontSize,
  textColor,
  bgColor,
  positionPct,
  onPositionChange,
}: {
  activeSegment: Segment | null;
  subtitleText: SubtitleText;
  fontSize: number;
  textColor: string;
  bgColor: string | null;
  positionPct: number;
  onPositionChange: (pct: number) => void;
}) {
  const fallbackSource = "示例字幕";
  const fallbackTranslated = "Энэ бол жишээ хадмал";
  const source = activeSegment?.sourceText?.trim() || fallbackSource;
  const translated =
    activeSegment?.translatedText?.trim() || fallbackTranslated;

  const lines: string[] =
    subtitleText === "source"
      ? [source]
      : subtitleText === "both"
        ? [source, translated]
        : [translated];

  // No-background mode → simulate libass outline via multi-direction text-shadow.
  const outlineShadow =
    "1px 1px 2px rgba(0,0,0,0.95), -1px 1px 2px rgba(0,0,0,0.95), " +
    "1px -1px 2px rgba(0,0,0,0.95), -1px -1px 2px rgba(0,0,0,0.95), " +
    "0 0 4px rgba(0,0,0,0.6)";

  const [dragging, setDragging] = useState(false);

  // Convert a clientY position (during drag) to a 0-100 percentage relative
  // to the parent video container. We pull the parent from the event target's
  // ancestor — works regardless of video size / window scroll.
  const updateFromEvent = (
    clientY: number,
    container: HTMLElement | null,
  ) => {
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.height === 0) return;
    const raw = ((clientY - rect.top) / rect.height) * 100;
    const clamped = Math.max(0, Math.min(100, Math.round(raw)));
    onPositionChange(clamped);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(true);
    const container = e.currentTarget.parentElement;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    updateFromEvent(e.clientY, container);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    updateFromEvent(e.clientY, e.currentTarget.parentElement);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    setDragging(false);
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: `${positionPct}%`,
        transform: "translateY(-50%)",
        textAlign: "center",
        padding: "0 4%",
        cursor: dragging ? "grabbing" : "grab",
        userSelect: "none",
        touchAction: "none",
        // While not dragging, allow clicks to pass through to the video so
        // play/pause works as usual. Drag flips to grab and captures pointer.
        pointerEvents: "auto",
      }}
      title="Хулганаар дээш доош чирж зөөнө үү"
    >
      <span
        style={{
          display: "inline-block",
          color: textColor,
          fontSize: `${fontSize}px`,
          lineHeight: 1.25,
          fontWeight: 600,
          letterSpacing: "0.01em",
          backgroundColor: bgColor ?? "transparent",
          padding: bgColor ? "4px 12px" : 0,
          borderRadius: bgColor ? 4 : 0,
          textShadow: bgColor ? "none" : outlineShadow,
          whiteSpace: "pre-line",
          maxWidth: "92%",
          outline: dragging
            ? "1px dashed rgba(124, 92, 255, 0.6)"
            : "none",
          outlineOffset: 4,
        }}
      >
        {lines.join("\n")}
      </span>
    </div>
  );
}
