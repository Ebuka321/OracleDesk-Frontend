import { describe, expect, it } from "vitest";
import { analyzeTextSafety } from "../text-safety";

describe("analyzeTextSafety", () => {
  it("detects bidi override controls (RLO, LRO, etc.)", () => {
    // U+202E is RIGHT-TO-LEFT OVERRIDE
    const rloText = "Market will settle \u202Ebelow\u202C 5000";
    const res = analyzeTextSafety(rloText);

    expect(res.hasFindings).toBe(true);
    expect(res.hasBidiOrInvisible).toBe(true);
    expect(res.findings.some((f) => f.kind === "bidi" && f.hex === "U+202E")).toBe(true);
    expect(res.escapedView).toContain("<U+202E>");
  });

  it("detects a RLO question that reads 'below' as 'above'", () => {
    // When RLO is used to reverse "evoba" to "above" visually
    const deceptiveQuestion = "Will Bitcoin close \u202Eevoba\u202C $100,000?";
    const res = analyzeTextSafety(deceptiveQuestion);

    expect(res.hasBidiOrInvisible).toBe(true);
    expect(res.escapedView).toContain("<U+202E>evoba<U+202C>");
  });

  it("detects zero-width splits of a keyword (U+200B)", () => {
    // "Re\u200Buters" splitting keyword
    const zeroWidthText = "Source: Re\u200Buters News";
    const res = analyzeTextSafety(zeroWidthText);

    expect(res.hasFindings).toBe(true);
    expect(res.hasBidiOrInvisible).toBe(true);
    expect(res.findings.some((f) => f.kind === "invisible" && f.hex === "U+200B")).toBe(true);
    expect(res.escapedView).toContain("Re<U+200B>uters");
  });

  it("detects mixed-script Cyrillic 'о' in 'Reuters'", () => {
    // "Reuters" with Cyrillic small 'о' (U+043E) instead of Latin 'o' (U+006F)
    const confusableText = "Confirmed by Re\u043Etters financial wire";
    const res = analyzeTextSafety(confusableText);

    expect(res.hasFindings).toBe(true);
    expect(res.hasConfusables).toBe(true);
    expect(res.findings.some((f) => f.kind === "confusable" && f.hex === "U+043E")).toBe(true);
  });

  it("does not flag legitimate non-Latin text (e.g. pure Arabic or Russian words)", () => {
    const russianText = "Пшеница вырастет в цене в следующем году";
    const resRussian = analyzeTextSafety(russianText);
    expect(resRussian.hasFindings).toBe(false);

    const arabicText = "هل سينخفض سعر الفائدة؟";
    const resArabic = analyzeTextSafety(arabicText);
    expect(resArabic.hasFindings).toBe(false);

    const chineseText = "比特币是否会突破十万美元？";
    const resChinese = analyzeTextSafety(chineseText);
    expect(resChinese.hasFindings).toBe(false);
  });

  it("does not flag standard emoji ZWJ sequence as hostile", () => {
    // Family emoji sequence: 👨‍👩‍👧 (man + ZWJ + woman + ZWJ + girl)
    const emojiSequence = "Prediction for family emoji: 👨‍👩‍👧";
    const res = analyzeTextSafety(emojiSequence);

    expect(res.hasBidiOrInvisible).toBe(false);
  });

  it("performs safe truncation that cannot leave a dangling bidi override", () => {
    const textWithBidi = "Long string with trailing bidi \u202E\u2066";
    const res = analyzeTextSafety(textWithBidi);

    const truncated = res.safeTruncated(33);
    // Truncated string should not end with bidi character
    expect(truncated.endsWith("…")).toBe(true);
    expect(/[\u202E\u2066]…$/.test(truncated)).toBe(false);
  });

  it("provides clean text stripping hostile bidi and controls", () => {
    const dirty = "Safe \u202Etext\u202C \x00here";
    const res = analyzeTextSafety(dirty);
    expect(res.cleanText).toBe("Safe text here");
  });
});
