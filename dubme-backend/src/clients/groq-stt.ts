import Groq from "groq-sdk";
import { createReadStream } from "node:fs";
import { config } from "../config.js";

const groq = new Groq({ apiKey: config.groqApiKey });

export interface SttSegment {
  start: number; // seconds
  end: number;
  text: string;
}

export interface SttResult {
  language: string;
  fullText: string;
  segments: SttSegment[];
}

/**
 * Transcribe an audio file with Groq's Whisper-large-v3.
 * `verbose_json` returns segment-level timestamps which we need
 * to align Mongolian TTS back to the original timeline.
 */
export async function transcribe(
  audioPath: string,
  language?: string,
): Promise<SttResult> {
  const transcription = await groq.audio.transcriptions.create({
    file: createReadStream(audioPath),
    model: "whisper-large-v3",
    response_format: "verbose_json",
    language, // ISO 639-1 — pass "zh" for Chinese; omit for auto-detect
    temperature: 0,
  });

  // Cast — the SDK types don't fully reflect verbose_json shape.
  const v = transcription as unknown as {
    text: string;
    language: string;
    segments?: { start: number; end: number; text: string }[];
  };

  const rawSegments = (v.segments ?? []).map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text.trim(),
  }));
  const cleaned = filterHallucinations(rawSegments);

  return {
    language: v.language,
    fullText: cleaned.map((s) => s.text).join(" "),
    segments: cleaned,
  };
}

/**
 * Common Whisper Chinese-spam patterns. These show up when Whisper "fills in"
 * silence, music, or noise with phrases scraped from its training data
 * (YouTube subscribe asks, donation pleas, fansub credits, etc).
 *
 * Pattern hits are dropped from the segment list — they're never real audio.
 * Patterns are case-insensitive and match anywhere in the cleaned line.
 */
const HALLUCINATION_PATTERNS: RegExp[] = [
  // YouTube / streaming spam
  /请订阅|请订阅本频道|点赞.*订阅|订阅.*点赞|喜欢.*请订阅|订阅频道|订阅我们/,
  /感谢观看|多谢观看|谢谢观看|感谢收看|感谢您的观看/,
  /欢迎收看|欢迎观看(?!.{4,})/, // bare "欢迎观看" by itself
  /字幕组|字幕\s*by|字幕\s*翻译|字幕制作|压制\s*by/,
  /MyGO|Amara\.org|amara\.org/i,
  /翻译\s*[:：]?\s*\w{2,}$/,
  /如果.*喜欢.*请.*订阅/,
  /中文字幕由|英文字幕由/,
  // English equivalents Whisper sometimes emits on Chinese audio
  /thanks for watching/i,
  /please subscribe/i,
  /like and subscribe/i,
  /subtitle(s)? by/i,
];

function filterHallucinations(segs: SttSegment[]): SttSegment[] {
  const out: SttSegment[] = [];
  let dropped = 0;
  for (const s of segs) {
    if (HALLUCINATION_PATTERNS.some((p) => p.test(s.text))) {
      dropped++;
      continue;
    }
    out.push(s);
  }
  if (dropped > 0) {
    console.log(`[stt] dropped ${dropped} hallucinated segment(s)`);
  }
  return out;
}
