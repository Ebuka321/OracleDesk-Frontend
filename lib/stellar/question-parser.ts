/**
 * Strict-but-forward-compatible parser and sanitizer for market question documents.
 *
 * Supported schemas:
 * 1. createMarketOnChain v1 / v2:
 *    { version: 1 | 2, question, category, contractCategory, closeTime, resolutionSource, resolutionHash, ... }
 *    where v2 carries resolution: { sourceId, url, measurable, comparator, threshold, deadlineUtc, instructions }
 * 2. QuestionDocV2 (strict):
 *    { schemaVersion: 2, kind: "oracledesk.question", question, category, closeTime, resolutionSpecHash, ... }
 * 3. QuestionDoc v1 (strict):
 *    { schemaVersion: 1, ... } or { version: 1, ... }
 * 4. Plain-text document: UTF-8 plain text string with no structured terms.
 *
 * All string fields are sanitized: bidi directional overrides and control characters are stripped.
 * URLs are strictly validated to http: or https: schemes only.
 */

export interface ResolutionBlock {
  sourceId: string;
  url?: string | null;
  safeUrl?: string | null;
  urlHost?: string | null;
  measurable: string;
  comparator: string;
  threshold: string;
  deadlineUtc: string;
  instructions?: string | null;
}

export interface PriceResolutionBlock {
  oracle?: string | null;
  asset?: string | null;
  threshold?: string | null;
  comparison?: string | null;
  timestamp?: string | number | null;
  [key: string]: unknown;
}

export interface ParsedQuestionDoc {
  schemaType: "market-create-v1" | "market-create-v2" | "question-doc-v2" | "question-doc-v1" | "plain-text";
  version: number;
  question: string;
  category?: string | null;
  contractCategory?: number | string | null;
  closeTime?: number | null; // Unix timestamp in seconds
  resolutionSource?: string | null;
  resolutionHash?: string | null;
  resolution?: ResolutionBlock | null;
  priceResolution?: PriceResolutionBlock | null;
  backendMarketId?: string | number | null;
  isPlainText?: boolean;
}

export type ParseQuestionResult =
  | { ok: true; doc: ParsedQuestionDoc }
  | { ok: false; error: "unsupported_version" | "invalid_schema" | "invalid_fields"; reason: string };

/**
 * Strips ASCII control characters (preserving standard linebreaks/tabs if needed)
 * and Unicode bidirectional override characters that can disguise text.
 * Directional overrides stripped:
 * \u200E (LRM), \u200F (RLM), \u202A (LRE), \u202B (RLE), \u202C (PDF),
 * \u202D (LRO), \u202E (RLO), \u2066 (LRI), \u2067 (RLI), \u2068 (FSI),
 * \u2069 (PDI), \u061C (ALM).
 */
export function sanitizeText(input: unknown): string {
  if (typeof input !== "string") return "";
  return input
    // Strip control characters (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, 0x7F)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    // Strip bidirectional override characters
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069\u061C]/g, "")
    .trim();
}

/**
 * Validates and sanitizes a URL. Scheme MUST be http: or https:.
 * Returns null for javascript:, data:, file: or malformed URLs.
 */
export function sanitizeUrl(urlStr: unknown): { safeUrl: string; host: string } | null {
  if (typeof urlStr !== "string") return null;
  const clean = sanitizeText(urlStr);
  if (!clean) return null;
  try {
    const parsed = new URL(clean);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return {
      safeUrl: parsed.href,
      host: parsed.hostname,
    };
  } catch {
    return null;
  }
}

/**
 * Parses a closeTime field which may be unix seconds, milliseconds, or ISO string.
 * Normalizes to unix seconds.
 */
function normalizeCloseTime(val: unknown): number | null {
  if (typeof val === "number" && Number.isFinite(val)) {
    // If > 1e11 it's in milliseconds
    return val > 1e11 ? Math.floor(val / 1000) : Math.floor(val);
  }
  if (typeof val === "string") {
    const num = Number(val);
    if (!Number.isNaN(num) && Number.isFinite(num)) {
      return num > 1e11 ? Math.floor(num / 1000) : Math.floor(num);
    }
    const parsed = Date.parse(val);
    if (!Number.isNaN(parsed)) {
      return Math.floor(parsed / 1000);
    }
  }
  return null;
}

function parseResolutionBlock(block: unknown): ResolutionBlock | null {
  if (!block || typeof block !== "object") return null;
  const b = block as Record<string, unknown>;
  const sourceId = sanitizeText(b.sourceId);
  const measurable = sanitizeText(b.measurable);
  const comparator = sanitizeText(b.comparator);
  const threshold = sanitizeText(String(b.threshold ?? ""));
  const deadlineUtc = sanitizeText(String(b.deadlineUtc ?? ""));

  if (!measurable || !comparator) return null;

  const urlData = sanitizeUrl(b.url);

  return {
    sourceId: sourceId || "unknown",
    url: typeof b.url === "string" ? sanitizeText(b.url) : null,
    safeUrl: urlData?.safeUrl ?? null,
    urlHost: urlData?.host ?? null,
    measurable,
    comparator,
    threshold,
    deadlineUtc,
    instructions: typeof b.instructions === "string" ? sanitizeText(b.instructions) : null,
  };
}

/**
 * Strict-but-forward-compatible parser for question documents.
 */
export function parseQuestionDocument(raw: unknown): ParseQuestionResult {
  // 1. Plain text document
  if (typeof raw === "string") {
    const question = sanitizeText(raw);
    if (!question) {
      return { ok: false, error: "invalid_fields", reason: "Plain text question document is empty" };
    }
    return {
      ok: true,
      doc: {
        schemaType: "plain-text",
        version: 1,
        question,
        isPlainText: true,
        resolution: null,
      },
    };
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "invalid_schema", reason: "Question document must be an object or string" };
  }

  const obj = raw as Record<string, unknown>;

  // Check version identifiers
  const schemaVersion = obj.schemaVersion;
  const version = obj.version;
  const kind = obj.kind;

  // Unknown version check
  if (typeof schemaVersion === "number" && schemaVersion > 2) {
    return { ok: false, error: "unsupported_version", reason: `Unsupported document version: schemaVersion ${schemaVersion}` };
  }
  if (typeof version === "number" && version > 2) {
    return { ok: false, error: "unsupported_version", reason: `Unsupported document version: version ${version}` };
  }

  // Question string extraction and validation
  const rawQuestion = obj.question ?? obj.title ?? obj.text;
  if (typeof rawQuestion !== "string") {
    return { ok: false, error: "invalid_fields", reason: "Document is missing a required 'question' string" };
  }
  const question = sanitizeText(rawQuestion);
  if (!question) {
    return { ok: false, error: "invalid_fields", reason: "Question text cannot be empty" };
  }

  const category = typeof obj.category === "string" ? sanitizeText(obj.category) : null;
  const contractCategory =
    typeof obj.contractCategory === "number" || typeof obj.contractCategory === "string"
      ? obj.contractCategory
      : null;
  const closeTime = normalizeCloseTime(obj.closeTime);
  const resolutionSource = typeof obj.resolutionSource === "string" ? sanitizeText(obj.resolutionSource) : null;
  const resolutionHash = typeof obj.resolutionHash === "string" ? sanitizeText(obj.resolutionHash) : null;
  const resolutionSpecHash = typeof obj.resolutionSpecHash === "string" ? sanitizeText(obj.resolutionSpecHash) : null;
  const backendMarketId =
    typeof obj.backendMarketId === "string" || typeof obj.backendMarketId === "number"
      ? obj.backendMarketId
      : null;

  const resolution = parseResolutionBlock(obj.resolution);
  const priceResolution =
    obj.priceResolution && typeof obj.priceResolution === "object"
      ? (obj.priceResolution as PriceResolutionBlock)
      : null;

  // Determine specific shape
  // Shape (b): QuestionDocV2 (strict)
  if (schemaVersion === 2 && kind === "oracledesk.question") {
    return {
      ok: true,
      doc: {
        schemaType: "question-doc-v2",
        version: 2,
        question,
        category,
        contractCategory,
        closeTime,
        resolutionHash: resolutionSpecHash ?? resolutionHash,
        resolution,
        priceResolution,
        backendMarketId,
      },
    };
  }

  // Shape (a) v2: createMarketOnChain v2
  if (version === 2) {
    return {
      ok: true,
      doc: {
        schemaType: "market-create-v2",
        version: 2,
        question,
        category,
        contractCategory,
        closeTime,
        resolutionSource,
        resolutionHash,
        resolution,
        priceResolution,
        backendMarketId,
      },
    };
  }

  // Shape (a) v1 / Shape (c) strict v1
  if (version === 1 || schemaVersion === 1 || (!version && !schemaVersion)) {
    return {
      ok: true,
      doc: {
        schemaType: schemaVersion === 1 ? "question-doc-v1" : "market-create-v1",
        version: 1,
        question,
        category,
        contractCategory,
        closeTime,
        resolutionSource,
        resolutionHash,
        resolution,
        priceResolution,
        backendMarketId,
      },
    };
  }

  return {
    ok: false,
    error: "unsupported_version",
    reason: `Unsupported document version: version ${version ?? schemaVersion}`,
  };
}
