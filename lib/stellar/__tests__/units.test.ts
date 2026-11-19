import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  BPS,
  bpsToPercent,
  formatUsdc,
  maxIn,
  minOut,
  parseUsdc,
  shareOf,
  shortAddress,
  tryParseUsdc,
  USDC_UNIT,
  XLM_UNIT,
  formatXlm,
  mulDivFloor,
  mulDivCeil,
} from "../units";
import { BPS as FPMM_BPS, calcBuy, priceYesBps } from "../generated/fpmm";
import { usdcStringArb } from "./arbitraries";

describe("parseUsdc / formatUsdc", () => {
  it("uses 7 decimals", () => {
    expect(USDC_UNIT).toBe(10_000_000n);
    expect(parseUsdc("1")).toBe(10_000_000n);
    expect(parseUsdc("0.0000001")).toBe(1n);
    expect(parseUsdc("123.4567891")).toBe(1_234_567_891n);
    expect(parseUsdc(".5")).toBe(5_000_000n);
    expect(parseUsdc(" 2.5 ")).toBe(25_000_000n);
  });

  it("round-trips without floats", () => {
    for (const s of ["0", "1", "0.1", "0.0000001", "99999999.9999999", "123456789012.5"]) {
      expect(formatUsdc(parseUsdc(s))).toBe(s);
    }
    // 0.1 + 0.2 would be 0.30000000000000004 as floats.
    expect(formatUsdc(parseUsdc("0.1") + parseUsdc("0.2"))).toBe("0.3");
  });

  it("rejects malformed input", () => {
    for (const bad of ["1e5", "1E5", "", " ", "-1", "+1", "1,000", "abc", "1.2.3", "0x10", "Infinity", "NaN"]) {
      expect(() => parseUsdc(bad), bad).toThrow();
      expect(tryParseUsdc(bad)).toBeNull();
    }
  });

  it("rejects more than 7 decimals", () => {
    expect(() => parseUsdc("0.00000001")).toThrow(/7 decimal/);
    expect(() => parseUsdc("1.12345678")).toThrow(/7 decimal/);
  });

  it("accepts trailing dot and rejects lone dot", () => {
    expect(parseUsdc("1.")).toBe(10_000_000n);
    expect(() => parseUsdc(".")).toThrow();
    expect(tryParseUsdc(".")).toBeNull();
  });

  it("formats with options", () => {
    expect(formatUsdc(12_345_678_900_000n, { grouping: true, maxDecimals: 2, minDecimals: 2 })).toBe("1,234,567.89");
    expect(formatUsdc(15_000_000n, { minDecimals: 2 })).toBe("1.50");
    expect(formatUsdc(19_999_999n, { maxDecimals: 2 })).toBe("1.99"); // truncates, never rounds up
    expect(formatUsdc(-5n)).toBe("-0.0000005");
    expect(formatUsdc(12_345_678n, { maxDecimals: 0 })).toBe("1"); // maxDecimals 0 drops fraction
    expect(formatUsdc(12_000_000n, { minDecimals: 4 })).toBe("1.2000"); // minDecimals larger than available pads
    expect(formatUsdc(-12_345_678_900_000n, { grouping: true, maxDecimals: 2, minDecimals: 2 })).toBe("-1,234,567.89");
  });
});

describe("formatXlm", () => {
  it("uses 7 decimals and stroops unit", () => {
    expect(XLM_UNIT).toBe(10_000_000n);
    expect(formatXlm(10_000_000n)).toBe("1");
    expect(formatXlm(1n)).toBe("0.0000001");
    expect(formatXlm(123_456n)).toBe("0.0123456");
    expect(formatXlm(12_345_678_900_000n, { grouping: true })).toBe("1,234,567.89");
    expect(formatXlm(99_981_000_000n, { grouping: true })).toBe("9,998.1");
    expect(formatXlm(0n)).toBe("0");
    expect(formatXlm(5_000_000n, { minDecimals: 2 })).toBe("0.50");
  });
});

describe("slippage helpers round against the user", () => {
  it("minOut rounds down", () => {
    expect(minOut(10_000n, 100)).toBe(9_900n);
    expect(minOut(999n, 100)).toBe(989n); // 989.01 → 989
    expect(minOut(1n, 1)).toBe(0n);
    expect(minOut(12_345n, 0)).toBe(12_345n);
    expect(minOut(100n, 10_000)).toBe(0n); // BPS slippage yields 0
    expect(() => minOut(100n, 10_001)).toThrow();
    expect(() => minOut(-1n, 100)).toThrow();
    expect(() => minOut(100n, -1)).toThrow();
  });

  it("maxIn rounds up", () => {
    expect(maxIn(10_000n, 100)).toBe(10_100n);
    expect(maxIn(999n, 100)).toBe(1_009n); // 1008.99 → 1009
    expect(maxIn(1n, 1)).toBe(2n);
    expect(maxIn(12_345n, 0)).toBe(12_345n);
    expect(() => maxIn(-1n, 100)).toThrow();
    expect(() => maxIn(100n, -1)).toThrow();
  });

  it("maxIn rounds up at every remainder against reference ceil", () => {
    const targets = [1n, 9_999n, 10_001n];
    const bpsValues = [0, 1, 9_999];
    for (const target of targets) {
      for (const bps of bpsValues) {
        const num = target * (BPS + BigInt(bps));
        const q = num / BPS;
        const r = num % BPS;
        const refCeil = r !== 0n ? q + 1n : q;
        expect(maxIn(target, bps)).toBe(refCeil);
      }
    }
  });

  it("shareOf is a bigint share in bps", () => {
    expect(shareOf(1_000_000_000n, 1_250)).toBe(125_000_000n);
    expect(shareOf(7n, 5_000)).toBe(3n);
  });

  it("bpsToPercent formats decimals", () => {
    expect(bpsToPercent(150, 2)).toBe("1.50%");
    expect(bpsToPercent(500)).toBe("5.0%");
  });
});

describe("shortAddress", () => {
  it("keeps both ends", () => {
    expect(shortAddress("GCM7WU3RADBCIKBLGPPAEYV5WHASWMEQX6BU524QR3QFWSE7BIWCXAIF")).toBe("GCM7…XAIF");
    expect(shortAddress(null)).toBe("");
    expect(shortAddress("")).toBe("");
  });

  it("handles boundary length correctly", () => {
    // lead(4) + tail(4) + 1 = 9 characters
    expect(shortAddress("123456789")).toBe("123456789");
    expect(shortAddress("1234567890")).toBe("1234…7890");
  });
});

describe("property: units round trip (P8)", () => {
  function canonical(s: string): string {
    const trimmed = s.trim();
    const dotIdx = trimmed.indexOf(".");
    let whole = dotIdx === -1 ? trimmed : trimmed.slice(0, dotIdx);
    let frac = dotIdx === -1 ? "" : trimmed.slice(dotIdx + 1);
    whole = whole.replace(/^0+/, "");
    if (whole === "") whole = "0";
    frac = frac.replace(/0+$/, "");
    if (whole === "0" && frac === "") return "0";
    return frac.length > 0 ? `${whole}.${frac}` : whole;
  }

  it("formatUsdc(parseUsdc(x)) === canonical(x) for every usdcStringArb", () => {
    fc.assert(
      fc.property(usdcStringArb, (str) => {
        const parsed = parseUsdc(str);
        expect(formatUsdc(parsed)).toBe(canonical(str));
      }),
      { numRuns: 200 }
    );
  });

  it("parseUsdc(formatUsdc(n)) === n for any n in [0, 10^20]", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 20n }), (n) => {
        expect(parseUsdc(formatUsdc(n))).toBe(n);
      }),
      { numRuns: 200 }
    );
  });

  it("slippage and share invariants", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000_000n }),
        fc.integer({ min: 0, max: 5000 }),
        (amount, slippage) => {
          const min = minOut(amount, slippage);
          expect(min).toBeLessThanOrEqual(amount);
          const max = maxIn(min, slippage);
          expect(max).toBeGreaterThanOrEqual(min);
          expect(shareOf(amount, 10_000)).toBe(amount);
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe("mulDivFloor / mulDivCeil", () => {
  it("throws RangeError on negative operands or non-positive divisor", () => {
    expect(() => mulDivFloor(-1n, 5n, 2n)).toThrow(RangeError);
    expect(() => mulDivFloor(5n, -1n, 2n)).toThrow(RangeError);
    expect(() => mulDivFloor(5n, 2n, 0n)).toThrow(RangeError);
    expect(() => mulDivFloor(5n, 2n, -3n)).toThrow(RangeError);
    expect(() => mulDivCeil(-1n, 5n, 2n)).toThrow(RangeError);
    expect(() => mulDivCeil(5n, -1n, 2n)).toThrow(RangeError);
    expect(() => mulDivCeil(5n, 2n, 0n)).toThrow(RangeError);
    expect(() => mulDivCeil(5n, 2n, -3n)).toThrow(RangeError);
  });

  it("mulDivFloor/mulDivCeil match fpmm rounding on 10k random triples", () => {
    let state = 0x9e3779b9;
    const next = (max: bigint) => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return (BigInt(state) * max) / 4_294_967_296n;
    };

    for (let i = 0; i < 10_000; i++) {
      const a = next(1_000_000_000_000n);
      const b = next(1_000_000_000_000n);
      const c = next(1_000_000_000_000n) + 1n;

      const floor = mulDivFloor(a, b, c);
      const ceil = mulDivCeil(a, b, c);
      const product = a * b;

      expect(floor * c).toBeLessThanOrEqual(product);
      expect((floor + 1n) * c).toBeGreaterThan(product);
      expect(ceil * c).toBeGreaterThanOrEqual(product);
      if (ceil > 0n) {
        expect((ceil - 1n) * c).toBeLessThan(product);
      }
      expect(ceil - floor).toBe(product % c === 0n ? 0n : 1n);

      // Compare directly with fpmm's internal floor (priceYesBps) and ceil (calcBuy fee/newBought)
      if (a + b > 0n) {
        expect(mulDivFloor(b, FPMM_BPS, a + b)).toBe(priceYesBps(a, b));
      }
      if (a > 0n && b > 0n) {
        const feeBps = (c % 1_000n) + 1n;
        const collateralIn = (a % 1_000_000_000n) + 1_000n;
        const quote = calcBuy(a, b, collateralIn, feeBps);
        expect(mulDivCeil(collateralIn, feeBps, FPMM_BPS)).toBe(quote.fee);
        expect(mulDivCeil(a, b, b + quote.net)).toBe(quote.newReserveBought);
      }
    }
  });
});
