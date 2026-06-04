import { spawn } from "node:child_process";

/**
 * Thin wrapper around the `yt-dlp` CLI for downloading videos from
 * YouTube, Bilibili, Vimeo and ~1000 other streaming sites that don't
 * expose a direct file URL.
 *
 * yt-dlp must be installed on the server (`brew install yt-dlp` on macOS,
 * `pip install yt-dlp` elsewhere). `hasYtDlp()` probes once and caches.
 */

let ytDlpAvailable: boolean | null = null;

export async function hasYtDlp(): Promise<boolean> {
  if (ytDlpAvailable !== null) return ytDlpAvailable;
  ytDlpAvailable = await new Promise<boolean>((resolve) => {
    const proc = spawn("yt-dlp", ["--version"]);
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
  return ytDlpAvailable;
}

/**
 * Domains that definitely need yt-dlp. We could check a longer list, but
 * the safer fallback for unknown URLs without a video file extension is to
 * try yt-dlp too — yt-dlp supports ~1000 sites and fails cleanly when it
 * doesn't recognize one.
 */
const STREAMING_HOST_RE =
  /(?:^|\.)(?:youtube\.com|youtu\.be|youtube-nocookie\.com|m\.youtube\.com|vimeo\.com|player\.vimeo\.com|bilibili\.com|b23\.tv|youku\.com|iqiyi\.com|qq\.com|v\.qq\.com|tiktok\.com|douyin\.com|twitter\.com|x\.com|dailymotion\.com|facebook\.com|fb\.watch|instagram\.com|reddit\.com|twitch\.tv|soundcloud\.com)$/i;

/**
 * Heuristic: should this URL be downloaded via yt-dlp rather than a plain
 * HTTP GET? True for streaming sites, OR any URL whose path doesn't end in
 * a known video file extension.
 */
export function looksLikeStreamingSite(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (STREAMING_HOST_RE.test(url.hostname)) return true;
    const path = url.pathname.toLowerCase();
    const hasVideoExt = /\.(mp4|mov|webm|mkv|m4v|avi|flv|ts)(?:$|\?)/.test(
      path,
    );
    // No recognizable video extension → assume it's a streaming page that
    // needs yt-dlp to extract the real media URL.
    return !hasVideoExt;
  } catch {
    return false;
  }
}

export interface YtDlpProgress {
  /** 0-100 (-1 if yt-dlp didn't emit a parseable value). */
  percent: number;
  /** Human-readable line as yt-dlp printed it. */
  raw: string;
}

/**
 * Download a video via yt-dlp to `outPath`. Caps resolution at 1080p so we
 * don't burn API/CPU time on 4K streams that get downscaled to 720p subtitle
 * burns anyway. Output is always a single mp4 (yt-dlp will fetch separate
 * video+audio streams and mux them via ffmpeg automatically).
 *
 * onProgress is called with each parsed progress line — useful for
 * surfacing download % to the user (otherwise progress only shows in logs).
 */
export function downloadVideo(
  url: string,
  outPath: string,
  onProgress?: (p: YtDlpProgress) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      // Best video ≤1080p + best audio, merged into a single mp4.
      "-f", "bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b",
      "--merge-output-format", "mp4",
      // Re-mux non-mp4 outputs (e.g. webm) into mp4 so downstream ffmpeg
      // handles them uniformly.
      "--remux-video", "mp4",
      // Predictable output path — no template substitution.
      "-o", outPath,
      // Quiet structured progress lines we can parse.
      "--newline",
      "--no-warnings",
      // Don't fail on age-gates / geo-restrictions silently — give a clear error.
      "--no-playlist",
      url,
    ];

    const proc = spawn("yt-dlp", args);
    let stderrTail = "";

    proc.stdout.on("data", (chunk) => {
      const lines = chunk.toString().split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        if (line.startsWith("[download]")) {
          const pctMatch = line.match(/(\d+(?:\.\d+)?)%/);
          const percent = pctMatch ? Number(pctMatch[1]) : -1;
          onProgress?.({ percent, raw: line });
          if (pctMatch) {
            // Throttle log spam — only log every ~5% via percent rounding.
            const rounded = Math.floor(percent / 5) * 5;
            if (rounded !== lastLoggedPct) {
              lastLoggedPct = rounded;
              console.log(`[yt-dlp] ${line.trim()}`);
            }
          }
        } else {
          console.log(`[yt-dlp] ${line.trim()}`);
        }
      }
    });

    let lastLoggedPct = -1;
    proc.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      stderrTail = (stderrTail + s).slice(-2000);
      // yt-dlp prints some informational stuff to stderr — log it too.
      for (const line of s.split("\n")) {
        if (line.trim()) console.log(`[yt-dlp] ${line.trim()}`);
      }
    });

    proc.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            "yt-dlp командыг олж чадсангүй. YouTube/Bilibili гэх мэт сайтаас " +
              "татахын тулд yt-dlp суулгасан байх ёстой: `brew install yt-dlp`.",
          ),
        );
      } else {
        reject(err);
      }
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `yt-dlp exited ${code}: ${stderrTail.slice(-500) || "<no stderr>"}`,
          ),
        );
      }
    });
  });
}
