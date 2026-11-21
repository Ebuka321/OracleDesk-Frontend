export type Dir = "ltr" | "rtl";

const RTL_LANGS = new Set(["ar", "fa", "he", "ur", "ps", "dv", "ckb", "yi", "sd", "ug", "syr", "nqo"]);

/**
 * Returns the text/layout direction ("ltr" | "rtl") for a BCP-47 locale tag.
 * Uses `Intl.Locale#getTextInfo()` when available (handling script overrides
 * such as `ar-Latn` → `"ltr"`), with a language/script fallback.
 */
export function dirForLocale(locale: string): Dir {
  const normalized = (locale || "en").trim();
  if (!normalized) return "ltr";

  try {
    const loc = new Intl.Locale(normalized);
    const getTextInfo = (loc as unknown as { getTextInfo?: () => { direction?: string } }).getTextInfo;
    if (typeof getTextInfo === "function") {
      const info = getTextInfo.call(loc);
      if (info?.direction === "rtl") return "rtl";
      if (info?.direction === "ltr") return "ltr";
    }
    const textInfo = (loc as unknown as { textInfo?: { direction?: string } }).textInfo;
    if (textInfo?.direction === "rtl") return "rtl";
    if (textInfo?.direction === "ltr") return "ltr";

    if (loc.script === "Latn" || loc.script === "Cyrl") return "ltr";
    if (loc.script === "Arab" || loc.script === "Hebr") return "rtl";
    return RTL_LANGS.has(loc.language.toLowerCase()) ? "rtl" : "ltr";
  } catch {
    const base = normalized.split(/[-_]/)[0]?.toLowerCase() ?? "en";
    return RTL_LANGS.has(base) ? "rtl" : "ltr";
  }
}
