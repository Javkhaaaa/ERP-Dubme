import { stat, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { Job } from "@prisma/client";
import { JobStatus } from "@prisma/client";
import { prisma } from "./db.js";
import {
  downloadToFile,
  downloadUrlToFile,
  presignDownload,
  uploadBuffer,
  uploadFile,
} from "./storage.js";
import {
  burnAss,
  type BurnCue,
  type BurnSubtitleStyle,
  DEFAULT_BURN_STYLE,
  extractAudioCompressed,
  mapPool,
  mixSegmentsToTimeline,
  probeDuration,
  probeVideoMeta,
  replaceAudioTrack,
  sliceAudio,
  SUBTITLE_REF_HEIGHT,
  tmpPath,
  writeAss,
  writeSrt,
} from "./ffmpeg.js";
import { transcribe, type SttResult, type SttSegment } from "./clients/groq-stt.js";
import {
  downloadAudio as ytDlpAudio,
  downloadVideo as ytDlpDownload,
  hasYtDlp,
  looksLikeStreamingSite,
} from "./clients/yt-dlp.js";
import { translateSegments } from "./clients/gemini-translate.js";
import { synthesize as synthesizeGemini } from "./clients/gemini-tts.js";
import { synthesizeChimege } from "./clients/chimege-tts.js";

/**
 * The full dubme pipeline:
 *
 *   UPLOADED → EXTRACTING → TRANSCRIBING → TRANSLATING →
 *     [optional EDITING pause] →
 *   SYNTHESIZING → MUXING → DONE
 *
 * Each step updates Job.status (and Job.progress / progressNote during the long
 * SYNTHESIZING/MUXING phases) so the UI can show movement, not just a frozen
 * spinner. On any error we set status=FAILED and store errorMessage.
 */

/* ─── Per-job local cache ────────────────────────────────────────────────
 * The source video is needed twice — by STT (extract audio) and by render —
 * with the unbounded EDITING pause in between. The old code downloaded it from
 * S3, deleted it, then downloaded the identical bytes AGAIN at render time
 * (minutes of pure waste on a multi-GB file). We now keep one copy in a
 * jobId-keyed cache that both phases reuse; a background sweep removes stale
 * dirs so disk doesn't grow without bound.
 */
const CACHE_ROOT = join(tmpdir(), "dubme-cache");

function cacheDir(jobId: string): string {
  return join(CACHE_ROOT, jobId);
}

async function ensureCacheDir(jobId: string): Promise<string> {
  const dir = cacheDir(jobId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Remove a job's cache dir. Called when a job reaches a terminal state. */
export async function cleanupJobCache(jobId: string): Promise<void> {
  await rm(cacheDir(jobId), { recursive: true, force: true }).catch(() => void 0);
}

/**
 * Sweep cache dirs older than `maxAgeHours`. Call on server start and on a
 * timer so abandoned EDITING jobs don't keep their videos on disk forever.
 */
export async function sweepStaleCache(maxAgeHours = 24): Promise<void> {
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(CACHE_ROOT).catch(() => [] as string[]);
    const cutoff = Date.now() - maxAgeHours * 3600_000;
    for (const name of entries) {
      const dir = join(CACHE_ROOT, name);
      const s = await stat(dir).catch(() => null);
      if (s && s.mtimeMs < cutoff) {
        await rm(dir, { recursive: true, force: true }).catch(() => void 0);
        console.log(`[cache] swept stale ${name}`);
      }
    }
  } catch {
    /* best-effort */
  }
}

/* ─── Background video import registry ───────────────────────────────────
 * For URL-import jobs we fetch the (small) audio first so STT + translation —
 * everything needed to reach EDITING and download an SRT — start immediately,
 * while the full video downloads in the BACKGROUND. Render later awaits this
 * promise so the video is guaranteed present before muxing.
 */
const videoImports = new Map<string, Promise<void>>();

/** Resolve once a job's background video import (if any) has finished. */
export function awaitVideoImport(jobId: string): Promise<void> {
  return videoImports.get(jobId) ?? Promise.resolve();
}

/**
 * Kick off (and register) a background download of the full video → S3.
 * Streaming sites go through yt-dlp (≤1080p mp4); direct URLs stream to disk.
 * Failures are logged but do NOT fail the job — an SRT-only user never needs
 * the video; a render attempt will surface a clear error if it's missing.
 */
function startVideoImport(jobId: string, url: string): void {
  const p = (async () => {
    const dir = await ensureCacheDir(jobId);
    const cachePathLocal = join(dir, "input.mp4");
    const useYtDlp = looksLikeStreamingSite(url);
    if (useYtDlp) {
      if (!(await hasYtDlp())) {
        throw new Error("yt-dlp not installed — cannot import streaming video");
      }
      await ytDlpDownload(url, cachePathLocal);
    } else {
      await downloadUrlToFile(url, cachePathLocal);
    }
    const inputKey = `jobs/${jobId}/input.mp4`;
    await uploadFile(cachePathLocal, inputKey, "video/mp4");
    await prisma.job.update({ where: { id: jobId }, data: { inputKey } });
    console.log(`[pipeline] job=${jobId} background video import complete`);
  })().catch((err) => {
    console.error(`[pipeline] job=${jobId} background video import FAILED:`, err);
  });
  videoImports.set(jobId, p);
  // Drop the entry once it settles so the map doesn't grow without bound.
  // (Late awaiters then get a resolved Promise and fall back to the cache/S3.)
  void p.finally(() => videoImports.delete(jobId));
}

/**
 * Ensure the source video is on local disk (cache hit → instant; otherwise
 * download from S3 once). Also waits for any in-flight background import so the
 * render path never races a still-downloading video.
 */
async function ensureLocalVideo(jobId: string): Promise<string> {
  await awaitVideoImport(jobId);
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  if (!job.inputKey) {
    throw new Error("Видео бэлэн биш байна — татаж дуусаагүй эсвэл алдаа гарсан.");
  }
  const dir = await ensureCacheDir(jobId);
  const local = join(dir, `input${extname(job.inputKey) || ".mp4"}`);
  if (existsSync(local) && (await stat(local)).size > 0) return local;
  const tmp = `${local}.part`;
  await downloadToFile(job.inputKey, tmp);
  await rename(tmp, local);
  return local;
}

/* ─── STT (shared back-half) ─────────────────────────────────────────────── */

const STT_MAX_FILE_BYTES = 20 * 1024 * 1024; // headroom under Groq's 25 MB
const STT_CHUNK_SECONDS = 600; // 10 min per chunk
const STT_CONCURRENCY = 4;

/**
 * Transcribe an already-extracted Opus file and persist Segment rows.
 * Shared by the browser-upload path (runStt) and the URL audio-first path.
 */
async function transcribeAndSaveSegments(
  jobId: string,
  audioOggPath: string,
  sourceLanguage: string | undefined,
): Promise<void> {
  // Push extracted audio to storage so it's reusable (e.g. editor preview).
  const audioKey = `jobs/${jobId}/audio.ogg`;
  const audioUpload = uploadFile(audioOggPath, audioKey, "audio/ogg");

  console.log(`[pipeline] job=${jobId} → TRANSCRIBING (lang hint=${sourceLanguage})`);
  await prisma.job.update({
    where: { id: jobId },
    data: { status: JobStatus.TRANSCRIBING, audioKey },
  });

  const stt = await transcribeAudioFile(audioOggPath, sourceLanguage, jobId);
  await audioUpload; // make sure the preview audio landed
  console.log(
    `[stt] job=${jobId} detected=${stt.language} segments=${stt.segments.length} ` +
      `fullText="${stt.fullText.slice(0, 120)}${stt.fullText.length > 120 ? "..." : ""}"`,
  );

  let rows = stt.segments.map((s, idx) => ({
    jobId,
    sequence: idx,
    startSec: s.start,
    endSec: s.end,
    sourceText: s.text,
  }));
  if (rows.length === 0 && stt.fullText.trim()) {
    const duration = await probeDuration(audioOggPath);
    rows = [{ jobId, sequence: 0, startSec: 0, endSec: duration, sourceText: stt.fullText.trim() }];
  }
  if (rows.length === 0) {
    throw new Error(
      "Аудионд яриа таниагүй. Видео чимээгүй эсвэл хэт чанар муу байж магад. Өөр видео туршаарай.",
    );
  }
  await prisma.segment.deleteMany({ where: { jobId } });
  await prisma.segment.createMany({ data: rows });
}

/** Browser-upload / S3 path: pull video (cached) → extract audio → STT. */
export async function runStt(jobId: string): Promise<void> {
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  if (!job.inputKey) throw new Error("Job has no inputKey");

  const audioPath = tmpPath("ogg");
  try {
    console.log(`[pipeline] job=${jobId} → EXTRACTING`);
    await prisma.job.update({ where: { id: jobId }, data: { status: JobStatus.EXTRACTING } });

    const videoPath = await ensureLocalVideo(jobId);
    const videoStat = await stat(videoPath);
    console.log(`[pipeline] job=${jobId} local video ${videoStat.size} bytes`);

    await extractAudioCompressed(videoPath, audioPath);
    const audioStat = await stat(audioPath);
    console.log(`[pipeline] job=${jobId} extracted audio ${audioStat.size} bytes`);

    await transcribeAndSaveSegments(jobId, audioPath, job.sourceLanguage);
  } finally {
    safeUnlink(audioPath);
  }
}

/**
 * URL-import fast path: download ONLY the audio (tiny vs the full video) and
 * run STT immediately, while the full video downloads in the background. This
 * is what makes "import a 2-hour video → get an SRT" finish in minutes instead
 * of waiting on a multi-GB video download first.
 */
export async function runUrlImportAndStt(jobId: string, url: string): Promise<void> {
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });

  // Background: fetch the full video → S3 (only needed if the user renders).
  startVideoImport(jobId, url);

  const useYtDlp = looksLikeStreamingSite(url);
  const dir = await ensureCacheDir(jobId);
  const audioOgg = tmpPath("ogg");
  try {
    console.log(`[pipeline] job=${jobId} → DOWNLOADING audio`);
    await prisma.job.update({ where: { id: jobId }, data: { status: JobStatus.DOWNLOADING } });

    let rawAudio: string;
    if (useYtDlp) {
      if (!(await hasYtDlp())) {
        throw new Error(
          "YouTube/Bilibili/Vimeo зэрэг сайтаас татахын тулд yt-dlp суулгасан " +
            "байх ёстой. macOS дээр: `brew install yt-dlp`.",
        );
      }
      rawAudio = await ytDlpAudio(url, join(dir, "audio-src"));
    } else {
      // Direct file URL — there's no separate audio-only stream to fetch, so
      // we must use the full file. Wait for the background import to finish
      // writing the cached copy (avoids two writers racing on the same path),
      // then extract audio from it. (No early-STT win here, but direct-file
      // URLs are the rare case; the audio-only fast path is for streaming.)
      await awaitVideoImport(jobId);
      const cached = join(dir, "input.mp4");
      if (!existsSync(cached)) {
        // Background import failed — fetch our own copy so STT can proceed.
        await downloadUrlToFile(url, cached);
      }
      rawAudio = cached;
    }

    await prisma.job.update({ where: { id: jobId }, data: { status: JobStatus.EXTRACTING } });
    await extractAudioCompressed(rawAudio, audioOgg);
    if (useYtDlp) safeUnlink(rawAudio); // the .opus source; keep direct-file cache

    await transcribeAndSaveSegments(jobId, audioOgg, job.sourceLanguage);
  } finally {
    safeUnlink(audioOgg);
  }
}

/** for /jobs/from-srt: no STT (segments preloaded) — just import the video. */
export function importVideoForJob(jobId: string, url: string): void {
  startVideoImport(jobId, url);
}

/**
 * Groq caps single uploads at 25 MB. Longer audio is split into ≤10-min
 * chunks. The chunks are fully independent (language is pinned from the job's
 * sourceLanguage), so we slice them all up front and transcribe with bounded
 * concurrency instead of one-at-a-time.
 */
async function transcribeAudioFile(
  audioPath: string,
  language: string | undefined,
  jobId: string,
): Promise<SttResult> {
  const audioStat = await stat(audioPath);
  if (audioStat.size <= STT_MAX_FILE_BYTES) {
    return transcribe(audioPath, language);
  }

  const totalDur = await probeDuration(audioPath);
  const numChunks = Math.ceil(totalDur / STT_CHUNK_SECONDS);
  console.log(
    `[stt] job=${jobId} audio ${(audioStat.size / 1024 / 1024).toFixed(1)}MB / ` +
      `${totalDur.toFixed(0)}s → ${numChunks} chunks @ concurrency ${STT_CONCURRENCY}`,
  );

  const indices = Array.from({ length: numChunks }, (_, i) => i);
  const perChunk = await mapPool(indices, STT_CONCURRENCY, async (i) => {
    const chunkStart = i * STT_CHUNK_SECONDS;
    const chunkDur = Math.min(STT_CHUNK_SECONDS, totalDur - chunkStart);
    const chunkPath = tmpPath("ogg");
    try {
      await sliceAudio(audioPath, chunkStart, chunkDur, chunkPath);
      const res = await transcribe(chunkPath, language);
      console.log(
        `[stt] job=${jobId} chunk ${i + 1}/${numChunks} → ${res.segments.length} segments`,
      );
      return { i, chunkStart, res };
    } finally {
      safeUnlink(chunkPath);
    }
  });

  const allSegments: SttSegment[] = [];
  const textParts: string[] = [];
  let detectedLanguage = language;
  for (const { chunkStart, res } of perChunk) {
    detectedLanguage = detectedLanguage ?? res.language;
    if (res.fullText.trim()) textParts.push(res.fullText.trim());
    for (const seg of res.segments) {
      allSegments.push({ start: seg.start + chunkStart, end: seg.end + chunkStart, text: seg.text });
    }
  }
  return { language: detectedLanguage ?? "", fullText: textParts.join(" "), segments: allSegments };
}

/** Step 3: machine-translate sourceText → translatedText for all segments. */
export async function runTranslate(jobId: string): Promise<void> {
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  await prisma.job.update({ where: { id: jobId }, data: { status: JobStatus.TRANSLATING } });

  const segments = await prisma.segment.findMany({
    where: { jobId },
    orderBy: { sequence: "asc" },
  });
  if (segments.length === 0) throw new Error("No segments to translate");

  const translated = await translateSegments(
    segments.map((s) => s.sourceText),
    job.sourceLanguage,
    job.targetLanguage,
  );

  await bulkUpdateTranslations(
    segments.map((s, i) => ({ id: s.id, text: translated[i] ?? "" })),
  );

  await prisma.job.update({ where: { id: jobId }, data: { status: JobStatus.EDITING } });
}

/**
 * Persist N translations in ONE round-trip instead of N sequential UPDATEs
 * inside a transaction (which cost N×RTT to the DB — minutes when the backend
 * is far from Supabase). UPDATE … FROM (unnest(...)) does it in a single query.
 */
export async function bulkUpdateTranslations(
  rows: { id: string; text: string }[],
  clearEdited = false,
): Promise<void> {
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);
  const texts = rows.map((r) => r.text);
  if (clearEdited) {
    await prisma.$executeRaw`
      UPDATE "Segment" AS s
      SET "translatedText" = v.txt, "edited" = false, "updatedAt" = now()
      FROM (SELECT unnest(${ids}::text[]) AS id, unnest(${texts}::text[]) AS txt) AS v
      WHERE s.id = v.id`;
  } else {
    await prisma.$executeRaw`
      UPDATE "Segment" AS s
      SET "translatedText" = v.txt, "updatedAt" = now()
      FROM (SELECT unnest(${ids}::text[]) AS id, unnest(${texts}::text[]) AS txt) AS v
      WHERE s.id = v.id`;
  }
}

/* ─── Render ─────────────────────────────────────────────────────────────── */

type SubtitleText = "translated" | "source" | "both";

/** Build a complete BurnSubtitleStyle from the Job row (with safe defaults). */
function buildBurnStyle(job: Job): BurnSubtitleStyle {
  const d = DEFAULT_BURN_STYLE;
  return {
    fontFamily: job.subtitleFontFamily ?? d.fontFamily,
    fontSize: job.subtitleFontSize ?? d.fontSize,
    bold: job.subtitleBold ?? d.bold,
    italic: job.subtitleItalic ?? d.italic,
    textColor: job.subtitleTextColor ?? d.textColor,
    outlineWidth: job.subtitleOutlineWidth ?? d.outlineWidth,
    outlineColor: job.subtitleOutlineColor ?? d.outlineColor,
    outlineAlpha: job.subtitleOutlineAlpha ?? d.outlineAlpha,
    shadowDepth: job.subtitleShadowDepth ?? d.shadowDepth,
    shadowColor: job.subtitleShadowColor ?? d.shadowColor,
    bgColor: job.subtitleBgColor ?? d.bgColor,
    bgOpacity: job.subtitleBgOpacity ?? d.bgOpacity,
    align: (job.subtitleAlign as BurnSubtitleStyle["align"]) ?? d.align,
    marginHPct: job.subtitleMarginHPct ?? d.marginHPct,
    letterSpacing: job.subtitleLetterSpacing ?? d.letterSpacing,
    positionPct: job.subtitlePositionPct ?? d.positionPct,
    zhScale: job.subtitleZhScale ?? d.zhScale,
    zhColor: job.subtitleZhColor ?? d.zhColor,
  };
}

/** Steps 4+5: TTS each segment → mix on timeline → mux back into video. */
export async function runRender(jobId: string): Promise<void> {
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  if (!job.inputKey && job.outputMode !== "subtitle") {
    // subtitle-only can technically run from-srt-only (no video), but burning
    // needs a video; the route guards that. Dub always needs a video.
  }

  const outputMode = job.outputMode === "subtitle" ? "subtitle" : "dub";
  const subtitleText = (job.subtitleText ?? "translated") as SubtitleText;
  const burn = job.subtitleBurn ?? false;
  const style = buildBurnStyle(job);
  const capTo1080 = job.capTo1080 ?? true;

  const segments = await prisma.segment.findMany({
    where: { jobId },
    orderBy: { sequence: "asc" },
  });
  if (segments.length === 0) throw new Error("No segments to render");

  // Translation gaps shouldn't nuke a long render: gap-fill (in the translator)
  // makes blanks rare, and the synthesis/cue builders already skip empty lines.
  // So only FAIL if essentially everything is missing (a real upstream failure);
  // otherwise warn and let the few blank segments simply go un-dubbed/un-subbed.
  const needsTranslation = outputMode === "dub" || subtitleText !== "source";
  if (needsTranslation) {
    const missing = segments.filter((s) => !s.translatedText?.trim()).length;
    if (missing > 0) {
      const ratio = missing / segments.length;
      console.warn(
        `[render] job=${jobId} ${missing}/${segments.length} segments missing translation`,
      );
      if (ratio > 0.5) {
        throw new Error(
          `Орчуулга дутуу байна (${missing}/${segments.length} мөр орчуулагдаагүй). ` +
            `Орчуулгыг дахин ажиллуулна уу.`,
        );
      }
    }
  }

  const srtCues = buildSubtitleCues(segments, subtitleText);
  const burnCues = buildBurnCues(segments, subtitleText);

  if (outputMode === "subtitle") {
    await renderSubtitleOnly(jobId, job.inputKey, srtCues, burnCues, burn, style, capTo1080);
    return;
  }

  if (!job.voiceName) throw new Error("Job has no voiceName chosen");

  await prisma.job.update({
    where: { id: jobId },
    data: { status: JobStatus.SYNTHESIZING, progress: 0, progressNote: "Дуу үүсгэж байна" },
  });

  // Start pulling the source video NOW so it overlaps with TTS instead of
  // blocking the mux step later. Guard the floating promise so a rejection
  // can't crash the process before we await it.
  const videoReady = ensureLocalVideo(jobId).catch((e) => {
    console.error(`[render] job=${jobId} video fetch error:`, e);
    return Promise.reject(e);
  });
  videoReady.catch(() => void 0);

  const ttsProvider = job.ttsProvider ?? "gemini";
  const isChimege = ttsProvider === "chimege";
  const maxChars = isChimege ? 280 : 600;
  const ttsConcurrency = isChimege ? 6 : 3; // Gemini TTS preview is RPM-bound

  const groups = groupForSynthesis(segments, { maxGapSec: 1.0, maxChars });
  console.log(
    `[render] job=${jobId} provider=${ttsProvider} grouped ${segments.length} segments → ${groups.length} TTS calls @ conc ${ttsConcurrency}`,
  );

  const segmentClips: { startSec: number; endSec: number; audioPath: string }[] = new Array(groups.length);
  const tempPaths: string[] = [];
  // S3 preview uploads + DB audioKey writes don't gate the render output — run
  // them off the critical path and await once at the end.
  const sideEffects: Promise<unknown>[] = [];
  let completed = 0;

  try {
    await mapPool(groups, ttsConcurrency, async (group, i) => {
      const combinedText = group.segments.map((s) => s.translatedText!.trim()).join(" ");
      const wav = isChimege
        ? await synthesizeChimege({ text: combinedText, voiceId: job.voiceName! })
        : await synthesizeGemini({
            text: combinedText,
            voiceName: job.voiceName!,
            stylePrompt: job.stylePrompt ?? undefined,
            temperature: job.temperature ?? undefined,
          });
      const localPath = tmpPath("wav");
      tempPaths.push(localPath);
      await writeFile(localPath, wav);

      segmentClips[i] = {
        startSec: group.segments[0].startSec,
        endSec: group.segments[group.segments.length - 1].endSec,
        audioPath: localPath,
      };

      // Off-critical-path: persist preview audio + audioKey (best-effort).
      const segKey = `jobs/${jobId}/segments/${group.segments[0].sequence}.wav`;
      const seqs = group.segments.map((s) => s.sequence);
      sideEffects.push(
        uploadBuffer(wav, segKey, "audio/wav")
          .then(() =>
            prisma.segment.updateMany({
              where: { jobId, sequence: { in: seqs } },
              data: { audioKey: segKey },
            }),
          )
          .catch((e) => console.warn(`[render] preview persist failed seq=${seqs[0]}:`, e)),
      );

      completed++;
      await prisma.job
        .update({
          where: { id: jobId },
          data: {
            progress: Math.round((completed / groups.length) * 100),
            progressNote: `Дуу үүсгэж байна ${completed}/${groups.length}`,
          },
        })
        .catch(() => void 0);
    });

    // 2. Mix + mux.
    await prisma.job.update({
      where: { id: jobId },
      data: { status: JobStatus.MUXING, progressNote: "Видеотой нэгтгэж байна" },
    });

    const videoPath = await videoReady;
    const meta = await probeVideoMeta(videoPath);

    const mixedPath = tmpPath("wav");
    const dubbedPath = tmpPath("mp4");
    const srtPath = tmpPath("srt");
    tempPaths.push(mixedPath, dubbedPath, srtPath);

    await mixSegmentsToTimeline(segmentClips, meta.durationSec, mixedPath, {
      originalAudioPath: videoPath, // read original audio straight from the video
      duckLevel: 0.05,
    });

    await writeSrt(srtCues, srtPath);

    let finalVideoPath: string;
    if (burn) {
      // Single pass: mux the dub AND burn subs in one ffmpeg invocation
      // (the old code wrote a full intermediate mp4, then re-read + re-encoded
      // it — a redundant whole-video write/read + a second AAC generation).
      const { outW, outH, scaleToHeight } = outputDims(meta, capTo1080);
      const assPath = tmpPath("ass");
      const burnedPath = tmpPath("mp4");
      tempPaths.push(assPath, burnedPath);
      await writeAss(burnCues, style, outW, outH, assPath);
      await burnAss(videoPath, assPath, burnedPath, { audioPath: mixedPath, scaleToHeight, outHeight: outH });
      finalVideoPath = burnedPath;
    } else {
      finalVideoPath = dubbedPath;
      await replaceAudioTrack(videoPath, mixedPath, dubbedPath);
    }

    const outputKey = `jobs/${jobId}/output.mp4`;
    const subtitleKey = `jobs/${jobId}/output.srt`;
    await uploadFile(finalVideoPath, outputKey, "video/mp4");
    await uploadFile(srtPath, subtitleKey, "application/x-subrip");

    await Promise.allSettled(sideEffects);

    await prisma.job.update({
      where: { id: jobId },
      data: { status: JobStatus.DONE, outputKey, subtitleKey, progress: 100, progressNote: null },
    });
    await cleanupJobCache(jobId);
  } finally {
    for (const p of tempPaths) safeUnlink(p);
  }
}

/** Compute output (possibly downscaled) dimensions for the burn pass. */
function outputDims(
  meta: { width: number; height: number },
  capTo1080: boolean,
): { outW: number; outH: number; scaleToHeight?: number } {
  if (capTo1080 && meta.height > SUBTITLE_REF_HEIGHT) {
    const outH = SUBTITLE_REF_HEIGHT;
    const outW = Math.round((meta.width * outH) / meta.height / 2) * 2; // even
    return { outW, outH, scaleToHeight: outH };
  }
  return { outW: meta.width, outH: meta.height };
}

interface SubtitleCue {
  startSec: number;
  endSec: number;
  text: string;
}

/** Flat cues (for the SRT artifact). */
function buildSubtitleCues(
  segments: { startSec: number; endSec: number; sourceText: string; translatedText: string | null }[],
  mode: SubtitleText,
): SubtitleCue[] {
  return segments
    .map((s) => {
      let text: string;
      if (mode === "source") text = s.sourceText.trim();
      else if (mode === "both") text = `${s.sourceText.trim()}\n${(s.translatedText ?? "").trim()}`.trim();
      else text = (s.translatedText ?? "").trim();
      return { startSec: s.startSec, endSec: s.endSec, text };
    })
    .filter((c) => c.text.length > 0);
}

/** Structured cues (for the .ass burn — keeps zh/mn separate for per-line styling). */
function buildBurnCues(
  segments: { startSec: number; endSec: number; sourceText: string; translatedText: string | null }[],
  mode: SubtitleText,
): BurnCue[] {
  const out: BurnCue[] = [];
  for (const s of segments) {
    const zh = s.sourceText.trim();
    const mn = (s.translatedText ?? "").trim();
    let cue: BurnCue | null = null;
    if (mode === "source") cue = zh ? { startSec: s.startSec, endSec: s.endSec, zh } : null;
    else if (mode === "both") {
      if (zh || mn) cue = { startSec: s.startSec, endSec: s.endSec, zh: zh || undefined, mn: mn || undefined };
    } else cue = mn ? { startSec: s.startSec, endSec: s.endSec, mn } : null;
    if (cue) out.push(cue);
  }
  return out;
}

/**
 * Subtitle-only render: no TTS. Write the SRT artifact, and — if `burn` —
 * hardsub a generated .ass onto the source video in one pass (keeping the
 * original audio). When not burning, the original upload IS the output.
 */
async function renderSubtitleOnly(
  jobId: string,
  inputKey: string | null,
  srtCues: SubtitleCue[],
  burnCues: BurnCue[],
  burn: boolean,
  style: BurnSubtitleStyle,
  capTo1080: boolean,
): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: { status: JobStatus.MUXING, progressNote: burn ? "Хадмал шатааж байна" : "Хадмал бэлдэж байна" },
  });

  const srtPath = tmpPath("srt");
  const tempPaths: string[] = [srtPath];
  try {
    await writeSrt(srtCues, srtPath);
    const subtitleKey = `jobs/${jobId}/output.srt`;
    await uploadFile(srtPath, subtitleKey, "application/x-subrip");

    let outputKey = inputKey; // no burn → original video is the output
    if (burn) {
      if (!inputKey) throw new Error("Хадмал шатаах видео алга");
      const videoPath = await ensureLocalVideo(jobId);
      const meta = await probeVideoMeta(videoPath);
      const { outW, outH, scaleToHeight } = outputDims(meta, capTo1080);
      const assPath = tmpPath("ass");
      const outputPath = tmpPath("mp4");
      tempPaths.push(assPath, outputPath);
      await writeAss(burnCues, style, outW, outH, assPath);
      await burnAss(videoPath, assPath, outputPath, { scaleToHeight, outHeight: outH });
      outputKey = `jobs/${jobId}/output.mp4`;
      await uploadFile(outputPath, outputKey, "video/mp4");
    }

    await prisma.job.update({
      where: { id: jobId },
      data: { status: JobStatus.DONE, outputKey, subtitleKey, progress: 100, progressNote: null },
    });
    await cleanupJobCache(jobId);
  } finally {
    for (const p of tempPaths) safeUnlink(p);
  }
}

/** Run an arbitrary pipeline step and mark FAILED if it throws. */
export async function safeRun(
  jobId: string,
  fn: (id: string) => Promise<void>,
): Promise<void> {
  try {
    await fn(jobId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[pipeline] job ${jobId} failed:`, err);
    await prisma.job.update({
      where: { id: jobId },
      data: { status: JobStatus.FAILED, errorMessage: msg },
    });
    await cleanupJobCache(jobId);
  }
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* ignore — file may not exist if step failed early */
  }
}

interface SynthesisGroup {
  segments: {
    id: string;
    sequence: number;
    startSec: number;
    endSec: number;
    translatedText: string | null;
  }[];
}

/**
 * Group adjacent Segment rows into batches for one TTS call so each sentence is
 * voiced with a single coherent prosody. `maxGapSec` keeps real pauses as
 * separate groups; `maxChars` keeps each call under the provider's limit.
 */
function groupForSynthesis(
  segments: {
    id: string;
    sequence: number;
    startSec: number;
    endSec: number;
    translatedText: string | null;
  }[],
  opts: { maxGapSec: number; maxChars: number },
): SynthesisGroup[] {
  const out: SynthesisGroup[] = [];
  let current: SynthesisGroup | null = null;
  let currentChars = 0;

  for (const seg of segments) {
    const txt = seg.translatedText?.trim() ?? "";
    if (!txt) continue;

    const lastEnd = current?.segments.at(-1)?.endSec ?? -Infinity;
    const gap = seg.startSec - lastEnd;
    const wouldExceedChars = currentChars + txt.length + 1 > opts.maxChars;

    if (!current || gap > opts.maxGapSec || wouldExceedChars) {
      current = { segments: [] };
      out.push(current);
      currentChars = 0;
    }
    current.segments.push(seg);
    currentChars += txt.length + 1;
  }
  return out;
}

/** Convenience for the route layer to get presigned download URLs. */
export async function jobDownloadUrls(jobId: string): Promise<{
  output?: string;
  subtitle?: string;
}> {
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  const out: { output?: string; subtitle?: string } = {};
  if (job.outputKey) out.output = await presignDownload(job.outputKey);
  if (job.subtitleKey) out.subtitle = await presignDownload(job.subtitleKey);
  return out;
}
