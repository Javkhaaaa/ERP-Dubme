import { config } from "../config.js";

/**
 * ElevenLabs Text-to-Speech.
 *
 * Docs: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
 * Endpoint: POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}
 * Header:   xi-api-key
 * Body:     { text, model_id, voice_settings }
 * Output:   we request wav_44100 so the pipeline's ffmpeg steps read it directly.
 *
 * IMPORTANT (honesty): Mongolian is NOT on ElevenLabs' officially-supported
 * TTS language list. The v3 model will still ATTEMPT to read Mongolian Cyrillic,
 * but quality (Ө/Ү phonemes, accent, number reading) is not guaranteed and may
 * vary run-to-run. This provider exists so it can be A/B-tested against the
 * Mongolian-native Chimege voice — keep Chimege as the reliable fallback.
 *
 * Eleven v3's strength is expressive delivery via inline "audio tags"
 * (`[excited]`, `[whispers]`, `[sad]`, …). We map each segment's detected
 * `emotion` to a tag so the dub follows the original actor's emotion.
 */
const ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";

/** A few stable, pre-made library voices (exist on every account) for testing.
 *  Users can also paste any custom/cloned voice ID. */
export const ELEVENLABS_VOICES = [
  { value: "21m00Tcm4TlvDq8ikWAM", label: "Rachel (эмэгтэй, тайван) ⭐" },
  { value: "EXAVITQu4vr4xnSDxMaL", label: "Bella (эмэгтэй, зөөлөн)" },
  { value: "AZnzlk1XvdvUeBnXmlld", label: "Domi (эмэгтэй, эрч хүчтэй)" },
  { value: "MF3mGyEYCl7XYWbV9V6O", label: "Elli (эмэгтэй, залуу)" },
  { value: "pNInz6obpgDQGcFmaJgB", label: "Adam (эрэгтэй, гүн)" },
  { value: "ErXwobaYiN019PkySvjV", label: "Antoni (эрэгтэй, дулаан)" },
  { value: "TxGEqnHWrfWFTfGW9XjX", label: "Josh (эрэгтэй, залуу)" },
  { value: "VR6AewLTigWG4xSOukaG", label: "Arnold (эрэгтэй, хатуу)" },
] as const;

/** Map a detected emotion to an Eleven v3 audio tag (empty = no tag). */
const EMOTION_TAG: Record<string, string> = {
  happy: "[happy]",
  joyful: "[happy]",
  excited: "[excited]",
  sad: "[sad]",
  sorrowful: "[sad]",
  angry: "[angry]",
  furious: "[angry]",
  calm: "[calm]",
  nervous: "[nervous]",
  fearful: "[nervous]",
  anxious: "[nervous]",
  scared: "[nervous]",
  surprised: "[surprised]",
  curious: "[curious]",
  serious: "[serious]",
  whisper: "[whispers]",
  shouting: "[shouts]",
  neutral: "",
};

function emotionToTag(emotion?: string | null): string {
  if (!emotion) return "";
  return EMOTION_TAG[emotion.trim().toLowerCase()] ?? "";
}

export interface ElevenLabsTtsOptions {
  text: string;
  voiceId: string;
  /** Detected emotion for this segment → mapped to a v3 audio tag. */
  emotion?: string | null;
  /** Model id. v3 = expressive + audio tags. Override via ELEVENLABS_MODEL. */
  model?: string;
  /** voice_settings */
  stability?: number; // 0-1 (lower = more expressive). default 0.5
  similarityBoost?: number; // 0-1. default 0.75
  style?: number; // 0-1 exaggeration. default 0
  speed?: number; // 0.7-1.2. default 1.0
}

export async function synthesizeElevenLabs(opts: ElevenLabsTtsOptions): Promise<Buffer> {
  if (!opts.text.trim()) throw new Error("Empty text");
  if (!opts.voiceId) throw new Error("voiceId required");
  if (!config.elevenLabsApiKey) {
    throw new Error(
      "ELEVENLABS_API_KEY тохируулаагүй байна. elevenlabs.io → API дээрээс key авч .env-д нэмнэ үү.",
    );
  }

  const model = opts.model ?? config.elevenLabsModel;
  // Audio tags only work on v3; for other models prepend nothing.
  const tag = model.includes("v3") ? emotionToTag(opts.emotion) : "";
  const text = tag ? `${tag} ${opts.text.trim()}` : opts.text.trim();

  const url = `${ENDPOINT}/${encodeURIComponent(opts.voiceId)}?output_format=wav_44100`;
  const body = {
    text,
    model_id: model,
    voice_settings: {
      stability: opts.stability ?? 0.5,
      similarity_boost: opts.similarityBoost ?? 0.75,
      style: opts.style ?? 0,
      speed: opts.speed ?? 1.0,
      use_speaker_boost: true,
    },
  };

  const maxAttempts = 4;
  let lastErr = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": config.elevenLabsApiKey,
        "Content-Type": "application/json",
        accept: "audio/wav",
      },
      body: JSON.stringify(body),
    });

    if (resp.ok) {
      const ab = await resp.arrayBuffer();
      return Buffer.from(ab);
    }

    const errText = await resp.text().catch(() => "");
    lastErr = `HTTP ${resp.status}: ${errText.slice(0, 300)}`;
    const retriable = resp.status === 429 || resp.status >= 500;
    if (!retriable || attempt === maxAttempts) {
      throw new Error(`ElevenLabs TTS ${lastErr}`);
    }
    const waitMs = Math.min(2_000 * 2 ** (attempt - 1), 20_000);
    console.warn(
      `[elevenlabs-tts] HTTP ${resp.status} (attempt ${attempt}/${maxAttempts}), retrying in ${waitMs}ms`,
    );
    await new Promise((r) => setTimeout(r, waitMs));
  }
  throw new Error(`ElevenLabs TTS retry exhausted: ${lastErr}`);
}
