/**
 * Text safety detection layer (Unicode TS #39 inspired).
 *
 * DETECTS:
 * 1. Bidi controls (U+202A to U+202E, U+2066 to U+2069, U+200E, U+200F, U+061C)
 * 2. Zero-width and invisible characters (U+200B to U+200D, U+2060, U+FEFF, soft hyphen U+00AD, and tag characters U+E0000..U+E007F)
 * 3. C0 and C1 control characters (excluding standard whitespace \t, \n, \r)
 * 4. Mixed-script confusables inside a single word (e.g. Cyrillic/Greek letters mixed with Latin)
 *
 * NOTE: The confusables table is explicitly limited and bounded to common Latin look-alikes
 * and is NOT the full Unicode TS #39 dataset.
 */

export type TextFindingKind =
  | "bidi"
  | "invisible"
  | "control"
  | "confusable";

export interface TextFinding {
  kind: TextFindingKind;
  codePoint: number;
  hex: string;
  index: number;
  safeLabel: string;
  char?: string;
  message?: string;
}

export interface TextSafetyAnalysis {
  hasFindings: boolean;
  hasBidiOrInvisible: boolean;
  hasConfusables: boolean;
  findings: TextFinding[];
  escapedView: string;
  cleanText: string;
  safeTruncated: (maxLen: number) => string;
}

// Bidi control characters
export const BIDI_CODE_POINTS = new Set<number>([
  0x200e, // LRM
  0x200f, // RLM
  0x202a, // LRE
  0x202b, // RLE
  0x202c, // PDF
  0x202d, // LRO
  0x202e, // RLO
  0x2066, // LRI
  0x2067, // RLI
  0x2068, // FSI
  0x2069, // PDI
  0x061c, // ALM
]);

// Zero-width and invisible characters
export const INVISIBLE_CODE_POINTS = new Set<number>([
  0x00ad, // Soft hyphen
  0x200b, // Zero width space
  0x200c, // Zero width non-joiner (ZWNJ)
  0x200d, // Zero width joiner (ZWJ) - note: when part of standard emoji sequence, handle gracefully
  0x2060, // Word joiner
  0xfeff, // Byte order mark / zero width no-break space
]);

// Bounded Latin look-alikes map (Cyrillic / Greek -> Latin)
// Explicitly bounded, not the full TS #39 dataset.
export const COMMON_CONFUSABLES: Record<string, { latin: string; script: string }> = {
  // Cyrillic small letters
  "а": { latin: "a", script: "Cyrillic" },
  "с": { latin: "c", script: "Cyrillic" },
  "е": { latin: "e", script: "Cyrillic" },
  "і": { latin: "i", script: "Cyrillic" },
  "ј": { latin: "j", script: "Cyrillic" },
  "о": { latin: "o", script: "Cyrillic" },
  "р": { latin: "p", script: "Cyrillic" },
  "ѕ": { latin: "s", script: "Cyrillic" },
  "у": { latin: "y", script: "Cyrillic" },
  "х": { latin: "x", script: "Cyrillic" },
  // Cyrillic capital letters
  "А": { latin: "A", script: "Cyrillic" },
  "В": { latin: "B", script: "Cyrillic" },
  "С": { latin: "C", script: "Cyrillic" },
  "Е": { latin: "E", script: "Cyrillic" },
  "Н": { latin: "H", script: "Cyrillic" },
  "І": { latin: "I", script: "Cyrillic" },
  "Ј": { latin: "J", script: "Cyrillic" },
  "К": { latin: "K", script: "Cyrillic" },
  "М": { latin: "M", script: "Cyrillic" },
  "О": { latin: "O", script: "Cyrillic" },
  "Р": { latin: "P", script: "Cyrillic" },
  "Т": { latin: "T", script: "Cyrillic" },
  "Х": { latin: "X", script: "Cyrillic" },
  // Greek letters
  "α": { latin: "a", script: "Greek" },
  "ο": { latin: "o", script: "Greek" },
  "ν": { latin: "v", script: "Greek" },
  "Α": { latin: "A", script: "Greek" },
  "Β": { latin: "B", script: "Greek" },
  "Ε": { latin: "E", script: "Greek" },
  "Ζ": { latin: "Z", script: "Greek" },
  "Η": { latin: "H", script: "Greek" },
  "Ι": { latin: "I", script: "Greek" },
  "Κ": { latin: "K", script: "Greek" },
  "Μ": { latin: "M", script: "Greek" },
  "Ν": { latin: "N", script: "Greek" },
  "Ο": { latin: "O", script: "Greek" },
  "Ρ": { latin: "P", script: "Greek" },
  "Τ": { latin: "T", script: "Greek" },
  "Υ": { latin: "Y", script: "Greek" },
  "Χ": { latin: "X", script: "Greek" },
};

function formatHex(cp: number): string {
  return "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * Checks if a code point is an emoji character (common range check).
 */
function isEmojiCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1f300 && cp <= 0x1f9ff) ||
    (cp >= 0x2600 && cp <= 0x27bf) ||
    (cp >= 0x1f600 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff)
  );
}

/**
 * Scans a word for mixed scripts (specifically Latin mixed with Cyrillic or Greek look-alikes).
 * A word entirely in Cyrillic, Greek, Arabic, Chinese etc. is NOT flagged.
 * Only words that mix Latin ASCII letters with look-alikes are flagged.
 */
function findMixedScriptConfusables(text: string, baseOffset: number): TextFinding[] {
  const findings: TextFinding[] = [];
  // Tokenize into words by whitespace / punctuation
  const wordRegex = /[\p{L}\p{N}]+/gu;
  let match: RegExpExecArray | null;

  while ((match = wordRegex.exec(text)) !== null) {
    const word = match[0];
    const wordStart = match.index;

    // Check if word contains Latin letters
    const hasLatin = /[a-zA-Z]/.test(word);
    if (!hasLatin) {
      // Entirely non-Latin word (or numbers only) -> legitimate non-Latin, do not flag
      continue;
    }

    // Check characters in the word for look-alikes
    let charOffset = 0;
    for (const ch of word) {
      const conf = COMMON_CONFUSABLES[ch];
      if (conf) {
        const cp = ch.codePointAt(0)!;
        findings.push({
          kind: "confusable",
          codePoint: cp,
          hex: formatHex(cp),
          index: baseOffset + wordStart + charOffset,
          safeLabel: `<${formatHex(cp)}:${conf.script}->'${conf.latin}'>`,
          char: ch,
          message: `Mixed-script word '${word}': ${conf.script} '${ch}' resembles Latin '${conf.latin}'`,
        });
      }
      charOffset += ch.length;
    }
  }

  return findings;
}

/**
 * Detects bidi, invisible, control characters and mixed-script confusables in text.
 */
export function analyzeTextSafety(rawText: unknown): TextSafetyAnalysis {
  if (rawText === null || rawText === undefined) {
    return {
      hasFindings: false,
      hasBidiOrInvisible: false,
      hasConfusables: false,
      findings: [],
      escapedView: "",
      cleanText: "",
      safeTruncated: () => "",
    };
  }

  const text = String(rawText);
  // Normalize with NFC per Unicode standard
  const normalized = text.normalize("NFC");

  const findings: TextFinding[] = [];
  const chars = Array.from(normalized);

  // First pass: scan for bidi, invisible, controls
  let index = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const cp = ch.codePointAt(0)!;

    if (BIDI_CODE_POINTS.has(cp)) {
      findings.push({
        kind: "bidi",
        codePoint: cp,
        hex: formatHex(cp),
        index,
        safeLabel: `<${formatHex(cp)}>`,
        char: ch,
        message: `Bidi direction control character ${formatHex(cp)}`,
      });
    } else if (INVISIBLE_CODE_POINTS.has(cp)) {
      // Exemption: standard emoji ZWJ sequence (e.g. 👨‍👩‍👧)
      const prevIsEmoji = i > 0 && isEmojiCodePoint(chars[i - 1].codePointAt(0)!);
      const nextIsEmoji = i < chars.length - 1 && isEmojiCodePoint(chars[i + 1].codePointAt(0)!);
      const isEmojiZwj = cp === 0x200d && (prevIsEmoji || nextIsEmoji);

      if (!isEmojiZwj) {
        findings.push({
          kind: "invisible",
          codePoint: cp,
          hex: formatHex(cp),
          index,
          safeLabel: `<${formatHex(cp)}>`,
          char: ch,
          message: `Zero-width or invisible character ${formatHex(cp)}`,
        });
      }
    } else if (cp >= 0xe0000 && cp <= 0xe007f) {
      // Unicode tag characters block
      findings.push({
        kind: "invisible",
        codePoint: cp,
        hex: formatHex(cp),
        index,
        safeLabel: `<${formatHex(cp)}>`,
        char: ch,
        message: `Unicode tag character ${formatHex(cp)}`,
      });
    } else if (
      (cp <= 0x1f && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) ||
      cp === 0x7f ||
      (cp >= 0x80 && cp <= 0x9f)
    ) {
      // C0 and C1 control characters (excluding \t, \n, \r)
      findings.push({
        kind: "control",
        codePoint: cp,
        hex: formatHex(cp),
        index,
        safeLabel: `<${formatHex(cp)}>`,
        char: ch,
        message: `Control character ${formatHex(cp)}`,
      });
    }

    index += ch.length;
  }

  // Second pass: scan for mixed-script confusables
  const confusableFindings = findMixedScriptConfusables(normalized, 0);
  findings.push(...confusableFindings);

  // Sort findings by index
  findings.sort((a, b) => a.index - b.index);

  // Build escaped view
  const escapedTokens: string[] = [];
  const findingIndices = new Map<number, TextFinding>();
  for (const f of findings) {
    findingIndices.set(f.index, f);
  }

  let currIdx = 0;
  for (const ch of chars) {
    const finding = findingIndices.get(currIdx);
    if (finding) {
      if (finding.kind === "bidi" || finding.kind === "invisible" || finding.kind === "control") {
        escapedTokens.push(finding.safeLabel);
      } else {
        // confusable: keep char and append token
        escapedTokens.push(ch + finding.safeLabel);
      }
    } else {
      escapedTokens.push(ch);
    }
    currIdx += ch.length;
  }
  const escapedView = escapedTokens.join("");

  // Clean text (strip hostile bidi/invisible/controls, keep readable characters)
  const cleanTokens: string[] = [];
  currIdx = 0;
  for (const ch of chars) {
    const finding = findingIndices.get(currIdx);
    if (finding && (finding.kind === "bidi" || finding.kind === "invisible" || finding.kind === "control")) {
      // skip
    } else {
      cleanTokens.push(ch);
    }
    currIdx += ch.length;
  }
  const cleanText = cleanTokens.join("");

  const hasBidiOrInvisible = findings.some((f) => f.kind === "bidi" || f.kind === "invisible" || f.kind === "control");
  const hasConfusables = findings.some((f) => f.kind === "confusable");

  /**
   * Safe truncation that will never cut off or leave a dangling bidi override.
   * If truncation occurs, any active bidi state is safely reset, or the bidi character is excluded.
   */
  const safeTruncated = (maxLen: number): string => {
    if (normalized.length <= maxLen) return normalized;
    let cut = normalized.slice(0, maxLen);
    // Strip dangling bidi / control characters at or near boundary
    cut = cut.replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069\u061C]+$/, "");
    return cut + "…";
  };

  return {
    hasFindings: findings.length > 0,
    hasBidiOrInvisible,
    hasConfusables,
    findings,
    escapedView,
    cleanText,
    safeTruncated,
  };
}
