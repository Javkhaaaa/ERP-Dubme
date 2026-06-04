import { config } from "../config.js";

/**
 * Gemini Flash TTS — same approach as Whisperly desktop app.
 * Uses raw fetch instead of @google/genai because the SDK doesn't yet expose
 * TTS-specific config (responseModalities + speechConfig).
 *
 * Returns a WAV buffer (24kHz mono, 16-bit PCM with header).
 */
const ENDPOINT_FMT =
  "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent";

const DEFAULT_MODEL = "gemini-3.1-flash-tts-preview";

export interface TtsOptions {
  text: string;
  voiceName: string; // e.g. "Kore", "Charon", "Aoede"
  stylePrompt?: string;
  temperature?: number;
  model?: string;
}

export async function synthesize(opts: TtsOptions): Promise<Buffer> {
  if (!opts.text.trim()) throw new Error("Empty text");
  if (!opts.voiceName) throw new Error("voiceName required");

  // Style is delivered via prompt prefix — same approach AI Studio uses.
  const prompt = opts.stylePrompt?.trim()
    ? `${opts.stylePrompt.trim()}: ${opts.text}`
    : opts.text;

  const url = ENDPOINT_FMT.replace("{model}", opts.model ?? DEFAULT_MODEL);

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: opts.voiceName },
        },
      },
      ...(opts.temperature !== undefined && { temperature: opts.temperature }),
    },
  };

  // Gemini TTS preview is rate-limited even on paid tiers and occasionally
  // returns transient 499/500. Retry generously with backoff.
  const maxAttempts = 6;
  let lastErr = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": config.geminiApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (resp.ok) {
      const data = (await resp.json()) as GeminiTtsResponse;
      const part = data.candidates?.[0]?.content?.parts?.[0];
      const inline = part?.inlineData;
      if (!inline) {
        const reason = data.candidates?.[0]?.finishReason ?? "unknown";
        throw new Error(`Gemini returned no audio (finishReason: ${reason})`);
      }
      const pcm = Buffer.from(inline.data, "base64");
      const sampleRate = parseSampleRate(inline.mimeType) ?? 24_000;
      return wrapPcmAsWav(pcm, sampleRate, 1);
    }

    const errText = await resp.text();
    lastErr = `HTTP ${resp.status}: ${errText}`;

    // Retryable: 429 (rate limit), 499 (cancelled — Gemini overloaded),
    // 500 / 502 / 503 / 504 (transient server errors).
    const retryable =
      resp.status === 429 ||
      resp.status === 499 ||
      resp.status === 500 ||
      resp.status === 502 ||
      resp.status === 503 ||
      resp.status === 504;

    if (retryable && attempt < maxAttempts) {
      // 429 carries a retryDelay; for others use exponential backoff.
      const waitMs =
        parseRetryDelayMs(errText) ?? Math.min(2_000 * 2 ** (attempt - 1), 30_000);
      console.warn(
        `[gemini-tts] HTTP ${resp.status} (attempt ${attempt}/${maxAttempts}), retrying in ${Math.round(waitMs)}ms`,
      );
      await sleep(waitMs);
      continue;
    }
    throw new Error(`Gemini TTS ${lastErr}`);
  }
  throw new Error(`Gemini TTS retry exhausted (${maxAttempts}x): ${lastErr}`);
}

function parseRetryDelayMs(errText: string): number | undefined {
  // Response includes: "details": [{ "@type": "...RetryInfo", "retryDelay": "13s" }]
  const m = errText.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (m) {
    return Math.ceil(Number.parseFloat(m[1]) * 1000) + 500; // small safety margin
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ─── helpers ─────────────────────────────────────────────────────────── */

interface GeminiTtsResponse {
  candidates?: {
    content?: { parts?: { inlineData?: { mimeType: string; data: string } }[] };
    finishReason?: string;
  }[];
}

function parseSampleRate(mimeType: string): number | undefined {
  for (const seg of mimeType.split(";")) {
    const trimmed = seg.trim();
    if (trimmed.startsWith("rate=")) {
      const n = Number.parseInt(trimmed.slice(5), 10);
      if (!Number.isNaN(n)) return n;
    }
  }
}

/**
 * Prepend a 44-byte WAV/RIFF header to raw 16-bit signed PCM.
 * Equivalent to the Rust impl in Whisperly — keep them in sync if changed.
 */
function wrapPcmAsWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const chunkSize = 36 + dataSize;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(chunkSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}
