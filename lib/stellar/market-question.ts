import { bytesToHex } from "./typed-call";
import { normalizeHash, raceGateways, type RaceOptions } from "./trace-core";
import { IPFS_GATEWAYS, DEFAULT_IPFS_MAX_TRACE_BYTES } from "./config";
import {
  parseQuestionDocument,
  type ParsedQuestionDoc,
} from "./question-parser";

export type QuestionIntegrityStatus = "verified" | "mismatch" | "unavailable" | "not-committed";

export interface QuestionMismatchDetails {
  questionMismatch?: { displayed: string; committed: string };
  closeTimeMismatch?: { chain: number; doc: number };
  categoryMismatch?: { chain: string | number; doc: string | number };
  resolutionHashMismatch?: { chain: string; doc: string };
}

export interface QuestionIntegrityCheck {
  status: QuestionIntegrityStatus;
  displayedQuestion: string;
  committedQuestion: string | null;
  committedHash: string | null;
  computedHash: string | null;
  parsedDoc?: ParsedQuestionDoc | null;
  mismatches?: QuestionMismatchDetails;
  isPlainText?: boolean;
  chainChecked: boolean;
  reason?: string;
  metaUri?: string | null;
}

export interface MarketQuestionCheckInput {
  displayedQuestion: string;
  metaUri?: string | null;
  questionHash?: Buffer | Uint8Array | string | null;
  gateways?: readonly string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Explicit flag indicating whether on-chain data is present. If false, verification is unavailable. */
  hasChainRead?: boolean;
  /** On-chain market state for cross-checking close time, category, and resolution hash. */
  chainMarket?: {
    close_time?: bigint | number;
    category?: unknown;
    resolution_hash?: Buffer | Uint8Array | string | null;
  } | null;
}

/** Check if a hash is empty, undefined, or all zeroes (32-byte zero buffer or 64 zero hex chars). */
export function isZeroOrEmptyHash(hash: Buffer | Uint8Array | string | null | undefined): boolean {
  if (!hash) return true;
  if (typeof hash === "string") {
    const clean = normalizeHash(hash);
    return clean.length === 0 || /^0{64}$/.test(clean);
  }
  if (hash.length === 0) return true;
  for (let i = 0; i < hash.length; i++) {
    if (hash[i] !== 0) return false;
  }
  return true;
}

export function formatHashHex(hash: Buffer | Uint8Array | string | null | undefined): string | null {
  if (!hash || isZeroOrEmptyHash(hash)) return null;
  if (typeof hash === "string") return normalizeHash(hash);
  return bytesToHex(hash);
}

// Bounded in-memory cache keyed strictly by committedHash (max 250 items, LRU)
const MAX_CACHE_SIZE = 250;
const questionCheckCache = new Map<string, QuestionIntegrityCheck>();

export function getCachedQuestionCheck(committedHash: string): QuestionIntegrityCheck | undefined {
  if (!committedHash) return undefined;
  return questionCheckCache.get(committedHash);
}

export function setCachedQuestionCheck(committedHash: string, result: QuestionIntegrityCheck): void {
  // Never cache failed or unverified results as verified
  if (!committedHash || result.status !== "verified") return;
  if (questionCheckCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = questionCheckCache.keys().next().value;
    if (oldestKey) questionCheckCache.delete(oldestKey);
  }
  questionCheckCache.set(committedHash, result);
}

export function clearQuestionCheckCache(): void {
  questionCheckCache.clear();
}

/**
 * Cross-checks document fields against on-chain market fields.
 */
function crossCheckWithChain(
  doc: ParsedQuestionDoc,
  chainMarket?: MarketQuestionCheckInput["chainMarket"]
): QuestionMismatchDetails | undefined {
  if (!chainMarket) return undefined;
  const mismatches: QuestionMismatchDetails = {};
  let found = false;

  // 1. Close time cross-check
  if (chainMarket.close_time !== undefined && doc.closeTime !== null && doc.closeTime !== undefined) {
    const chainClose = Number(chainMarket.close_time);
    if (chainClose > 0 && Math.abs(chainClose - doc.closeTime) > 60) {
      mismatches.closeTimeMismatch = { chain: chainClose, doc: doc.closeTime };
      found = true;
    }
  }

  // 2. Category cross-check
  if (chainMarket.category !== undefined && chainMarket.category !== null) {
    const chainCat =
      typeof chainMarket.category === "object" && chainMarket.category !== null && "tag" in chainMarket.category
        ? String((chainMarket.category as { tag: string }).tag).toLowerCase()
        : String(chainMarket.category).toLowerCase();
    const docCat = String(doc.category ?? doc.contractCategory ?? "").toLowerCase();
    if (chainCat && docCat && !chainCat.includes(docCat) && !docCat.includes(chainCat)) {
      mismatches.categoryMismatch = { chain: String(chainMarket.category), doc: doc.category ?? doc.contractCategory ?? "" };
      found = true;
    }
  }

  // 3. Resolution hash cross-check
  if (chainMarket.resolution_hash && doc.resolutionHash) {
    const chainResHash = formatHashHex(chainMarket.resolution_hash);
    const docResHash = normalizeHash(doc.resolutionHash);
    if (chainResHash && docResHash && chainResHash !== docResHash && !isZeroOrEmptyHash(chainResHash)) {
      mismatches.resolutionHashMismatch = { chain: chainResHash, doc: docResHash };
      found = true;
    }
  }

  return found ? mismatches : undefined;
}

/**
 * Verifies that the market question document matches the on-chain question_hash commitment.
 *
 * Enforces:
 * 1. Trust requirement: If on-chain read is missing, verification is marked unavailable.
 * 2. On-chain question_hash commitment check.
 * 3. Fetching raw bytes via IPFS gateways and checking SHA-256 against commitment.
 * 4. Strict-but-forward-compatible parsing for all supported document schemas.
 * 5. Cross-checking close time, category, and resolution hash against chain state.
 */
export async function verifyMarketQuestion(input: MarketQuestionCheckInput): Promise<QuestionIntegrityCheck> {
  const displayedQuestion = input.displayedQuestion.trim();

  // Trust check: If chain read is explicitly missing, do NOT trust backend data
  if (input.hasChainRead === false) {
    return {
      status: "unavailable",
      displayedQuestion,
      committedQuestion: null,
      committedHash: null,
      computedHash: null,
      chainChecked: false,
      reason: "On-chain state unavailable; cannot verify question commitment",
      metaUri: input.metaUri ?? null,
    };
  }

  const committedHash = formatHashHex(input.questionHash);

  // 1. Check if hash was committed on-chain
  if (!committedHash) {
    return {
      status: "not-committed",
      displayedQuestion,
      committedQuestion: null,
      committedHash: null,
      computedHash: null,
      chainChecked: true,
      reason: "No on-chain question commitment (question_hash is empty or zero)",
      metaUri: input.metaUri ?? null,
    };
  }

  // Check cache (keyed by committedHash)
  const cached = getCachedQuestionCheck(committedHash);
  if (cached) {
    return cached;
  }

  // 2. Check metadata URI
  const metaUri = input.metaUri?.trim();
  if (!metaUri) {
    return {
      status: "unavailable",
      displayedQuestion,
      committedQuestion: null,
      committedHash,
      computedHash: null,
      chainChecked: true,
      reason: "No metadata URI (meta_uri is empty)",
      metaUri: null,
    };
  }

  // 3. Fetch from IPFS gateways
  const gateways = input.gateways ?? IPFS_GATEWAYS;
  let rawBytes: Uint8Array | undefined;
  let computedHash: string | null = null;

  try {
    const raceOpts: RaceOptions = {
      cid: metaUri,
      onChainHash: committedHash,
      gateways,
      maxBytes: DEFAULT_IPFS_MAX_TRACE_BYTES,
      timeoutMs: input.timeoutMs ?? 5_000,
      fetchImpl: input.fetchImpl,
    };

    const result = await raceGateways(raceOpts);
    if (result.bytes && result.check.status === "verified") {
      rawBytes = result.bytes;
      computedHash = result.check.computedHash;
    } else if (result.check.status === "mismatch") {
      computedHash = result.check.computedHash;
      return {
        status: "mismatch",
        displayedQuestion,
        committedQuestion: null,
        committedHash,
        computedHash,
        chainChecked: true,
        reason: "IPFS document hash does not match on-chain question_hash",
        metaUri,
      };
    } else {
      return {
        status: "unavailable",
        displayedQuestion,
        committedQuestion: null,
        committedHash,
        computedHash: null,
        chainChecked: true,
        reason: ("reason" in result.check && result.check.reason) || "IPFS gateway unreachable or document unavailable",
        metaUri,
      };
    }
  } catch (err) {
    return {
      status: "unavailable",
      displayedQuestion,
      committedQuestion: null,
      committedHash,
      computedHash: null,
      chainChecked: true,
      reason: err instanceof Error ? err.message : "Failed to fetch question document",
      metaUri,
    };
  }

  // 4. Parse document using versioned parser
  const text = new TextDecoder().decode(rawBytes);
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(text);
  } catch {
    // Deliberately accept plain-text documents as fallback
    parsedPayload = text;
  }

  const parseRes = parseQuestionDocument(parsedPayload);
  if (!parseRes.ok) {
    return {
      status: "mismatch",
      displayedQuestion,
      committedQuestion: null,
      committedHash,
      computedHash,
      chainChecked: true,
      reason: parseRes.reason,
      metaUri,
    };
  }

  const doc = parseRes.doc;
  const committedQuestion = doc.question;

  // Cross-check with chain fields
  const mismatches = crossCheckWithChain(doc, input.chainMarket) ?? {};

  // Check if displayed question differs from committed question
  if (committedQuestion.toLowerCase() !== displayedQuestion.toLowerCase()) {
    mismatches.questionMismatch = {
      displayed: displayedQuestion,
      committed: committedQuestion,
    };
  }

  const result: QuestionIntegrityCheck = {
    status: "verified",
    displayedQuestion,
    committedQuestion,
    committedHash,
    computedHash,
    parsedDoc: doc,
    isPlainText: doc.isPlainText,
    mismatches: Object.keys(mismatches).length > 0 ? mismatches : undefined,
    chainChecked: true,
    metaUri,
  };

  // Cache verified result
  setCachedQuestionCheck(committedHash, result);
  return result;
}
