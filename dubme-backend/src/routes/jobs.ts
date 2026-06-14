import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { presignDownload, presignUpload } from "../storage.js";
import {
  bulkUpdateTranslations,
  importVideoForJob,
  jobDownloadUrls,
  runRender,
  runStt,
  runTranslate,
  runUrlImportAndStt,
  safeRun,
} from "../pipeline.js";
import { refineSegments } from "../clients/gemini-translate.js";
import { parseSrt } from "../srt-parser.js";
import { formatSrtTime } from "../ffmpeg.js";

const CreateJobSchema = z.object({
  sourceLanguage: z.string().default("zh"),
  targetLanguage: z.string().default("mn"),
  filename: z.string(), // original client filename, used for content-type heuristics
});

const CreateJobFromUrlSchema = z.object({
  sourceLanguage: z.string().default("zh"),
  targetLanguage: z.string().default("mn"),
  url: z.string().url(),
});

const CreateJobFromSrtSchema = z.object({
  sourceLanguage: z.string().default("zh"),
  targetLanguage: z.string().default("mn"),
  videoUrl: z.string().url(),
  srtContent: z.string().min(10).max(5_000_000),
});

const CreateJobFromSrtUploadSchema = z.object({
  sourceLanguage: z.string().default("zh"),
  targetLanguage: z.string().default("mn"),
  filename: z.string(),
  srtContent: z.string().min(10).max(5_000_000),
});

const CreateJobFromSrtOnlySchema = z.object({
  sourceLanguage: z.string().default("zh"),
  targetLanguage: z.string().default("mn"),
  srtContent: z.string().min(10).max(5_000_000),
});

const UpdateSegmentSchema = z.object({
  translatedText: z.string().min(1),
});

const RefineSchema = z.object({
  prompt: z.string().trim().min(3).max(1000),
});

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

const StartRenderSchema = z.object({
  // Optional: subtitle-only renders don't pick a voice.
  voiceName: z.string().min(1).optional(),
  stylePrompt: z.string().optional().nullable(),
  temperature: z.number().min(0).max(2).optional(),
  ttsProvider: z.enum(["gemini", "chimege"]).optional(),
  /** "dub" replaces the audio via TTS; "subtitle" only generates subtitles. */
  outputMode: z.enum(["dub", "subtitle"]).default("dub"),
  /** Which text the subtitle shows. */
  subtitleText: z.enum(["translated", "source", "both"]).default("translated"),
  /** Burn the subtitle onto the video (hardsub) in addition to the SRT file. */
  subtitleBurn: z.boolean().default(false),
  /** Cap output to 1080p before burning (big speed win on 4K). */
  capTo1080: z.boolean().default(true),

  // ── Subtitle style (sizes/widths are px @ 1080p reference) ──────────────
  subtitleFontFamily: z.string().min(1).max(40).default("Noto Sans"),
  subtitleFontSize: z.number().int().min(12).max(160).default(48),
  subtitleBold: z.boolean().default(false),
  subtitleItalic: z.boolean().default(false),
  subtitleTextColor: hexColor.default("#FFFFFF"),
  subtitleOutlineWidth: z.number().min(0).max(8).default(3),
  subtitleOutlineColor: hexColor.default("#000000"),
  subtitleOutlineAlpha: z.number().int().min(0).max(100).default(80),
  subtitleShadowDepth: z.number().min(0).max(8).default(0),
  subtitleShadowColor: hexColor.default("#000000"),
  subtitleBgColor: hexColor.nullable().optional(),
  subtitleBgOpacity: z.number().int().min(0).max(100).default(75),
  subtitleAlign: z.enum(["left", "center", "right"]).default("center"),
  subtitleMarginHPct: z.number().int().min(0).max(40).default(4),
  subtitleLetterSpacing: z.number().min(-2).max(10).default(0),
  /** Vertical position 0-100% from top (to the bottom edge of the text block). */
  subtitlePositionPct: z.number().int().min(0).max(100).default(88),
  /** Dual-language ("both") mode: zh line size relative to main, and its colour. */
  subtitleZhScale: z.number().min(0.4).max(1.5).default(0.8),
  subtitleZhColor: hexColor.nullable().optional(),
  /** Legacy 3-option position — accepted but no longer read. */
  subtitlePosition: z.enum(["top", "middle", "bottom"]).default("bottom"),
});

export async function registerJobRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 1. Client asks to start a job. We create the DB row and return a
   *    presigned PUT URL — the browser uploads the video directly to
   *    object storage, skipping our server entirely (avoids huge multipart bodies).
   */
  app.post("/jobs", async (request, reply) => {
    const body = CreateJobSchema.parse(request.body);
    const contentType = guessContentType(body.filename);

    const job = await prisma.job.create({
      data: {
        sourceLanguage: body.sourceLanguage,
        targetLanguage: body.targetLanguage,
      },
    });

    const inputKey = `jobs/${job.id}/input${extensionFor(contentType)}`;
    const uploadUrl = await presignUpload(inputKey, contentType);

    // Save the key so /jobs/:id/start knows where to find it.
    await prisma.job.update({
      where: { id: job.id },
      data: { inputKey },
    });

    return {
      jobId: job.id,
      uploadUrl,
      inputKey,
      contentType,
    };
  });

  /**
   * 1b. URL-import flow: client posts a direct video URL, server downloads
   *     it server-side, then runs the same STT + translation pipeline.
   *     Useful for large videos hosted elsewhere (saves the browser-upload
   *     round-trip) and for users who only have a link.
   */
  app.post("/jobs/from-url", async (request, reply) => {
    const body = CreateJobFromUrlSchema.parse(request.body);

    const job = await prisma.job.create({
      data: {
        sourceLanguage: body.sourceLanguage,
        targetLanguage: body.targetLanguage,
      },
    });

    void (async () => {
      // Audio-first: download only the audio and run STT immediately while the
      // full video downloads in the background — so the user reaches EDITING
      // (and can grab an SRT) without waiting on a multi-GB video download.
      await safeRun(job.id, (id) => runUrlImportAndStt(id, body.url));
      const afterStt = await prisma.job.findUnique({ where: { id: job.id } });
      if (afterStt?.status === "FAILED") return;
      await safeRun(job.id, runTranslate);
    })();

    return { jobId: job.id };
  });

  /**
   * 1c. SRT-import flow: client supplies a video URL + an existing SRT
   *     (in the source language). We skip the STT step entirely — segments
   *     come straight from the SRT cues — and jump to translation. Useful
   *     when official subtitles already exist and you want to translate +
   *     mux them rather than re-transcribing the audio.
   */
  app.post("/jobs/from-srt", async (request, reply) => {
    const body = CreateJobFromSrtSchema.parse(request.body);

    const cues = parseSrt(body.srtContent);
    if (cues.length === 0) {
      return reply
        .code(400)
        .send({ error: "SRT файл хоосон эсвэл буруу форматтай байна" });
    }

    const job = await prisma.job.create({
      data: {
        sourceLanguage: body.sourceLanguage,
        targetLanguage: body.targetLanguage,
      },
    });

    // Pre-populate Segment rows directly from the SRT cues. The render path
    // reads from this same table, so once translate fills in translatedText
    // the rest of the pipeline behaves identically to STT-derived jobs.
    await prisma.segment.createMany({
      data: cues.map((c, idx) => ({
        jobId: job.id,
        sequence: idx,
        startSec: c.startSec,
        endSec: c.endSec,
        sourceText: c.text,
      })),
    });

    // Segments are already populated from the SRT, so translate can start
    // immediately; the video downloads in the background (only needed if the
    // user later renders/burns).
    importVideoForJob(job.id, body.videoUrl);
    void safeRun(job.id, runTranslate);

    return { jobId: job.id, segmentCount: cues.length };
  });

  /**
   * 1d. SRT + uploaded-video variant: like /jobs (returns a presigned PUT
   *     URL for the browser to upload the video to) but also parses the
   *     user-supplied SRT and pre-populates Segment rows. When the browser
   *     subsequently calls /jobs/:id/start, that endpoint detects the
   *     existing segments and skips STT.
   */
  app.post("/jobs/from-srt-upload", async (request, reply) => {
    const body = CreateJobFromSrtUploadSchema.parse(request.body);

    const cues = parseSrt(body.srtContent);
    if (cues.length === 0) {
      return reply
        .code(400)
        .send({ error: "SRT файл хоосон эсвэл буруу форматтай байна" });
    }

    const contentType = guessContentType(body.filename);
    const job = await prisma.job.create({
      data: {
        sourceLanguage: body.sourceLanguage,
        targetLanguage: body.targetLanguage,
      },
    });

    await prisma.segment.createMany({
      data: cues.map((c, idx) => ({
        jobId: job.id,
        sequence: idx,
        startSec: c.startSec,
        endSec: c.endSec,
        sourceText: c.text,
      })),
    });

    const inputKey = `jobs/${job.id}/input${extensionFor(contentType)}`;
    const uploadUrl = await presignUpload(inputKey, contentType);

    await prisma.job.update({
      where: { id: job.id },
      data: { inputKey },
    });

    return {
      jobId: job.id,
      uploadUrl,
      inputKey,
      contentType,
      segmentCount: cues.length,
    };
  });

  /**
   * 1e. SRT-only translate flow: user supplies a source-language SRT and
   *     gets a translated SRT back. No video at any point — segments come
   *     from the SRT, translate runs, the job lands in EDITING, and the
   *     user downloads the result from the pre-render SRT bar.
   */
  app.post("/jobs/from-srt-only", async (request, reply) => {
    const body = CreateJobFromSrtOnlySchema.parse(request.body);

    const cues = parseSrt(body.srtContent);
    if (cues.length === 0) {
      return reply
        .code(400)
        .send({ error: "SRT файл хоосон эсвэл буруу форматтай байна" });
    }

    const job = await prisma.job.create({
      data: {
        sourceLanguage: body.sourceLanguage,
        targetLanguage: body.targetLanguage,
        // inputKey intentionally left null — render is not applicable.
      },
    });

    await prisma.segment.createMany({
      data: cues.map((c, idx) => ({
        jobId: job.id,
        sequence: idx,
        startSec: c.startSec,
        endSec: c.endSec,
        sourceText: c.text,
      })),
    });

    // No video to download, no STT — translate right away.
    void safeRun(job.id, runTranslate);

    return { jobId: job.id, segmentCount: cues.length };
  });

  /**
   * 2. After the browser finishes uploading, it pings this endpoint
   *    to kick off the STT + translation pipeline (background).
   */
  app.post("/jobs/:id/start", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await prisma.job.findUnique({
      where: { id },
      include: { _count: { select: { segments: true } } },
    });
    if (!job) return reply.code(404).send({ error: "Job not found" });
    if (!job.inputKey) {
      return reply.code(400).send({ error: "Upload not complete" });
    }

    // SRT-import variant: segments were pre-populated from the user's
    // uploaded SRT, so STT is unnecessary. Jump straight to translation.
    const hasPreloadedSegments = job._count.segments > 0;

    // Run async — return immediately so client can poll status.
    void (async () => {
      if (!hasPreloadedSegments) {
        await safeRun(id, runStt);
        // If STT failed, safeRun already wrote status=FAILED with errorMessage.
        const fresh = await prisma.job.findUnique({ where: { id } });
        if (fresh?.status === "FAILED") return;
      }
      // Otherwise proceed to translation regardless of current status —
      // runTranslate flips it to TRANSLATING itself.
      await safeRun(id, runTranslate);
    })();

    return { ok: true };
  });

  /** 3. Status polling (for progress bar). */
  app.get("/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await prisma.job.findUnique({
      where: { id },
      include: { _count: { select: { segments: true } } },
    });
    if (!job) return reply.code(404).send({ error: "Not found" });
    return job;
  });

  /** 4. After auto-translation, the editor fetches the segments. */
  app.get("/jobs/:id/segments", async (request) => {
    const { id } = request.params as { id: string };
    return prisma.segment.findMany({
      where: { jobId: id },
      orderBy: { sequence: "asc" },
    });
  });

  /** 5. User edits a single segment's translated text. */
  app.patch("/segments/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = UpdateSegmentSchema.parse(request.body);
    const segment = await prisma.segment.update({
      where: { id },
      data: { translatedText: body.translatedText, edited: true },
    });
    return segment;
  });

  /**
   * 5b. Re-translate every segment with a user-supplied style instruction.
   *     Runs in the BACKGROUND (like render) — long videos would otherwise
   *     hold the HTTP connection open past proxy timeouts. The endpoint flips
   *     `refining=true` and returns 202; the editor polls GET /jobs/:id and
   *     refetches segments when `refining` clears. Only valid in EDITING.
   */
  app.post("/jobs/:id/refine", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = RefineSchema.parse(request.body);

    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) return reply.code(404).send({ error: "Job not found" });
    if (job.status !== "EDITING") {
      return reply.code(409).send({ error: `Refine хийх боломжгүй (status=${job.status})` });
    }
    if (job.refining) {
      return reply.code(409).send({ error: "Өмнөх сайжруулалт дуусаагүй байна" });
    }

    const segments = await prisma.segment.findMany({
      where: { jobId: id },
      orderBy: { sequence: "asc" },
    });
    if (segments.length === 0) {
      return reply.code(400).send({ error: "Орчуулах segment алга" });
    }
    if (segments.some((s) => !s.translatedText)) {
      return reply
        .code(400)
        .send({ error: "Орчуулга бүрэн дуусаагүй байна — refine хийх боломжгүй" });
    }

    await prisma.job.update({ where: { id }, data: { refining: true, refineError: null } });

    void (async () => {
      try {
        const refined = await refineSegments(
          segments.map((s) => s.sourceText),
          segments.map((s) => s.translatedText!),
          job.sourceLanguage,
          job.targetLanguage,
          body.prompt,
        );
        // AI-rewritten — clear `edited` (human edits will set it again), one round-trip.
        await bulkUpdateTranslations(
          refined.map((text, idx) => ({ id: segments[idx].id, text })),
          true,
        );
        await prisma.job.update({ where: { id }, data: { refining: false } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[refine] job ${id} failed:`, err);
        await prisma.job
          .update({ where: { id }, data: { refining: false, refineError: msg } })
          .catch(() => void 0);
      }
    })();

    return reply.code(202).send({ ok: true, refining: true });
  });

  /** 6. Trigger TTS + mux. Voice + style chosen here. */
  app.post("/jobs/:id/render", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = StartRenderSchema.parse(request.body);
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) return reply.code(404).send({ error: "Job not found" });

    if (body.outputMode === "dub" && !body.voiceName) {
      return reply.code(400).send({ error: "voiceName is required for dubbing" });
    }
    if (job.inputKey && isAudioInputKey(job.inputKey)) {
      return reply
        .code(400)
        .send({ error: "Audio-only job дээр video render хийхгүй. SRT-г шууд татна уу." });
    }

    await prisma.job.update({
      where: { id },
      data: {
        voiceName: body.voiceName ?? null,
        stylePrompt: body.stylePrompt ?? null,
        temperature: body.temperature ?? 1.0,
        ttsProvider: body.ttsProvider ?? "gemini",
        outputMode: body.outputMode,
        subtitleText: body.subtitleText,
        subtitleBurn: body.subtitleBurn,
        capTo1080: body.capTo1080,
        subtitleFontFamily: body.subtitleFontFamily,
        subtitleFontSize: body.subtitleFontSize,
        subtitleBold: body.subtitleBold,
        subtitleItalic: body.subtitleItalic,
        subtitleTextColor: body.subtitleTextColor,
        subtitleOutlineWidth: body.subtitleOutlineWidth,
        subtitleOutlineColor: body.subtitleOutlineColor,
        subtitleOutlineAlpha: body.subtitleOutlineAlpha,
        subtitleShadowDepth: body.subtitleShadowDepth,
        subtitleShadowColor: body.subtitleShadowColor,
        subtitleBgColor: body.subtitleBgColor ?? null,
        subtitleBgOpacity: body.subtitleBgOpacity,
        subtitleAlign: body.subtitleAlign,
        subtitleMarginHPct: body.subtitleMarginHPct,
        subtitleLetterSpacing: body.subtitleLetterSpacing,
        subtitlePosition: body.subtitlePosition,
        subtitlePositionPct: body.subtitlePositionPct,
        subtitleZhScale: body.subtitleZhScale,
        subtitleZhColor: body.subtitleZhColor ?? null,
        progress: 0,
        progressNote: null,
      },
    });

    // Run async, client polls status.
    void safeRun(id, runRender);
    return { ok: true };
  });

  /**
   * 6b. On-demand SRT generation — works in any post-translate status (EDITING
   *     onwards). Lets the user download an SRT before / without running the
   *     full render pipeline, in any of the three text modes.
   */
  app.get("/jobs/:id/srt", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { text?: string };
    const mode: "translated" | "source" | "both" =
      query.text === "source"
        ? "source"
        : query.text === "both"
          ? "both"
          : "translated";

    const segments = await prisma.segment.findMany({
      where: { jobId: id },
      orderBy: { sequence: "asc" },
    });
    if (segments.length === 0) {
      return reply.code(404).send({ error: "No segments yet" });
    }

    const lines: string[] = [];
    let cueNumber = 0;
    for (const s of segments) {
      let text: string;
      if (mode === "source") {
        text = s.sourceText.trim();
      } else if (mode === "both") {
        text = `${s.sourceText.trim()}\n${(s.translatedText ?? "").trim()}`.trim();
      } else {
        text = (s.translatedText ?? "").trim();
      }
      if (!text) continue;
      cueNumber++;
      lines.push(String(cueNumber));
      lines.push(`${formatSrtTime(s.startSec)} --> ${formatSrtTime(s.endSec)}`);
      lines.push(text);
      lines.push("");
    }
    if (cueNumber === 0) {
      return reply.code(409).send({ error: "Сонгосон горимд харгалзах текст байхгүй" });
    }
    const srt = lines.join("\n");

    return reply
      .header("content-type", "application/x-subrip; charset=utf-8")
      .header(
        "content-disposition",
        `attachment; filename="dubme-${id.slice(0, 8)}-${mode}.srt"`,
      )
      .send(srt);
  });

  /** 7. Once DONE, the client fetches the final download URLs. */
  app.get("/jobs/:id/download", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) return reply.code(404).send({ error: "Not found" });
    if (job.status !== "DONE") {
      return reply.code(409).send({ error: `Job not done (${job.status})` });
    }
    return jobDownloadUrls(id);
  });

  /** 8. List recent jobs (for a simple admin view). */
  app.get("/jobs", async () => {
    return prisma.job.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  });

  /**
   * 9. Stream URLs for in-browser preview without forcing a download.
   *    Returns presigned URLs for any artifacts that exist on this job:
   *      - input  : the raw uploaded video (so the editor can show a player)
   *      - output : the dubbed video (for DONE jobs)
   *      - audio  : the extracted source audio
   *      - subtitle : the SRT
   *
   *    The browser embeds these in <video src=...> / <audio src=...>.
   *    URLs expire after 1 hour, so the page should re-fetch on stale 403s.
   */
  app.get("/jobs/:id/preview", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) return reply.code(404).send({ error: "Not found" });

    const out: Record<string, string> = {};
    if (job.inputKey) out.input = await presignDownload(job.inputKey);
    if (job.outputKey) out.output = await presignDownload(job.outputKey);
    if (job.audioKey) out.audio = await presignDownload(job.audioKey);
    if (job.subtitleKey) out.subtitle = await presignDownload(job.subtitleKey);
    return out;
  });

  /**
   * 10. Stream URL for ONE segment's TTS audio — used by the editor to let
   *     users listen to each Mongolian segment before final render.
   *     Returns 404 if the segment hasn't been synthesized yet.
   */
  app.get("/segments/:id/audio", async (request, reply) => {
    const { id } = request.params as { id: string };
    const segment = await prisma.segment.findUnique({ where: { id } });
    if (!segment) return reply.code(404).send({ error: "Segment not found" });
    if (!segment.audioKey) {
      return reply.code(404).send({ error: "Segment audio not synthesized yet" });
    }
    const url = await presignDownload(segment.audioKey);
    return { url };
  });
}

function guessContentType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mkv")) return "video/x-matroska";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  return "application/octet-stream";
}

function extensionFor(contentType: string): string {
  switch (contentType) {
    case "video/mp4": return ".mp4";
    case "video/quicktime": return ".mov";
    case "video/webm": return ".webm";
    case "video/x-matroska": return ".mkv";
    case "audio/mpeg": return ".mp3";
    case "audio/wav": return ".wav";
    case "audio/mp4": return ".m4a";
    case "audio/ogg": return ".ogg";
    default: return "";
  }
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
