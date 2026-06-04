import { config } from "../config.js";

/**
 * Chimege /synthesize — Mongolian-native TTS from chimege.com.
 *
 * Docs: https://docs.api.chimege.com/v1.2/en/
 * Endpoint: POST https://api.chimege.com/v1.2/synthesize
 * Headers:
 *   token       — API key (separate from /transcribe and /stt-long tokens)
 *   voice-id    — FEMALE1..5v2, MALE1..4v2 (see VOICES below)
 *   speed       — 0.2..4 (default 1)
 *   pitch       — 0.2..6 (default 1)
 *   sample-rate — 8000 / 16000 / 22050 (default 22050)
 * Body: text/plain (the Mongolian text)
 * Response: audio/x-wav (PCM WAV)
 *
 * Returns the raw WAV bytes from Chimege. The voice is trained on Mongolian
 * speech so the output sounds significantly more native than any general-
 * purpose multilingual TTS.
 */
const ENDPOINT = "https://api.chimege.com/v1.2/synthesize";

export const CHIMEGE_VOICES = [
  { value: "FEMALE1", label: "FEMALE1 (эмэгтэй, сонгодог)" },
  { value: "FEMALE1v2", label: "FEMALE1v2 (эмэгтэй, тод)" },
  { value: "FEMALE2v2", label: "FEMALE2v2 (эмэгтэй, дунд нас)" },
  { value: "FEMALE3v2", label: "FEMALE3v2 (эмэгтэй, дулаан) ⭐" },
  { value: "FEMALE4v2", label: "FEMALE4v2 (эмэгтэй, шинэхэн)" },
  { value: "FEMALE5v2", label: "FEMALE5v2 (эмэгтэй, нам)" },
  { value: "MALE1", label: "MALE1 (эрэгтэй, сонгодог)" },
  { value: "MALE1v2", label: "MALE1v2 (эрэгтэй, тогтуун)" },
  { value: "MALE2v2", label: "MALE2v2 (эрэгтэй, залуу)" },
  { value: "MALE3v2", label: "MALE3v2 (эрэгтэй, дунд нас)" },
  { value: "MALE4v2", label: "MALE4v2 (эрэгтэй, дулаан)" },
] as const;

export interface ChimegeTtsOptions {
  text: string;
  voiceId: string; // one of CHIMEGE_VOICES values
  speed?: number;  // 0.2..4 (default 1.0)
  pitch?: number;  // 0.2..6 (default 1.0)
  sampleRate?: 8000 | 16000 | 22050;
}

export async function synthesizeChimege(opts: ChimegeTtsOptions): Promise<Buffer> {
  if (!opts.text.trim()) throw new Error("Empty text");
  if (!opts.voiceId) throw new Error("voiceId required");
  if (!config.chimegeTtsToken) {
    throw new Error(
      "CHIMEGE_TTS_TOKEN not set in environment. Get a /synthesize token from chimege.com.",
    );
  }

  // Chimege only accepts Cyrillic + a tiny set of punctuation. Strip out
  // anything else so a stray digit or paren doesn't fail the whole job.
  const cleaned = sanitizeForChimege(opts.text);
  if (!cleaned.trim()) {
    throw new Error(
      "После sanitization-ийн дараа текст хоосон болсон. Орчуулга кирилл биш байсан байх магадлалтай.",
    );
  }

  // Surface significant losses so the user/operator can spot bad translation
  // output. >5% character drop suggests Gemini ignored the Cyrillic-only rule.
  const lostChars = opts.text.length - cleaned.length;
  if (lostChars > 0 && lostChars / opts.text.length > 0.05) {
    console.warn(
      `[chimege-tts] sanitizer dropped ${lostChars}/${opts.text.length} chars ` +
        `(${((lostChars / opts.text.length) * 100).toFixed(0)}%). ` +
        `Original: "${opts.text.slice(0, 80)}..." Cleaned: "${cleaned.slice(0, 80)}..."`,
    );
  }

  const headers: Record<string, string> = {
    Token: config.chimegeTtsToken,
    "Content-Type": "text/plain",
    "voice-id": opts.voiceId,
  };
  if (opts.speed !== undefined) headers["speed"] = String(opts.speed);
  if (opts.pitch !== undefined) headers["pitch"] = String(opts.pitch);
  if (opts.sampleRate !== undefined)
    headers["sample-rate"] = String(opts.sampleRate);

  // Retry transient errors (network blips, 429, 5xx). Chimege rate limit is
  // generous on /synthesize but throttling can still happen during spikes.
  const maxAttempts = 4;
  let lastErr = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await fetch(ENDPOINT, {
      method: "POST",
      headers,
      body: cleaned,
    });

    if (resp.ok) {
      const ab = await resp.arrayBuffer();
      return Buffer.from(ab);
    }

    const errCode = resp.headers.get("error-code") ?? "";
    const body = await resp.text().catch(() => "");
    lastErr = `HTTP ${resp.status} ${describeError(errCode)}: ${body.slice(0, 200)}`;

    const retriable = resp.status === 429 || resp.status >= 500;
    if (!retriable || attempt === maxAttempts) {
      throw new Error(`Chimege TTS ${lastErr}`);
    }
    const waitMs = Math.min(2_000 * 2 ** (attempt - 1), 15_000);
    console.warn(
      `[chimege-tts] HTTP ${resp.status} (attempt ${attempt}/${maxAttempts}), retrying in ${waitMs}ms`,
    );
    await new Promise((r) => setTimeout(r, waitMs));
  }
  throw new Error(`Chimege TTS retry exhausted: ${lastErr}`);
}

/**
 * Reduce arbitrary text to the alphabet Chimege accepts:
 *   • Cyrillic letters (А-Я а-я Ёё, plus the Mongolian-only Үү Өө)
 *   • Spaces
 *   • Punctuation: . , ? ! - ' " :
 *
 * Strategy:
 *   1. Map common "near-equivalents" to allowed punctuation
 *      ( ; → , ; () → ,  ; / → space ; etc. )
 *   2. Convert standalone Arabic numbers to a placeholder so they don't
 *      slip through (Gemini should have written them as words but we
 *      defend against drift).
 *   3. Drop anything else outside the allowed set.
 *   4. Collapse whitespace.
 */
export function sanitizeForChimege(input: string): string {
  let s = input;

  // ── 1. Replace equivalents ─────────────────────────────────────────
  s = s
    .replace(/[;]/g, ",")
    .replace(/[()\[\]{}]/g, ",")
    .replace(/[/\\|]/g, " ")
    .replace(/[—–]/g, "-")       // em/en dash → hyphen
    .replace(/[“”«»]/g, '"')     // smart quotes → ascii double
    .replace(/[‘’]/g, "'")       // smart apostrophes → ascii single
    .replace(/…/g, "...");

  // ── 2. Drop standalone digit runs (Gemini was told to spell them) ───
  // Keep digits *inside* words alone (rare in Mongolian).
  s = s.replace(/\d+/g, "");

  // ── 3. Whitelist filter ────────────────────────────────────────────
  // Allowed: Cyrillic Unicode range U+0400–U+04FF (covers Mongolian
  // additions like Үү Өө), whitespace, and the punctuation Chimege lists.
  s = s.replace(/[^Ѐ-ӿ\s.,?!\-'":]/g, "");

  // ── 4. Collapse whitespace + double-punctuation artefacts ──────────
  s = s
    .replace(/\s+/g, " ")
    .replace(/,\s*,+/g, ",")
    .replace(/\s+([.,?!:])/g, "$1")
    .trim();

  return s;
}

function describeError(code: string): string {
  switch (code) {
    case "1000": return "Invalid API token";
    case "1001": return "Token missing";
    case "1002": return "Inactive token";
    case "1003": return "Suspended token";
    case "4000": return "Bad input text";
    case "4001": return "Text too short (min 2 chars)";
    case "4002": return "Text too long (max 300 chars per call)";
    case "4003": return "Invalid voice-id";
    case "4004": return "Invalid speed (0.2..4)";
    case "4005": return "Text has special characters not allowed";
    case "4007": return "Invalid sample-rate (8000/16000/22050)";
    case "4008": return "Invalid pitch (0.2..6)";
    default: return code ? `error-code ${code}` : "";
  }
}
