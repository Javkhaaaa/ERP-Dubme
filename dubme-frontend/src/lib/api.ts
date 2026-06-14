/**
 * Thin client for the dubme API.
 * Browser-side; uses NEXT_PUBLIC_API_URL.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export type JobStatus =
  | "UPLOADED"
  | "DOWNLOADING"
  | "EXTRACTING"
  | "TRANSCRIBING"
  | "TRANSLATING"
  | "EDITING"
  | "SYNTHESIZING"
  | "MUXING"
  | "DONE"
  | "FAILED";

export type OutputMode = "dub" | "subtitle";
export type SubtitleText = "translated" | "source" | "both";
export type SubtitlePosition = "top" | "middle" | "bottom";
export type SubtitleAlign = "left" | "center" | "right";

/** Reference height all subtitle px values are expressed in (matches backend). */
export const SUBTITLE_REF_HEIGHT = 1080;

export interface Job {
  id: string;
  status: JobStatus;
  sourceLanguage: string;
  targetLanguage: string;
  voiceName: string | null;
  outputMode: OutputMode;
  subtitleText: SubtitleText;
  subtitleBurn: boolean;
  capTo1080: boolean;
  // Subtitle style (sizes are px @ 1080p reference)
  subtitleFontFamily: string;
  subtitleFontSize: number;
  subtitleBold: boolean;
  subtitleItalic: boolean;
  subtitleTextColor: string;
  subtitleOutlineWidth: number;
  subtitleOutlineColor: string;
  subtitleOutlineAlpha: number;
  subtitleShadowDepth: number;
  subtitleShadowColor: string;
  subtitleBgColor: string | null;
  subtitleBgOpacity: number;
  subtitleAlign: SubtitleAlign;
  subtitleMarginHPct: number;
  subtitleLetterSpacing: number;
  subtitlePosition: SubtitlePosition;
  subtitlePositionPct: number;
  subtitleZhScale: number;
  subtitleZhColor: string | null;
  inputKey: string | null;
  outputKey: string | null;
  subtitleKey: string | null;
  errorMessage: string | null;
  progress: number | null;
  progressNote: string | null;
  refining: boolean;
  refineError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Segment {
  id: string;
  jobId: string;
  sequence: number;
  startSec: number;
  endSec: number;
  sourceText: string;
  translatedText: string | null;
  audioKey: string | null;
  /** Detected emotion ("neutral" | "happy" | "excited" | "calm" | "sad" | ...). */
  emotion: string | null;
  /** Free-form TTS style hint — what the AI thinks the voice should sound like. */
  style: string | null;
  edited: boolean;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // Only set the JSON content-type when we're actually sending a body —
  // Fastify rejects POSTs that declare application/json without a body.
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${path} ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function createJob(
  filename: string,
  sourceLanguage = "zh",
): Promise<{
  jobId: string;
  uploadUrl: string;
  inputKey: string;
  contentType: string;
}> {
  return api("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ filename, sourceLanguage }),
  });
}

export async function uploadToS3(
  uploadUrl: string,
  file: File,
  contentType: string,
  onProgress?: (pct: number) => void,
): Promise<void> {
  // We use XHR (not fetch) because fetch can't stream upload progress yet in browsers.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress((e.loaded / e.total) * 100);
      }
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed: ${xhr.status} ${xhr.responseText}`));
    xhr.onerror = () => reject(new Error("Upload network error"));
    xhr.send(file);
  });
}

export async function startJob(jobId: string): Promise<void> {
  await api(`/api/jobs/${jobId}/start`, { method: "POST" });
}

/**
 * Skip the browser-upload round-trip — server downloads the video from the
 * given URL directly into S3, then runs STT + translate as normal.
 */
export async function createJobFromUrl(
  url: string,
  sourceLanguage = "zh",
): Promise<{ jobId: string }> {
  return api("/api/jobs/from-url", {
    method: "POST",
    body: JSON.stringify({ url, sourceLanguage }),
  });
}

/**
 * Skip STT entirely — server uses the supplied SRT cues as the segment list,
 * downloads the video from URL, runs translate, lands in EDITING.
 */
export async function createJobFromSrt(
  videoUrl: string,
  srtContent: string,
  sourceLanguage = "zh",
): Promise<{ jobId: string; segmentCount: number }> {
  return api("/api/jobs/from-srt", {
    method: "POST",
    body: JSON.stringify({ videoUrl, srtContent, sourceLanguage }),
  });
}

/**
 * Same as createJobFromSrt but the video is uploaded directly from the
 * browser (presigned PUT) instead of fetched from a URL. Returns a
 * presigned URL the browser should PUT the video to, then it calls
 * startJob(jobId) like the normal upload flow.
 */
export async function createJobFromSrtUpload(
  filename: string,
  srtContent: string,
  sourceLanguage = "zh",
): Promise<{
  jobId: string;
  uploadUrl: string;
  inputKey: string;
  contentType: string;
  segmentCount: number;
}> {
  return api("/api/jobs/from-srt-upload", {
    method: "POST",
    body: JSON.stringify({ filename, srtContent, sourceLanguage }),
  });
}

/**
 * Translate-only: SRT in source language → translated SRT, no video at all.
 * Server creates a job with inputKey=null, populates segments from the SRT,
 * runs translate, lands in EDITING. User edits + downloads the translated
 * SRT from the in-editor bar. No render step is possible/needed.
 */
export async function createJobFromSrtOnly(
  srtContent: string,
  sourceLanguage = "zh",
): Promise<{ jobId: string; segmentCount: number }> {
  return api("/api/jobs/from-srt-only", {
    method: "POST",
    body: JSON.stringify({ srtContent, sourceLanguage }),
  });
}

export async function getJob(jobId: string): Promise<Job> {
  return api(`/api/jobs/${jobId}`);
}

export async function getSegments(jobId: string): Promise<Segment[]> {
  return api(`/api/jobs/${jobId}/segments`);
}

export async function updateSegment(
  segmentId: string,
  translatedText: string,
): Promise<Segment> {
  return api(`/api/segments/${segmentId}`, {
    method: "PATCH",
    body: JSON.stringify({ translatedText }),
  });
}

/**
 * Ask the backend to rewrite every translation in this job according to a
 * user-supplied style instruction. Runs in the BACKGROUND — returns
 * immediately (202); poll the job until `refining` clears, then refetch
 * segments. (No longer returns the segment list synchronously.)
 */
export async function refineTranslations(
  jobId: string,
  prompt: string,
): Promise<{ ok: boolean; refining: boolean }> {
  return api(`/api/jobs/${jobId}/refine`, {
    method: "POST",
    body: JSON.stringify({ prompt }),
  });
}

export interface RenderOptions {
  /** "dub" replaces the audio via TTS; "subtitle" only generates subtitles. */
  outputMode: OutputMode;
  /** Which text the subtitle shows. */
  subtitleText: SubtitleText;
  /** Burn the subtitle onto the video (hardsub) in addition to the SRT file. */
  subtitleBurn: boolean;
  /** Downscale output to 1080p before burning (big speed win on 4K). */
  capTo1080?: boolean;
  // Subtitle style (sizes/widths are px @ 1080p reference). Applied when burning.
  subtitleFontFamily?: string;
  subtitleFontSize?: number;
  subtitleBold?: boolean;
  subtitleItalic?: boolean;
  subtitleTextColor?: string;
  subtitleOutlineWidth?: number;
  subtitleOutlineColor?: string;
  subtitleOutlineAlpha?: number;
  subtitleShadowDepth?: number;
  subtitleShadowColor?: string;
  subtitleBgColor?: string | null;
  subtitleBgOpacity?: number;
  subtitleAlign?: SubtitleAlign;
  subtitleMarginHPct?: number;
  subtitleLetterSpacing?: number;
  subtitlePosition?: SubtitlePosition;
  /** 0-100, vertical position as % from top (bottom edge of text block). */
  subtitlePositionPct?: number;
  subtitleZhScale?: number;
  subtitleZhColor?: string | null;
  /** Required only when outputMode === "dub". */
  voiceName?: string;
  ttsProvider?: "gemini" | "chimege";
  stylePrompt?: string;
  temperature?: number;
}

export async function startRender(
  jobId: string,
  opts: RenderOptions,
): Promise<void> {
  await api(`/api/jobs/${jobId}/render`, {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

export async function getDownloadUrls(
  jobId: string,
): Promise<{ output?: string; subtitle?: string }> {
  return api(`/api/jobs/${jobId}/download`);
}

export async function listJobs(): Promise<Job[]> {
  return api("/api/jobs");
}

/**
 * Get presigned streaming URLs for any artifacts of a job.
 * Used to embed <video> and <audio> previews without forcing downloads.
 * URLs expire after ~1 hour.
 */
export async function getPreviewUrls(jobId: string): Promise<{
  input?: string;
  output?: string;
  audio?: string;
  subtitle?: string;
}> {
  return api(`/api/jobs/${jobId}/preview`);
}

/** Get a presigned URL for a single segment's TTS audio (for in-editor preview). */
export async function getSegmentAudioUrl(segmentId: string): Promise<string> {
  const r = await api<{ url: string }>(`/api/segments/${segmentId}/audio`);
  return r.url;
}

/**
 * Direct URL to the on-demand SRT for this job in the given text mode.
 * Returns a string the browser can plug into an <a href download> — no
 * fetch indirection, the browser streams the response and saves the file.
 */
export function jobSrtDownloadUrl(
  jobId: string,
  mode: SubtitleText = "translated",
): string {
  return `${API_URL}/api/jobs/${jobId}/srt?text=${mode}`;
}
