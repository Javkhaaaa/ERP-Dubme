import { GoogleGenAI } from "@google/genai";
import { config } from "../config.js";

const genai = new GoogleGenAI({ apiKey: config.geminiApiKey });

// Gemini 2.5 Pro — quality-first model. Mongolian is low-resource, and Pro's
// base output is meaningfully better than Flash (number-as-word compliance,
// idiom adaptation, less hallucinated transliteration). We disable most
// `thinking` to trim latency at minimal quality cost.
const TRANSLATE_MODEL = "gemini-2.5-pro";
// A fast model is plenty for the cheap glossary-extraction pass.
const GLOSSARY_MODEL = "gemini-2.5-flash";

const BATCH_SIZE = 80;
const CONTEXT_LINES = 6;
// Batches now run fully in parallel (no inter-wave barrier). Terminology
// consistency comes from a shared glossary computed up front instead of from a
// sliding window of the previous wave's translations — so a 2-hour video no
// longer pays a 5× serialization cost for 6 carry-over lines, AND every batch
// gets the same glossary (the old scheme left most batches with no context at
// all). Cap concurrency to stay comfortably under Tier-1 RPM.
const TRANSLATE_CONCURRENCY = 8;

/** Run tasks with bounded concurrency, preserving order. */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(concurrency, items.length)))
    .fill(0)
    .map(async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) break;
        results[i] = await fn(items[i], i);
      }
    });
  await Promise.all(workers);
  return results;
}

/**
 * Translate every segment text to the target language. Builds a shared
 * glossary first, then translates all batches in parallel.
 */
export async function translateSegments(
  texts: string[],
  sourceLanguage: string,
  targetLanguage: string,
): Promise<string[]> {
  if (texts.length === 0) return [];

  const glossary = await buildGlossary(texts, sourceLanguage, targetLanguage).catch(
    (e) => {
      console.warn(`[translate] glossary step failed (continuing without): ${e}`);
      return "";
    },
  );

  const batchStarts: number[] = [];
  for (let s = 0; s < texts.length; s += BATCH_SIZE) batchStarts.push(s);

  const results: string[] = new Array(texts.length).fill("");
  let doneBatches = 0;
  await mapPool(batchStarts, TRANSLATE_CONCURRENCY, async (start) => {
    const end = Math.min(start + BATCH_SIZE, texts.length);
    const out = await translateBatch(
      texts.slice(start, end),
      glossary,
      sourceLanguage,
      targetLanguage,
      texts.length,
      start,
    );
    for (let j = 0; j < out.length; j++) results[start + j] = out[j];
    doneBatches++;
    console.log(`[translate] batch ${doneBatches}/${batchStarts.length} done`);
  });

  // Gemini occasionally drops a numbered line (or truncates a batch), leaving
  // a blank translation. A blank breaks render ("Translation incomplete: N
  // lines missing") and shows as an empty subtitle — so re-translate just the
  // gaps before returning.
  await fillMissingTranslations(results, texts, glossary, sourceLanguage, targetLanguage);

  return results;
}

/**
 * Detect lines that came back blank (model dropped/truncated them) and
 * re-translate ONLY those, up to two passes. Guarantees no non-empty source
 * line is left without a translation under normal conditions.
 */
async function fillMissingTranslations(
  results: string[],
  texts: string[],
  glossary: string,
  sourceLanguage: string,
  targetLanguage: string,
): Promise<void> {
  const isMissing = (i: number) =>
    !!texts[i] && texts[i].trim().length > 0 && (!results[i] || !results[i].trim());

  for (let pass = 0; pass < 2; pass++) {
    const missing: number[] = [];
    for (let i = 0; i < texts.length; i++) if (isMissing(i)) missing.push(i);
    if (missing.length === 0) return;
    console.warn(
      `[translate] gap-fill pass ${pass + 1}: re-translating ${missing.length} missing line(s)`,
    );
    const chunks: number[][] = [];
    for (let s = 0; s < missing.length; s += BATCH_SIZE) chunks.push(missing.slice(s, s + BATCH_SIZE));
    await mapPool(chunks, TRANSLATE_CONCURRENCY, async (idxs) => {
      const out = await translateBatch(
        idxs.map((i) => texts[i]),
        glossary,
        sourceLanguage,
        targetLanguage,
        idxs.length,
        0,
      ).catch(() => [] as string[]);
      idxs.forEach((origIdx, j) => {
        if (out[j] && out[j].trim()) results[origIdx] = out[j];
      });
    });
  }

  const stillMissing = texts.filter((_, i) => isMissing(i)).length;
  if (stillMissing > 0) {
    console.warn(`[translate] gap-fill exhausted; ${stillMissing} line(s) still blank`);
  }
}

/**
 * One cheap pass that extracts a zh→mn glossary of recurring proper nouns,
 * names, places and technical terms, so every parallel batch renders them
 * consistently. Best-effort: returns "" on any failure.
 */
async function buildGlossary(
  texts: string[],
  sourceLanguage: string,
  targetLanguage: string,
): Promise<string> {
  if (texts.length < BATCH_SIZE) return ""; // short videos don't need it
  // Cap the sample so the call stays fast even on multi-hour videos.
  const joined = texts.join("\n");
  const sample = joined.length > 12_000 ? joined.slice(0, 12_000) : joined;
  const prompt = `From the following ${sourceLanguage} subtitle text, extract recurring PROPER NOUNS (people, places, organizations) and TECHNICAL TERMS that need a consistent ${targetLanguage} rendering across a long video.

Output ONLY lines of the form "<source term> = <${targetLanguage} rendering>", at most 40 lines, no commentary. For Mongolian (mn): Cyrillic only; spell numbers/abbreviations as words. If there are no such terms, output nothing.

TEXT:
${sample}`;
  const text = await callWithRetry(prompt, {
    model: GLOSSARY_MODEL,
    temperature: 0.2,
    thinkingBudget: 0,
  });
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("=") && l.length < 200)
    .slice(0, 40);
  if (lines.length === 0) return "";
  console.log(`[translate] glossary: ${lines.length} terms`);
  return lines.join("\n");
}

async function translateBatch(
  batchTexts: string[],
  glossary: string,
  sourceLanguage: string,
  targetLanguage: string,
  total: number,
  batchStart: number,
): Promise<string[]> {
  const glossaryBlock = glossary
    ? `\nGLOSSARY (use these exact ${targetLanguage} renderings for consistency across the whole video):\n${glossary}\n`
    : "";

  const numbered = batchTexts.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const isMultiBatch = total > BATCH_SIZE;
  const batchLabel = isMultiBatch
    ? `This is part of a longer video (lines ${batchStart + 1}-${batchStart + batchTexts.length} of ${total}). `
    : "";

  const prompt = `You are a professional ${targetLanguage} subtitle translator for video dubbing. ${batchLabel}Translate the ${batchTexts.length} numbered lines below from ${sourceLanguage} to ${targetLanguage}.
${glossaryBlock}
TRANSLATION QUALITY BAR:
- The result must read as if a native ${targetLanguage} speaker wrote it from scratch — NOT a literal word-for-word translation.
- Adapt Chinese idioms, four-character expressions, and grammatical structures to natural ${targetLanguage}. A literal rendering that sounds foreign is WRONG even if it preserves every word.
- The viewer should understand the meaning instantly when the voiceover plays.
- Keep tone consistent (formal news / casual / dramatic / etc).
- Recurring proper nouns, place names, and technical terms MUST match the GLOSSARY above.

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
 * instruction. Runs all batches in parallel with a shared glossary, same as
 * the first-pass translator.
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

  const glossary = await buildGlossary(sourceTexts, sourceLanguage, targetLanguage).catch(
    () => "",
  );

  const batchStarts: number[] = [];
  for (let s = 0; s < sourceTexts.length; s += BATCH_SIZE) batchStarts.push(s);

  const results: string[] = new Array(sourceTexts.length).fill("");
  let done = 0;
  await mapPool(batchStarts, TRANSLATE_CONCURRENCY, async (start) => {
    const end = Math.min(start + BATCH_SIZE, sourceTexts.length);
    const out = await refineBatch(
      sourceTexts.slice(start, end),
      currentTranslations.slice(start, end),
      glossary,
      sourceLanguage,
      targetLanguage,
      styleInstruction,
      sourceTexts.length,
      start,
    );
    for (let j = 0; j < out.length; j++) results[start + j] = out[j];
    done++;
    console.log(`[refine] batch ${done}/${batchStarts.length} done`);
  });

  // Never blank a line during refine — if the model dropped one, keep the
  // existing translation rather than overwriting it with "".
  for (let i = 0; i < results.length; i++) {
    if (!results[i] || !results[i].trim()) results[i] = currentTranslations[i] ?? "";
  }

  return results;
}

async function refineBatch(
  batchSources: string[],
  batchCurrents: string[],
  glossary: string,
  sourceLanguage: string,
  targetLanguage: string,
  styleInstruction: string,
  total: number,
  batchStart: number,
): Promise<string[]> {
  const glossaryBlock = glossary
    ? `\nGLOSSARY (keep these ${targetLanguage} renderings consistent):\n${glossary}\n`
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
${glossaryBlock}
WHAT "GOOD" LOOKS LIKE:
- Reads naturally when spoken aloud (this is for dubbing — the voice actor must sound like a real ${targetLanguage} speaker, not a translator).
- Idioms and phrasings adapted to ${targetLanguage} — do NOT translate word-for-word if the literal version sounds awkward.
- Vocabulary, register, and tone match the CONTENT TYPE above (a horror line should feel tense; a comedy line should feel playful; news should sound objective and structured; etc.).
- The viewer should understand the meaning instantly — no convoluted grammar, no foreign sentence shape.
- Recurring proper nouns, place names, and technical terms MUST match the GLOSSARY above.

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

interface CallOptions {
  model?: string;
  temperature?: number;
  thinkingBudget?: number;
}

/**
 * Wrap the Gemini generateContent call with retry + jitter. Transient network
 * blips and 5xx/429 are retried; everything else fails fast.
 */
async function callWithRetry(prompt: string, opts: CallOptions = {}): Promise<string> {
  const model = opts.model ?? TRANSLATE_MODEL;
  const temperature = opts.temperature ?? 0.4;
  // Pro REQUIRES thinking (min 128); Flash accepts 0 to disable it.
  const thinkingBudget = opts.thinkingBudget ?? 128;
  const maxAttempts = 4;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await genai.models.generateContent({
        model,
        contents: prompt,
        config: { temperature, thinkingConfig: { thinkingBudget } },
      });
      return result.text ?? "";
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const transient =
        /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|429|5\d\d/i.test(msg);
      if (!transient || attempt === maxAttempts) throw err;
      const base = Math.min(2_000 * 2 ** (attempt - 1), 20_000);
      const waitMs = Math.round(base * (0.5 + Math.random() * 0.5)); // full jitter
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
 * Tolerates extra whitespace, "1)" / "1." styles, and missing lines.
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
  if (out.every((s) => s === "") && lines.length === expectedCount) {
    return lines;
  }
  return out;
}
