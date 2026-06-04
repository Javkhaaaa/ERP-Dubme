/**
 * Minimal SRT parser. The format is line-based:
 *
 *   <index>
 *   HH:MM:SS,mmm --> HH:MM:SS,mmm
 *   text line 1
 *   text line 2 (optional)
 *   <blank>
 *   <next index>
 *   …
 *
 * We tolerate:
 *   - missing/wrong index numbers (we re-number anyway)
 *   - "." vs "," fractional separator
 *   - extra blank lines between cues
 *   - multi-line text (joined with a single space)
 *   - UTF-8 BOM at file start
 *   - \r\n or \n line endings
 *
 * What we DON'T preserve:
 *   - cue styling tags (<i>…</i>, {\an8}, etc) — stripped to plain text
 *   - SRT-extended position/positioning hints
 */
export interface SrtCue {
  startSec: number;
  endSec: number;
  text: string;
}

const TS_LINE =
  /^\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})/;

export function parseSrt(raw: string): SrtCue[] {
  // Strip BOM, normalize line endings.
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");

  const cues: SrtCue[] = [];
  let i = 0;
  while (i < lines.length) {
    // Skip blank lines.
    while (i < lines.length && lines[i].trim() === "") i++;
    if (i >= lines.length) break;

    // Optional numeric index line — consume if present, otherwise treat
    // current line as the timestamp.
    if (/^\d+$/.test(lines[i].trim())) i++;
    if (i >= lines.length) break;

    const tsMatch = lines[i].match(TS_LINE);
    if (!tsMatch) {
      // Malformed cue — skip to next blank line.
      i++;
      continue;
    }
    const startSec = srtTimeToSeconds(tsMatch[1]);
    const endSec = srtTimeToSeconds(tsMatch[2]);
    i++;

    // Collect text lines until blank.
    const textParts: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      textParts.push(lines[i]);
      i++;
    }
    const joined = textParts
      .join(" ")
      .replace(/<[^>]+>/g, "") // strip HTML/styling tags
      .replace(/\{[^}]+\}/g, "") // strip ASS-style overrides
      .replace(/\s+/g, " ")
      .trim();

    if (joined.length > 0 && endSec > startSec) {
      cues.push({ startSec, endSec, text: joined });
    }
  }
  return cues;
}

function srtTimeToSeconds(t: string): number {
  const m = t.match(/^(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})$/);
  if (!m) return 0;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  // Pad the fractional part so "1" → 100ms, "12" → 120ms, "123" → 123ms.
  const ms = Number(m[4].padEnd(3, "0").slice(0, 3));
  return h * 3600 + min * 60 + sec + ms / 1000;
}
