import ffmpeg from "fluent-ffmpeg";
import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

/** Path under /tmp guaranteed to be unique for this job. */
export function tmpPath(extension: string): string {
  return join(tmpdir(), `dubme-${randomUUID()}.${extension}`);
}

/* ─── Bundled subtitle fonts ─────────────────────────────────────────────
 * We ship the fonts so burned subtitles render identically on dev (macOS) and
 * prod (Linux) AND match the in-browser preview exactly — instead of letting
 * libass/fontconfig pick whatever the host happens to have (the old code
 * omitted FontName, which rendered as Arial/Hiragino/DejaVu depending on OS,
 * and produced TOFU boxes for Chinese where no CJK font was installed).
 *
 * libass only uses fontsdir fonts for EXPLICIT family-name matches (never for
 * missing-glyph fallback), so we name the font in the .ass Style and, for the
 * Chinese line, inline-override to the bundled CJK font.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
function resolveFontsDir(): string {
  // Works for both `tsx src/ffmpeg.ts` (dev) and compiled `dist/ffmpeg.js`
  // (prod) since src/ and dist/ both sit one level under the backend root.
  const candidates = [
    join(HERE, "..", "assets", "fonts"),
    join(HERE, "..", "..", "assets", "fonts"),
    join(process.cwd(), "assets", "fonts"),
    join(process.cwd(), "dubme-backend", "assets", "fonts"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0];
}
export const FONTS_DIR = resolveFontsDir();

export interface SubtitleFontOption {
  value: string; // ASS FontName (must match the font's family name)
  label: string;
  file: string;
}

/** Text fonts (Mongolian Cyrillic incl. Ө/Ү + Latin). Verified glyph coverage. */
export const SUBTITLE_FONTS: SubtitleFontOption[] = [
  { value: "Noto Sans", label: "Noto Sans (default)", file: "NotoSans-Regular.ttf" },
  { value: "PT Sans", label: "PT Sans (кирилл уран)", file: "PTSans-Regular.ttf" },
  { value: "Noto Serif", label: "Noto Serif (нэрэт)", file: "NotoSerif-Regular.ttf" },
];
/** CJK companion used for the Chinese line in "source"/"both" modes. */
export const CJK_FONT_NAME = "Noto Sans SC";

const VALID_FONT_NAMES = new Set([
  ...SUBTITLE_FONTS.map((f) => f.value),
  CJK_FONT_NAME,
]);

/**
 * Whether this ffmpeg build links libass (provides the `ass`/`subtitles`
 * filters needed to burn hardsubs). Cached after the first probe.
 */
let libassAvailable: boolean | null = null;
export async function hasLibass(): Promise<boolean> {
  if (libassAvailable !== null) return libassAvailable;
  libassAvailable = await new Promise<boolean>((resolve) => {
    const proc = spawn("ffmpeg", ["-hide_banner", "-filters"]);
    let out = "";
    proc.stdout.on("data", (c) => (out += c.toString()));
    proc.on("error", () => resolve(false));
    proc.on("close", () => resolve(/^\s*\S+\s+ass\s/m.test(out) || /\bsubtitles\b/.test(out)));
  });
  return libassAvailable;
}

/* ─── Hardware-encoder detection ─────────────────────────────────────────
 * On macOS, h264_videotoolbox offloads encoding to the GPU/media engine: on
 * Apple Silicon it's roughly wall-clock parity with x264 veryfast but frees
 * ~4 CPU cores (lets several renders run at once). Quality-per-bit is a bit
 * worse than x264, so we keep x264 the default and only use VT when the
 * operator opts in via DUBME_HW_ENCODE=1. On Linux you'd extend this to
 * h264_nvenc / h264_qsv when present.
 */
export interface VideoEncoder {
  name: string;
  /** args for the output video codec, given the OUTPUT pixel height. */
  args(outHeight: number): string[];
}

let cachedEncoder: VideoEncoder | null = null;
async function listEncoders(): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", ["-hide_banner", "-encoders"]);
    let out = "";
    proc.stdout.on("data", (c) => (out += c.toString()));
    proc.on("error", () => resolve(""));
    proc.on("close", () => resolve(out));
  });
}

const X264_ENCODER: VideoEncoder = {
  name: "libx264",
  args: () => ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"],
};

export async function pickVideoEncoder(): Promise<VideoEncoder> {
  if (cachedEncoder) return cachedEncoder;
  if (process.env.DUBME_HW_ENCODE !== "1") {
    cachedEncoder = X264_ENCODER;
    return cachedEncoder;
  }
  const encoders = await listEncoders();
  if (process.platform === "darwin" && /h264_videotoolbox/.test(encoders)) {
    cachedEncoder = {
      name: "h264_videotoolbox",
      args: (h) => {
        // VideoToolbox has no CRF; pick a target bitrate by output height.
        const bitrate = h >= 2160 ? "16M" : h >= 1440 ? "10M" : h >= 1080 ? "6M" : h >= 720 ? "3M" : "1500k";
        return ["-c:v", "h264_videotoolbox", "-b:v", bitrate, "-allow_sw", "1"];
      },
    };
  } else {
    cachedEncoder = X264_ENCODER;
  }
  console.log(`[ffmpeg] video encoder = ${cachedEncoder.name}`);
  return cachedEncoder;
}

/** Run a one-off ffmpeg command and resolve when it exits cleanly. */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`)),
    );
  });
}

/**
 * Extract a 16kHz mono WAV from a video file. Kept for completeness, but the
 * render path no longer calls it — mixSegmentsToTimeline reads the video
 * directly (its filter chain resamples to 24kHz anyway), so a dedicated
 * extraction pass + temp WAV is pure waste.
 */
export function extractAudio(videoPath: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .audioFrequency(16_000)
      .audioChannels(1)
      .audioCodec("pcm_s16le")
      .format("wav")
      .on("end", () => resolve())
      .on("error", reject)
      .save(outPath);
  });
}

/**
 * Extract a quality-tuned mono Opus track from a video — meant for sending to
 * speech-to-text. 48 kbps Opus VoIP is the sweet spot for Whisper: virtually
 * indistinguishable from lossless for transcription accuracy yet tiny. A
 * 2-hour video lands around ~43 MB, which our chunking splits into pieces
 * under Groq's 25 MB per-call cap.
 */
export function extractAudioCompressed(
  videoPath: string,
  outPath: string,
): Promise<void> {
  return runFfmpeg([
    "-y",
    "-i", videoPath,
    "-vn",          // discard video stream
    "-ac", "1",     // mono
    "-c:a", "libopus",
    "-b:a", "48k",  // smaller files → fewer STT chunks; no accuracy loss for speech
    "-application", "voip", // Opus mode tuned for speech, better intelligibility
    "-f", "ogg",
    outPath,
  ]);
}

/**
 * Cut [startSec, startSec+durationSec) from an audio file using stream-copy
 * (no re-encode — fast, lossless). Used for chunked STT on long videos.
 */
export function sliceAudio(
  inputPath: string,
  startSec: number,
  durationSec: number,
  outPath: string,
): Promise<void> {
  return runFfmpeg([
    "-y",
    "-ss", startSec.toString(),
    "-t", durationSec.toString(),
    "-i", inputPath,
    "-c", "copy",
    outPath,
  ]);
}

/** Get duration of a media file (seconds). */
export function probeDuration(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(path, (err, data) => {
      if (err) return reject(err);
      const duration = data.format.duration ?? 0;
      resolve(duration);
    });
  });
}

export interface VideoMeta {
  width: number;
  height: number;
  durationSec: number;
}

/**
 * One ffprobe that returns width, height AND duration of the source video, so
 * the render path can probe once and thread the numbers through instead of
 * spawning a separate ffprobe per use. Falls back to 1920x1080 if no video
 * stream is found (defensive — shouldn't happen for real input).
 */
export function probeVideoMeta(path: string): Promise<VideoMeta> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(path, (err, data) => {
      if (err) return reject(err);
      const v = data.streams.find((s) => s.codec_type === "video");
      const width = typeof v?.width === "number" && v.width > 0 ? v.width : 1920;
      const height = typeof v?.height === "number" && v.height > 0 ? v.height : 1080;
      resolve({ width, height, durationSec: data.format.duration ?? 0 });
    });
  });
}

/**
 * Trim leading silence from a TTS clip and write the cleaned version to a new
 * file. Returns the new path AND its true duration so downstream timing math
 * uses the real playable length, not the noisy Gemini-output duration.
 */
async function trimClipSilence(
  inputPath: string,
): Promise<{ path: string; duration: number }> {
  const outPath = tmpPath("wav");
  // Trim ONLY leading silence — Gemini occasionally inserts ~100-300ms of
  // breath before the actual speech, which would shift the dub later than the
  // on-screen speaker. We deliberately do NOT trim trailing silence (it would
  // also cut a sentence off at the first internal pause).
  await runFfmpeg([
    "-y",
    "-i", inputPath,
    "-af",
    "silenceremove=start_periods=1:start_duration=0.05:start_threshold=-35dB",
    "-ar", "24000",
    "-ac", "1",
    "-c:a", "pcm_s16le",
    outPath,
  ]);
  return { path: outPath, duration: await probeDuration(outPath) };
}

export interface SegmentClip {
  startSec: number;
  endSec: number;
  audioPath: string; // local path to the segment's WAV
}

export interface MixOptions {
  /**
   * Path to the ORIGINAL media (the source video itself works — `[0:a]`
   * selects its audio from any container). When provided, the original is
   * mixed under the dubbed track and ducked while a Mongolian segment plays.
   */
  originalAudioPath?: string;
  /** Linear gain for original audio while a dub segment is speaking (0–1). */
  duckLevel?: number;
  /** Bound on simultaneous silence-trim ffmpeg processes (default ~CPU count). */
  trimConcurrency?: number;
}

/**
 * Run `tasks` with a bounded number in flight, preserving input→output order.
 * A tiny inline worker pool — the project has no p-limit dependency.
 */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(concurrency, items.length)))
    .fill(0)
    .map(async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) break;
        results[i] = await fn(items[i], i);
      }
    });
  await Promise.all(workers);
  return results;
}

/**
 * Build a single audio track placing each segment's TTS audio on the timeline,
 * ducking the original under the dub. (Unchanged algorithm; the only change vs
 * before is bounded trim concurrency so a long video doesn't fork hundreds of
 * ffmpeg processes at once.)
 */
export async function mixSegmentsToTimeline(
  clips: SegmentClip[],
  totalDurationSec: number,
  outPath: string,
  options: MixOptions = {},
): Promise<void> {
  if (clips.length === 0) {
    throw new Error("No clips to mix");
  }

  // ── 1. Trim silence from every clip, bounded concurrency. ─────────────
  const cpu = (await import("node:os")).cpus().length || 4;
  const trimConc = options.trimConcurrency ?? Math.min(8, Math.max(2, cpu));
  const trimmed = await mapPool(clips, trimConc, (c) => trimClipSilence(c.audioPath));
  const cleanupPaths = trimmed.map((t) => t.path);

  try {
    const SPEED_CAP = 2.0;
    const MIN_GAP = 0.05;

    interface Placement {
      start: number;
      speed: number;
      playLen: number;
      end: number;
      sourceStart: number;
    }

    const placements: Placement[] = [];
    let prevEnd = 0;
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      const trimDur = trimmed[i].duration;
      const sourceStart = c.startSec;
      const sourceNext =
        i + 1 < clips.length ? clips[i + 1].startSec : totalDurationSec;

      const start = Math.max(sourceStart, prevEnd + (i > 0 ? MIN_GAP : 0));
      const slot = Math.max(0.1, sourceNext - start);

      const speed = trimDur <= slot ? 1.0 : Math.min(SPEED_CAP, trimDur / slot);
      const playLen = trimDur / speed;
      const end = start + playLen;

      placements.push({ start, speed, playLen, end, sourceStart });
      prevEnd = end;
    }

    const driftPerSeg = placements.map((p) => p.start - p.sourceStart);
    const maxDrift = Math.max(...driftPerSeg);
    const overflowCount = placements.filter(
      (p, i) => i + 1 < clips.length && p.end > clips[i + 1].startSec + 0.05,
    ).length;

    const useOriginal = !!options.originalAudioPath;
    const duckLevel = options.duckLevel ?? 0.05;
    const PAD_BEFORE = 0.1;
    const PAD_AFTER = 0.1;

    const args: string[] = ["-y"];
    if (useOriginal) {
      args.push("-i", options.originalAudioPath!);
    } else {
      args.push(
        "-f", "lavfi",
        "-t", String(totalDurationSec),
        "-i", "anullsrc=channel_layout=mono:sample_rate=24000",
      );
    }
    for (const t of trimmed) {
      args.push("-i", t.path);
    }

    const filterParts: string[] = [];

    if (useOriginal) {
      const conditions = placements
        .map((p) => {
          const s = Math.max(0, p.start - PAD_BEFORE);
          const e = p.end + PAD_AFTER;
          return `between(t,${s.toFixed(3)},${e.toFixed(3)})`;
        })
        .join("+");
      const volExpr = conditions
        ? `if(${conditions},${duckLevel.toFixed(3)},1.0)`
        : "1.0";
      filterParts.push(
        `[0:a]aresample=24000,aformat=channel_layouts=mono,volume='${volExpr}':eval=frame[base]`,
      );
    } else {
      filterParts.push(`[0:a]anull[base]`);
    }

    const mixInputs: string[] = ["[base]"];
    placements.forEach((p, idx) => {
      const inputIdx = idx + 1;
      const delayMs = Math.round(p.start * 1000);
      const filters: string[] = [];
      if (p.speed > 1.001) filters.push(`atempo=${p.speed.toFixed(3)}`);
      filters.push(`adelay=${delayMs}|${delayMs}`);
      filterParts.push(`[${inputIdx}:a]${filters.join(",")}[s${idx}]`);
      mixInputs.push(`[s${idx}]`);
    });
    filterParts.push(
      `${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=longest:dropout_transition=0:normalize=0[mixraw]`,
    );
    filterParts.push(`[mixraw]dynaudnorm=f=200:g=15:p=0.95[out]`);

    args.push(
      "-filter_complex", filterParts.join(";"),
      "-map", "[out]",
      "-acodec", "pcm_s16le",
      "-ar", "24000",
      "-ac", "1",
      "-f", "wav",
      outPath,
    );

    await runFfmpeg(args);

    const spedUp = placements.filter((p) => p.speed > 1.001).length;
    console.log(
      `[mix] segments=${placements.length} sped_up=${spedUp} ` +
        `max_drift=${maxDrift.toFixed(2)}s overflow_after=${overflowCount} ` +
        (useOriginal ? `duck=${duckLevel}` : "no-original"),
    );
  } finally {
    await Promise.all(
      cleanupPaths.map((p) => unlink(p).catch(() => void 0)),
    );
  }
}

/**
 * Replace the audio track of `videoPath` with `audioPath`, preserving video.
 * Used for the dub-WITHOUT-burn path (video is stream-copied — cheap).
 * +faststart moves the moov atom to the front so the browser <video> starts
 * playing immediately instead of range-requesting the tail.
 */
export function replaceAudioTrack(
  videoPath: string,
  audioPath: string,
  outPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c:v", "copy",
        "-c:a", "aac",
        "-shortest",
        "-movflags", "+faststart",
      ])
      .on("end", () => resolve())
      .on("error", reject)
      .save(outPath);
  });
}

/* ─── Subtitle styling (.ass generation) ─────────────────────────────────
 * We generate a full .ass file with PlayResX/PlayResY = the actual video
 * resolution, so every style value is a TRUE PIXEL on the output frame. This
 * fixes the old SRT+force_style approach, where ffmpeg's implicit 384x288
 * script space silently scaled FontSize/MarginV by videoHeight/288 — putting
 * subtitles in the wrong place (mid-frame at 1080p, off-screen for many
 * positions) and the wrong size. With a real PlayRes the browser preview is
 * computable with one multiply: cssPx = value * displayedHeight / REF_H.
 */

/** Reference height the UI's px values are expressed in (resolution-independent). */
export const SUBTITLE_REF_HEIGHT = 1080;

export interface BurnSubtitleStyle {
  /** ASS FontName for the main (Mongolian/Latin) line. */
  fontFamily: string;
  /** Font size in px at REF_H (1080). Scaled to the real frame automatically. */
  fontSize: number;
  bold: boolean;
  italic: boolean;
  /** Hex "#RRGGBB" — main text colour. */
  textColor: string;
  /** Outline thickness in px at REF_H. */
  outlineWidth: number;
  outlineColor: string;
  /** Outline opacity 0-100 (% opaque). */
  outlineAlpha: number;
  /** Drop-shadow depth in px at REF_H (0 = none). Ignored when a bg box is set. */
  shadowDepth: number;
  shadowColor: string;
  /** Hex "#RRGGBB" background box, or null for outline-only (floating) text. */
  bgColor: string | null;
  /** Background box opacity 0-100 (% opaque). */
  bgOpacity: number;
  align: "left" | "center" | "right";
  /** Left/right margin as a % of frame width. */
  marginHPct: number;
  /** Letter spacing in px at REF_H. */
  letterSpacing: number;
  /**
   * Vertical position 0-100% from the TOP of the frame, measured to the
   * BOTTOM EDGE of the text block (matches ASS Alignment=2 + MarginV). 88 ≈
   * classic lower-third.
   */
  positionPct: number;
  /** Chinese line size as a fraction of the main size (dual-language mode). */
  zhScale: number;
  /** Chinese line colour, or null to reuse textColor. */
  zhColor: string | null;
}

export const DEFAULT_BURN_STYLE: BurnSubtitleStyle = {
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

/** One burn cue. zh = source line, mn = translated line (either may be absent). */
export interface BurnCue {
  startSec: number;
  endSec: number;
  zh?: string;
  mn?: string;
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n));
}

function hexParts(hex: string): [string, string, string] {
  const m = hex.replace(/^#/, "");
  if (!/^[0-9A-Fa-f]{6}$/.test(m)) throw new Error(`Invalid hex colour: ${hex}`);
  return [m.slice(0, 2), m.slice(2, 4), m.slice(4, 6)];
}

/** "#RRGGBB" → ASS "&HAABBGGRR" with alpha as % OPAQUE (00=opaque, FF=clear). */
function assColor(hex: string, alphaPct = 100): string {
  const [r, g, b] = hexParts(hex);
  const a = Math.round(((100 - clampPct(alphaPct)) / 100) * 255)
    .toString(16)
    .padStart(2, "0");
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

/** "#RRGGBB" → ASS "&HBBGGRR" (no alpha — for inline \c overrides). */
function assColorBGR(hex: string): string {
  const [r, g, b] = hexParts(hex);
  return `&H${b}${g}${r}`.toUpperCase();
}

function assTime(seconds: number): string {
  const cs = Math.round(seconds * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

/** Escape user text for an ASS Dialogue field. */
function escapeAss(text: string): string {
  return text
    .replace(/\\/g, "")          // strip stray backslashes (would start overrides)
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\r?\n/g, "\\N");
}

/**
 * Write a full .ass subtitle file with PlayRes = (videoW, videoH), so every
 * style number is a literal output pixel. Handles three text modes via the
 * per-cue zh/mn fields:
 *   • mn only        → main style
 *   • zh only        → main style + inline CJK font
 *   • zh + mn (both) → zh line (CJK font, scaled, optional colour) over mn line
 */
export async function writeAss(
  cues: BurnCue[],
  style: BurnSubtitleStyle,
  videoW: number,
  videoH: number,
  outPath: string,
): Promise<void> {
  const fontName = VALID_FONT_NAMES.has(style.fontFamily)
    ? style.fontFamily
    : "Noto Sans";
  const scale = videoH / SUBTITLE_REF_HEIGHT;
  const fontPx = Math.max(8, Math.round(style.fontSize * scale));
  const outlinePx = +(Math.max(0, style.outlineWidth) * scale).toFixed(2);
  const shadowPx = +(Math.max(0, style.shadowDepth) * scale).toFixed(2);
  const spacing = +(style.letterSpacing * scale).toFixed(2);
  const marginV = Math.round((clampPct(100 - style.positionPct) / 100) * videoH);
  const marginH = Math.round((Math.max(0, style.marginHPct) / 100) * videoW);
  const alignment = style.align === "left" ? 1 : style.align === "right" ? 3 : 2;

  const primary = assColor(style.textColor, 100);
  const secondary = "&H000000FF";

  // Background box (BorderStyle=4 = one box around the whole event, incl. the
  // inter-line gap — cleaner than BS=3's ragged per-line boxes) vs floating
  // outlined text (BorderStyle=1).
  let borderStyle: number;
  let outlineColour: string;
  let backColour: string;
  let outlineForStyle: number;
  let shadowForStyle: number;
  if (style.bgColor) {
    borderStyle = 4;
    outlineColour = assColor(style.outlineColor, style.outlineAlpha);
    backColour = assColor(style.bgColor, style.bgOpacity);
    outlineForStyle = Math.max(0.5, outlinePx); // doubles as box padding under BS4
    shadowForStyle = 0;
  } else {
    borderStyle = 1;
    outlineColour = assColor(style.outlineColor, style.outlineAlpha);
    // Under BorderStyle=1 the shadow colour comes from BackColour.
    backColour = assColor(style.shadowColor, 65);
    outlineForStyle = outlinePx;
    shadowForStyle = shadowPx;
  }

  const bold = style.bold ? -1 : 0;
  const italic = style.italic ? -1 : 0;

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${videoW}`,
    `PlayResY: ${videoH}`,
    "ScaledBorderAndShadow: yes",
    "WrapStyle: 0",
    "YCbCr Matrix: None",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Dub,${fontName},${fontPx},${primary},${secondary},${outlineColour},${backColour},${bold},${italic},0,0,100,100,${spacing},0,${borderStyle},${outlineForStyle},${shadowForStyle},${alignment},${marginH},${marginH},${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const zhFs = Math.max(8, Math.round(fontPx * style.zhScale));
  const zhColOverride =
    style.zhColor && style.zhColor !== style.textColor
      ? `\\c${assColorBGR(style.zhColor)}`
      : "";

  const events: string[] = [];
  for (const c of cues) {
    const zh = c.zh?.trim();
    const mn = c.mn?.trim();
    let text: string;
    if (zh && mn) {
      // Chinese line (CJK font, scaled) on top, Mongolian line below.
      text = `{\\fn${CJK_FONT_NAME}\\fs${zhFs}${zhColOverride}}${escapeAss(zh)}\\N{\\r}${escapeAss(mn)}`;
    } else if (zh) {
      text = `{\\fn${CJK_FONT_NAME}}${escapeAss(zh)}`;
    } else if (mn) {
      text = escapeAss(mn);
    } else {
      continue;
    }
    events.push(
      `Dialogue: 0,${assTime(c.startSec)},${assTime(c.endSec)},Dub,,0,0,0,,${text}`,
    );
  }

  await writeFile(outPath, header.concat(events).join("\n") + "\n", "utf-8");
}

/** Escape a path for use inside an ffmpeg filter argument. */
function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

export interface BurnAssOptions {
  /** When set, this becomes the output audio (re-encoded AAC) — dub path. */
  audioPath?: string;
  /** Cap output to this pixel height (downscale before burning). */
  scaleToHeight?: number;
  /** Actual output pixel height (for HW-encoder bitrate selection). */
  outHeight?: number;
  encoder?: VideoEncoder;
}

/**
 * Burn a generated .ass onto a video in ONE ffmpeg pass.
 *  • dub+burn:    pass `audioPath` (the mixed dub) → muxes it as AAC.
 *  • subtitle-only: omit `audioPath` → keeps & stream-copies the original audio.
 * Scaling (if requested) happens BEFORE the ass filter so libass renders glyphs
 * at the output resolution (the .ass PlayRes must already match that height).
 */
export async function burnAss(
  videoPath: string,
  assPath: string,
  outPath: string,
  opts: BurnAssOptions = {},
): Promise<void> {
  if (!(await hasLibass())) {
    throw new Error(
      "Хадмалыг видеон дээр шатаах боломжгүй — энэ сервер дээрх ffmpeg libass-гүй " +
        "суулгагдсан байна. 'Тусдаа SRT файл' сонголтыг ашиглах эсвэл ffmpeg-г " +
        "libass-тай дахин суулгана уу.",
    );
  }
  const encoder = opts.encoder ?? (await pickVideoEncoder());
  const outHeight = opts.scaleToHeight ?? opts.outHeight ?? SUBTITLE_REF_HEIGHT;

  let vf = `ass='${escapeFilterPath(assPath)}':fontsdir='${escapeFilterPath(FONTS_DIR)}'`;
  if (opts.scaleToHeight) vf = `scale=-2:${opts.scaleToHeight},${vf}`;

  const args = ["-y", "-i", videoPath];
  if (opts.audioPath) args.push("-i", opts.audioPath);
  args.push("-vf", vf);
  if (opts.audioPath) {
    args.push("-map", "0:v:0", "-map", "1:a:0");
  } else {
    args.push("-map", "0:v:0", "-map", "0:a:0?");
  }
  args.push(...encoder.args(outHeight));
  if (opts.audioPath) {
    args.push("-c:a", "aac", "-shortest");
  } else {
    args.push("-c:a", "copy");
  }
  args.push("-movflags", "+faststart", outPath);
  await runFfmpeg(args);
}

/**
 * Generate an SRT subtitle file (the downloadable artifact alongside the
 * dubbed/burned video — SRT stays the portable format).
 */
export async function writeSrt(
  segments: { startSec: number; endSec: number; text: string }[],
  outPath: string,
): Promise<void> {
  const lines: string[] = [];
  segments.forEach((s, idx) => {
    lines.push(String(idx + 1));
    lines.push(`${formatSrtTime(s.startSec)} --> ${formatSrtTime(s.endSec)}`);
    lines.push(s.text);
    lines.push("");
  });
  await writeFile(outPath, lines.join("\n"), "utf-8");
}

export function formatSrtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
  return (
    `${String(h).padStart(2, "0")}:` +
    `${String(m).padStart(2, "0")}:` +
    `${String(s).padStart(2, "0")},` +
    `${String(ms).padStart(3, "0")}`
  );
}
