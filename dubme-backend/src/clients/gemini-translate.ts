import { GoogleGenAI } from "@google/genai";
import { config } from "../config.js";

const genai = new GoogleGenAI({ apiKey: config.geminiApiKey });

// Gemini 2.5 Pro — quality-first model. We keep it even though we disable
// `thinking` below: Pro's base output is still meaningfully better than
// Flash on low-resource targets like Mongolian (number-as-word compliance,
// idiom adaptation, less hallucinated transliteration), and switching off
// thinking trims ~3× off the per-call latency at minimal quality cost.
const TRANSLATE_MODEL = "gemini-2.5-pro";

// Long videos can produce 1000+ segments. Sending them all in one prompt
// degrades quality (model "forgets" earlier constraints) and risks output
// truncation. We batch into manageable groups and pass a sliding window of
// the previous batch's source+translation as carry-over context so
// terminology and tone stay consistent across batch boundaries.
const BATCH_SIZE = 80;
const CONTEXT_LINES = 6;
// Concurrent batches per "wave". Each wave runs in parallel, then we wait
// for the wave to finish before starting the next — so wave-N batches still
// get sliding context from the end of wave-(N-1)'s translations. Trade-off:
// within a wave, batches don't see each other's terminology choices, but the
// refine step can paper over any drift and the 4× speedup is worth it.
const PARALLEL_BATCHES = 4;

/**
 * Translate every segment text to the target language. Internally batches
 * long inputs and prepends prior-batch context so a 2-hour video doesn't
 * lose tone halfway through.
 */
export async function translateSegments(
  texts: string[],
  sourceLanguage: string,
  targetLanguage: string,
): Promise<string[]> {
  if (texts.length === 0) return [];

  const results: string[] = new Array(texts.length).fill("");

  // Collect every batch's starting index up front so we can group them
  // into parallel waves.
  const batchStarts: number[] = [];
  for (let s = 0; s < texts.length; s += BATCH_SIZE) batchStarts.push(s);
  const totalBatches = batchStarts.length;

  for (
    let waveIdx = 0;
    waveIdx < totalBatches;
    waveIdx += PARALLEL_BATCHES
  ) {
    const wave = batchStarts.slice(waveIdx, waveIdx + PARALLEL_BATCHES);
    const waveOutputs = await Promise.all(
      wave.map((start) => {
        const end = Math.min(start + BATCH_SIZE, texts.length);
        const batchTexts = texts.slice(start, end);
        // Context only flows from PRIOR waves' results — batches within the
        // same wave can't see each other (they're inflight in parallel).
        const ctxFrom = Math.max(0, start - CONTEXT_LINES);
        const ctxSources = texts.slice(ctxFrom, start);
        const ctxTranslations = results.slice(ctxFrom, start);
        return translateBatch(
          batchTexts,
          ctxSources,
          ctxTranslations,
          sourceLanguage,
          targetLanguage,
          texts.length,
          start,
        );
      }),
    );
    // Splice the wave's outputs back into the results array.
    wave.forEach((start, i) => {
      const out = waveOutputs[i];
      for (let j = 0; j < out.length; j++) {
        results[start + j] = out[j];
      }
    });
    const waveEnd = Math.min(waveIdx + PARALLEL_BATCHES, totalBatches);
    console.log(
      `[translate] wave ${Math.floor(waveIdx / PARALLEL_BATCHES) + 1} done — ` +
        `${waveEnd}/${totalBatches} batches complete`,
    );
  }

  return results;
}

async function translateBatch(
  batchTexts: string[],
  ctxSources: string[],
  ctxTranslations: string[],
  sourceLanguage: string,
  targetLanguage: string,
  total: number,
  batchStart: number,
): Promise<string[]> {
  const contextBlock =
    ctxSources.length > 0
      ? `\nPRIOR LINES (already translated — for terminology & tone consistency, do NOT re-translate these):\n${ctxSources
          .map(
            (s, i) =>
              `  C${i + 1}. ${sourceLanguage}: ${s}\n      ${targetLanguage}: ${ctxTranslations[i]}`,
          )
          .join("\n")}\n`
      : "";

  const numbered = batchTexts.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const isMultiBatch = total > BATCH_SIZE;
  const batchLabel = isMultiBatch
    ? `This is part of a longer video (lines ${batchStart + 1}-${batchStart + batchTexts.length} of ${total}). `
    : "";

  const prompt = `You are a professional ${targetLanguage} subtitle translator for video dubbing. ${batchLabel}Translate the ${batchTexts.length} numbered lines below from ${sourceLanguage} to ${targetLanguage}.
${contextBlock}
TRANSLATION QUALITY BAR:
- The result must read as if a native ${targetLanguage} speaker wrote it from scratch — NOT a literal word-for-word translation.
- Adapt Chinese idioms, four-character expressions, and grammatical structures to natural ${targetLanguage}. A literal rendering that sounds foreign is WRONG even if it preserves every word.
- The viewer should understand the meaning instantly when the voiceover plays.
- Keep tone consistent with prior lines (formal news / casual / dramatic / etc).
- Recurring proper nouns, place names, and technical terms MUST match across batches — see PRIOR LINES above.

HARD RULES:
- Preserve the line numbering exactly. One ${targetLanguage} line per source line — do NOT merge or split.
- **Length budget**: each translation must NOT exceed 1.3× the source line's character count. Cut filler words first.
- For Mongolian (mn):
  • Cyrillic only, no English code-switching.
  • Direct verb forms (no formal "та" unless the source is formal).
  • **Write ALL numbers as Mongolian words** (22 → "хорин хоёр", 2026 → "хоёр мянга хорин зургаан", 3% → "гурван хувь"). NEVER use Arabic digits in the output.
  • Allowed punctuation: . , ? ! - ' " :   (no parentheses, semicolons, slashes, asterisks).
  • Spell out abbreviations as words when they're read aloud (NASA → "наса", CCTV → "си си ти ви" or "Хятадын төв телевиз" if context allows).
- Output ONLY the numbered translations, no explanations, no headers.

Lines to translate:
${numbered}

Output:`;

  const responseText = await callWithRetry(prompt);
  return parseNumberedLines(responseText, batchTexts.length);
}

/**
 * Re-translate the given target lines applying a user-supplied style
 * instruction. Original source lines are passed alongside so the model has
 * the same context that produced the first pass and can pick better wording
 * without drifting from the source meaning.
 *
 * Used by the editor's "AI-аар орчуулга сайжруулах" flow: the user picks (or
 * writes) a style — "ярианы аястай", "албан ёсны", "хүүхдэд зориулсан", … —
 * and we rewrite every segment in one batch call so tone stays consistent.
 */
export async function refineSegments(
  sourceTexts: string[],
  currentTranslations: string[],
  sourceLanguage: string,
  targetLanguage: string,
  styleInstruction: string,
): Promise<string[]> {
  if (sourceTexts.length === 0) return [];
  if (sourceTexts.length !== currentTranslations.length) {
    throw new Error(
      `refineSegments length mismatch: ${sourceTexts.length} sources vs ${currentTranslations.length} current`,
    );
  }

  const results: string[] = new Array(sourceTexts.length).fill("");

  const batchStarts: number[] = [];
  for (let s = 0; s < sourceTexts.length; s += BATCH_SIZE) batchStarts.push(s);
  const totalBatches = batchStarts.length;

  for (
    let waveIdx = 0;
    waveIdx < totalBatches;
    waveIdx += PARALLEL_BATCHES
  ) {
    const wave = batchStarts.slice(waveIdx, waveIdx + PARALLEL_BATCHES);
    const waveOutputs = await Promise.all(
      wave.map((start) => {
        const end = Math.min(start + BATCH_SIZE, sourceTexts.length);
        const batchSources = sourceTexts.slice(start, end);
        const batchCurrents = currentTranslations.slice(start, end);
        // Carry over from the prior wave's already-refined lines.
        const ctxFrom = Math.max(0, start - CONTEXT_LINES);
        const ctxSources = sourceTexts.slice(ctxFrom, start);
        const ctxRefined = results.slice(ctxFrom, start);
        return refineBatch(
          batchSources,
          batchCurrents,
          ctxSources,
          ctxRefined,
          sourceLanguage,
          targetLanguage,
          styleInstruction,
          sourceTexts.length,
          start,
        );
      }),
    );
    wave.forEach((start, i) => {
      const out = waveOutputs[i];
      for (let j = 0; j < out.length; j++) {
        results[start + j] = out[j];
      }
    });
    const waveEnd = Math.min(waveIdx + PARALLEL_BATCHES, totalBatches);
    console.log(
      `[refine] wave ${Math.floor(waveIdx / PARALLEL_BATCHES) + 1} done — ` +
        `${waveEnd}/${totalBatches} batches complete`,
    );
  }

  return results;
}

async function refineBatch(
  batchSources: string[],
  batchCurrents: string[],
  ctxSources: string[],
  ctxRefined: string[],
  sourceLanguage: string,
  targetLanguage: string,
  styleInstruction: string,
  total: number,
  batchStart: number,
): Promise<string[]> {
  const contextBlock =
    ctxSources.length > 0
      ? `\nPRIOR LINES (already refined in this style — for terminology & tone consistency, do NOT re-refine these):\n${ctxSources
          .map(
            (s, i) =>
              `  C${i + 1}. SOURCE: ${s}\n      REFINED: ${ctxRefined[i]}`,
          )
          .join("\n")}\n`
      : "";

  const numbered = batchSources
    .map(
      (src, i) =>
        `${i + 1}. SOURCE (${sourceLanguage}): ${src}\n   CURRENT (${targetLanguage}): ${batchCurrents[i]}`,
    )
    .join("\n");

  const isMultiBatch = total > BATCH_SIZE;
  const batchLabel = isMultiBatch
    ? `This is part of a longer video (lines ${batchStart + 1}-${batchStart + batchSources.length} of ${total}). `
    : "";

  const prompt = `The ${targetLanguage} translations below were produced for video dubbing of a ${sourceLanguage} video. They are first-pass translations and often read awkwardly. ${batchLabel}Your job is to rewrite each CURRENT translation so it reads naturally and makes sense — as if a native ${targetLanguage} writer composed it from scratch for a voiceover — while keeping the meaning of the SOURCE line.

CONTENT TYPE / STYLE (from the user):
${styleInstruction}
${contextBlock}
WHAT "GOOD" LOOKS LIKE:
- Reads naturally when spoken aloud (this is for dubbing — the voice actor must sound like a real ${targetLanguage} speaker, not a translator).
- Idioms and phrasings adapted to ${targetLanguage} — do NOT translate word-for-word if the literal version sounds awkward.
- Vocabulary, register, and tone match the CONTENT TYPE above (a horror line should feel tense; a comedy line should feel playful; news should sound objective and structured; etc.).
- The viewer should understand the meaning instantly — no convoluted grammar, no foreign sentence shape.
- Recurring proper nouns, place names, and technical terms MUST match the PRIOR LINES above so the refined batches stay consistent.

HARD RULES:
- Preserve the line numbering exactly.
- One refined line per input line — do NOT merge or split.
- **Length budget**: each refined line must NOT exceed 1.3× the SOURCE line's character count. Cut filler before exceeding.
- Keep the SOURCE meaning — do not add new ideas, do not drop key facts (names, numbers, places, actions).
- For Mongolian (mn):
  • Cyrillic only, no English code-switching.
  • Direct verb forms (no formal "та" unless source is formal).
  • **Write ALL numbers as Mongolian words** (22 → "хорин хоёр", 3% → "гурван хувь"). NEVER use Arabic digits.
  • Allowed punctuation: . , ? ! - ' " :   (no parentheses, semicolons, slashes, asterisks).
  • Even if the style is casual/slang, do NOT use profanity or vulgar language.
- Output ONLY the numbered refined translations in ${targetLanguage}, no explanations, no headers.

Input:
${numbered}

Output:`;

  const responseText = await callWithRetry(prompt);
  return parseNumberedLines(responseText, batchSources.length);
}

/**
 * Wrap the Gemini Pro generateContent call with retry. Transient network
 * blips (DNS, TLS handshake, idle-connection RST) surface as plain "fetch
 * failed" — those should not fail the entire job. 5xx and 429 from Gemini
 * itself are also retriable.
 */
async function callWithRetry(prompt: string): Promise<string> {
  const maxAttempts = 4;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = Date.now();
    try {
      const result = await genai.models.generateContent({
        model: TRANSLATE_MODEL,
        contents: prompt,
        config: {
          // Low-but-not-zero — translation is largely deterministic, but a
          // little stochasticity lets Pro pick more natural phrasings over
          // its most-probable (often literal) first guess.
          temperature: 0.4,
          // thinking off — Pro's deliberation adds 15-30s/batch for
          // negligible quality gain on subtitle translation. With it off
          // each batch returns in ~5-10s; combined with parallel waves
          // below this brings a 2hr video from ~10min to ~1min total.
          thinkingConfig: { thinkingBudget: 0 },
        },
      });
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`[translate] gemini call ok in ${elapsed}s`);
      return result.text ?? "";
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const transient =
        /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|429|5\d\d/i.test(
          msg,
        );
      if (!transient || attempt === maxAttempts) {
        throw err;
      }
      const waitMs = Math.min(2_000 * 2 ** (attempt - 1), 20_000);
      console.warn(
        `[translate] attempt ${attempt}/${maxAttempts} failed: ${msg}. Retrying in ${waitMs}ms`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Parse Gemini's "1. ...\n2. ..." output back into an array.
 * Tolerates extra whitespace, "1)" / "1." styles, and missing lines (filled with "").
 */
function parseNumberedLines(text: string, expectedCount: number): string[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const out: string[] = new Array(expectedCount).fill("");
  for (const line of lines) {
    const match = line.match(/^(\d+)[\.\)]\s*(.+)$/);
    if (!match) continue;
    const idx = Number.parseInt(match[1], 10) - 1;
    if (idx >= 0 && idx < expectedCount) {
      out[idx] = match[2].trim();
    }
  }
  // If the model didn't follow numbering, fall back to line-by-line.
  if (out.every((s) => s === "") && lines.length === expectedCount) {
    return lines;
  }
  return out;
}
