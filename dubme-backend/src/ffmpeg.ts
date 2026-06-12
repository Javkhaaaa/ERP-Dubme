import ffmpeg from "fluent-ffmpeg";
import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Path under /tmp guaranteed to be unique for this job. */
export function tmpPath(extension: string): string {
  return join(tmpdir(), `dubme-${randomUUID()}.${extension}`);
}

/**
 * Whether this ffmpeg build has the libass-backed `subtitles` filter, needed
 * for burning hardsubs. Cached after the first probe. Homebrew's default
 * ffmpeg is sometimes compiled without libass, so we check rather than assume.
 */
let subtitlesFilterAvailable: boolean | null = null;
export async function hasSubtitlesFilter(): Promise<boolean> {
  if (subtitlesFilterAvailable !== null) return subtitlesFilterAvailable;
  subtitlesFilterAvailable = await new Promise<boolean>((resolve) => {
    const proc = spawn("ffmpeg", ["-hide_banner", "-filters"]);
    let out = "";
    proc.stdout.on("data", (c) => (out += c.toString()));
    proc.on("error", () => resolve(false));
    proc.on("close", () => resolve(/\bsubtitles\b/.test(out)));
  });
  return subtitlesFilterAvailable;
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
 * Extract a 16kHz mono WAV from a video file. Used for the in-pipeline mix
 * step (ducking) where ffmpeg needs uncompressed PCM at a known sample rate.
 * Big: ~32KB/sec → not suitable for sending to Whisper for long videos.
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
 * Extract a quality-tuned mono Opus track from a video — meant for sending
 * to speech-to-text. 64 kbps Opus is the sweet spot for Whisper: virtually
 * indistinguishable from lossless for transcription accuracy yet ~4× smaller
 * than 16kHz PCM WAV. A 2-hour video lands around ~57 MB, which our chunking
 * splits into ≤10-min pieces under Groq's 25 MB per-call cap.
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
    "-b:a", "64k",
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

/**
 * Read the video stream's pixel height. Needed by the burn step to convert a
 * percentage-based vertical position (0-100 from top) into the ASS MarginV
 * pixel value libass actually consumes. Falls back to 1080 if no video
 * stream is found (defensive — shouldn't happen for real input).
 */
export function probeVideoHeight(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(path, (err, data) => {
      if (err) return reject(err);
      const v = data.streams.find((s) => s.codec_type === "video");
      const h = typeof v?.height === "number" ? v.height : 1080;
      resolve(h || 1080);
    });
  });
}

/**
 * Trim leading + trailing silence from a TTS clip and write the cleaned
 * version to a new file. Returns the new path AND its true duration so
 * downstream timing math uses the real playable length, not the noisy
 * Gemini-output duration.
 */
async function trimClipSilence(
  inputPath: string,
): Promise<{ path: string; duration: number }> {
  const outPath = tmpPath("wav");
  // Trim ONLY leading silence — Gemini occasionally inserts ~100-300ms of
  // breath before the actual speech, which would shift the dub later than
  // the on-screen speaker.
  //
  // We deliberately do NOT trim trailing silence: `stop_periods=N` in ffmpeg
  // treats any internal pause longer than `stop_duration` as silence and
  // drops everything after it. For a sentence like "Сайн байна уу. Өнөөдөр…"
  // the 200ms pause after "уу." was being interpreted as the start of
  // trailing silence, so the rest of the sentence got cut. Leaving the tail
  // alone keeps the entire audio intact — a few hundred ms of trailing
  // silence is harmless in the final mix.
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

export interface MixedClipPlacement {
  startSec: number;
  endSec: number;
  sourceStartSec: number;
}

export interface MixOptions {
  /**
   * Path to the original extracted audio (e.g. Chinese speech).
   * When provided, the original is mixed under the dubbed track and ducked
   * to `duckLevel` while a Mongolian segment is playing.
   */
  originalAudioPath?: string;
  /**
   * Linear gain for original audio while a dub segment is speaking (0–1).
   * 0.05 ≈ -26 dB — original effectively silent under the dub.
   * Outside dubbed segments the original plays at full 1.0.
   */
  duckLevel?: number;
}

/**
 * Build a single audio track that places each segment's TTS audio on the
 * timeline. Algorithm in plain words:
 *
 *  1. **Trim each Gemini TTS clip** of leading + trailing silence in a
 *     separate ffmpeg pass. We then `ffprobe` the *trimmed* file so the rest
 *     of the math uses the real spoken length, not the noisy raw length.
 *
 *  2. **Sequential placement** — each Mongolian segment starts at the
 *     greater of:
 *        a. its Whisper-detected source start (synchronizes with on-screen
 *           speaker), and
 *        b. the previous Mongolian segment's actual end + small gap
 *           (prevents Mongolian-on-Mongolian overlap).
 *     When (a) wins, sync is perfect. When (b) wins, we drift later — the
 *     trade-off is unavoidable when the Mongolian translation is too long
 *     for its slot, and prefer no-overlap over perfect sync.
 *
 *  3. **Adaptive speed-up** — to keep (a) winning more often, each clip is
 *     atempo-stretched to fit between its placement.start and the next
 *     clip's source start. Capped at 2.0× (legible upper bound for speech).
 *
 *  4. **Smart ducking via per-frame volume expression** — original audio
 *     drops to `duckLevel` only during actual playback windows of the
 *     Mongolian segments (computed from the placements above), and stays
 *     at 1.0 between segments so music/atmosphere comes through.
 *
 *  5. **Loudness flattening** — `amix` with `normalize=0` keeps original
 *     amplitudes; final `dynaudnorm` evens out per-segment loudness.
 *
 * We use ffmpeg directly via child_process because fluent-ffmpeg's
 * inputFormat() validation rejects `lavfi` on newer ffmpeg builds.
 */
export async function mixSegmentsToTimeline(
  clips: SegmentClip[],
  totalDurationSec: number,
  outPath: string,
  options: MixOptions = {},
): Promise<MixedClipPlacement[]> {
  if (clips.length === 0) {
    throw new Error("No clips to mix");
  }

  // ── 1. Trim silence from every clip in parallel. ─────────────────────
  // We have to await all of these before we can do timing math because
  // accurate placement needs the real (post-trim) duration.
  const trimmed = await Promise.all(clips.map((c) => trimClipSilence(c.audioPath)));
  const cleanupPaths = trimmed.map((t) => t.path);

  try {
    // ── 2+3. Sequential placement with adaptive speed-up. ──────────────
    const SPEED_CAP = 2.0;
    const MIN_GAP = 0.05; // 50ms breath between consecutive Mongolian segments

    interface Placement {
      start: number;     // seconds in final timeline where Mongolian begins
      speed: number;     // atempo multiplier (1.0 = no change)
      playLen: number;   // trimmed duration / speed
      end: number;       // start + playLen
      sourceStart: number; // original Whisper startSec, for ducking
    }

    const placements: Placement[] = [];
    let prevEnd = 0;
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      const trimDur = trimmed[i].duration;
      const sourceStart = c.startSec;
      const sourceNext =
        i + 1 < clips.length ? clips[i + 1].startSec : totalDurationSec;

      // Slot we're allowed to live in: from where we MUST start (no overlap)
      // to where the next source segment begins.
      const start = Math.max(sourceStart, prevEnd + (i > 0 ? MIN_GAP : 0));
      const slot = Math.max(0.1, sourceNext - start);

      const speed = trimDur <= slot ? 1.0 : Math.min(SPEED_CAP, trimDur / slot);
      const playLen = trimDur / speed;
      const end = start + playLen;

      placements.push({ start, speed, playLen, end, sourceStart });
      prevEnd = end;
    }

    // Diagnostics: how much sync we lost and how many still overflow.
    const driftPerSeg = placements.map((p) => p.start - p.sourceStart);
    const maxDrift = Math.max(...driftPerSeg);
    const overflowCount = placements.filter(
      (p, i) =>
        i + 1 < clips.length && p.end > clips[i + 1].startSec + 0.05,
    ).length;

    // ── 4. Build the duck window expression. ────────────────────────────
    // Pad each window slightly: 100ms before (catches Whisper's late start
    // detection of the on-screen speaker) and 100ms after (catches the
    // tail of the dub).
    const useOriginal = !!options.originalAudioPath;
    const duckLevel = options.duckLevel ?? 0.05;
    const PAD_BEFORE = 0.1;
    const PAD_AFTER = 0.1;

    // ── 5. Build the ffmpeg command. ────────────────────────────────────
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
      // The trimmed clip already has silences gone — only atempo + adelay needed.
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
    return placements.map((p) => ({
      startSec: p.start,
      endSec: p.end,
      sourceStartSec: p.sourceStart,
    }));
  } finally {
    // Clean up trimmed files even on error.
    await Promise.all(
      cleanupPaths.map((p) => unlink(p).catch(() => void 0)),
    );
  }
}

/**
 * Replace the audio track of `videoPath` with `audioPath`, preserving video.
 * Outputs to `outPath`. Faster than re-encoding video.
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
        "-map", "0:v:0",   // video from first input
        "-map", "1:a:0",   // audio from second input
        "-c:v", "copy",    // don't re-encode video
        "-c:a", "aac",     // re-encode audio to AAC for mp4 compat
        "-shortest",
      ])
      .on("end", () => resolve())
      .on("error", reject)
      .save(outPath);
  });
}

/**
 * Burn an SRT file onto a video (hardsub) and write to `outPath`.
 *
 * The `subtitles` filter forces a full video re-encode (libx264) — there's no
 * way to overlay rendered text without re-drawing frames. Audio is re-encoded
 * to AAC so the result is always a valid mp4 regardless of the source codec
 * (the input may be a dubbed mp4 OR an untouched .mkv/.mov/.webm).
 *
 * We shell out via spawn (not fluent-ffmpeg) because fluent-ffmpeg mangles the
 * `force_style` quoting in the filter string.
 */
export interface BurnSubtitleStyle {
  /** Font size in pixels — typical range 14-40. */
  fontSize: number;
  /** Hex "#RRGGBB" — text colour. */
  textColor: string;
  /** Hex "#RRGGBB" or null — null draws an outline only (no fill box). */
  bgColor: string | null;
  /**
   * Vertical position as a percentage from the TOP of the frame.
   * 0   = text at top edge, 88 = standard lower-third area, 100 = bottom edge.
   * Converted to ASS MarginV in pixels using the video's actual height.
   */
  positionPct: number;
}

const DEFAULT_BURN_STYLE: BurnSubtitleStyle = {
  fontSize: 22,
  textColor: "#FFFFFF",
  bgColor: null,
  positionPct: 88,
};

/**
 * Convert "#RRGGBB" to an ASS colour literal "&HAABBGGRR".
 * ASS bytes are alpha + reversed RGB; alpha 00 = opaque, FF = transparent.
 */
function hexToAssColor(hex: string, alpha = 0): string {
  const m = hex.match(/^#?([0-9A-Fa-f]{6})$/);
  if (!m) throw new Error(`Invalid hex colour: ${hex}`);
  const r = m[1].slice(0, 2);
  const g = m[1].slice(2, 4);
  const b = m[1].slice(4, 6);
  const aa = alpha.toString(16).padStart(2, "0").toUpperCase();
  return `&H${aa}${b}${g}${r}`.toUpperCase();
}

function buildForceStyle(
  style: BurnSubtitleStyle,
  videoHeight: number,
): string {
  const primary = hexToAssColor(style.textColor, 0);
  const outline = "&H80000000"; // ~50% transparent black outline — always
  const back = style.bgColor
    ? hexToAssColor(style.bgColor, 0x40) // ~75% opaque fill box
    : "&H00000000";
  // BorderStyle=1 outline only, =3 opaque box behind text. Picking 3 only
  // when the user actually chose a background colour keeps the default
  // "floating outlined text" look intact.
  const borderStyle = style.bgColor ? 3 : 1;
  // Bottom-center anchor + MarginV measured from the bottom edge gives us a
  // simple linear mapping from percentage to pixels. Clamp pct into [0,100]
  // so a stray slider value can't push the text off-screen.
  const pct = Math.max(0, Math.min(100, style.positionPct));
  const marginV = Math.round(((100 - pct) / 100) * videoHeight);
  return [
    `FontSize=${style.fontSize}`,
    `PrimaryColour=${primary}`,
    `OutlineColour=${outline}`,
    `BackColour=${back}`,
    `BorderStyle=${borderStyle}`,
    `Outline=2`,
    `Shadow=0`,
    `Alignment=2`, // bottom-center is the most predictable anchor
    `MarginV=${marginV}`,
  ].join(",");
}

export async function burnSubtitles(
  videoPath: string,
  srtPath: string,
  outPath: string,
  style: BurnSubtitleStyle = DEFAULT_BURN_STYLE,
): Promise<void> {
  if (!(await hasSubtitlesFilter())) {
    throw new Error(
      "Хадмалыг видеон дээр шатаах боломжгүй — энэ сервер дээрх ffmpeg libass-гүй " +
        "суулгагдсан байна. 'Тусдаа SRT файл' сонголтыг ашиглах эсвэл ffmpeg-г " +
        "libass-тай дахин суулгана уу.",
    );
  }
  // libavfilter parses ':' as an option separator and '\' as an escape inside
  // the filter string, so any such char in the path must be escaped. Our tmp
  // paths never contain them, but escape defensively.
  const escapedPath = srtPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
  // Probe the video's actual height so positionPct (0-100%) lands at the
  // same visual spot regardless of source resolution (720p vs 1080p vs 4K).
  const videoHeight = await probeVideoHeight(videoPath);
  // FontName is intentionally omitted so libass/fontconfig picks a font with
  // the right glyph coverage (Cyrillic for Mongolian, CJK for Chinese).
  const forceStyle = buildForceStyle(style, videoHeight);
  const vf = `subtitles=${escapedPath}:force_style='${forceStyle}'`;
  return runFfmpeg([
    "-y",
    "-i", videoPath,
    "-vf", vf,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-c:a", "aac",
    "-movflags", "+faststart",
    outPath,
  ]);
}

/**
 * Generate an SRT subtitle file from segments.
 * Useful as a side artifact alongside the dubbed video.
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
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return (
    `${String(h).padStart(2, "0")}:` +
    `${String(m).padStart(2, "0")}:` +
    `${String(s).padStart(2, "0")},` +
    `${String(ms).padStart(3, "0")}`
  );
}
