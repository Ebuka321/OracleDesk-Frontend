import { describe, expect, it, vi } from "vitest";
import { dirForLocale } from "../direction";

describe("dirForLocale", () => {
  it("returns rtl for Arabic, Persian, Hebrew, and Urdu", () => {
    expect(dirForLocale("ar")).toBe("rtl");
    expect(dirForLocale("ar-EG")).toBe("rtl");
    expect(dirForLocale("fa")).toBe("rtl");
    expect(dirForLocale("he")).toBe("rtl");
    expect(dirForLocale("ur")).toBe("rtl");
  });

  it("returns ltr for English, German, and Japanese", () => {
    expect(dirForLocale("en")).toBe("ltr");
    expect(dirForLocale("en-US")).toBe("ltr");
    expect(dirForLocale("de")).toBe("ltr");
    expect(dirForLocale("ja")).toBe("ltr");
  });

  it("handles ar-Latn as ltr", () => {
    expect(dirForLocale("ar-Latn")).toBe("ltr");
  });

  it("falls back cleanly when Intl.Locale.getTextInfo is unavailable", () => {
    const OrigLocale = Intl.Locale;
    const MockLocale = class {
      language: string;
      script?: string;
      constructor(tag: string) {
        const parts = tag.split("-");
        this.language = parts[0] ?? "en";
        this.script = parts[1]?.length === 4 ? parts[1] : undefined;
      }
    };
    vi.stubGlobal("Intl", { ...Intl, Locale: MockLocale });
    try {
      expect(dirForLocale("ar")).toBe("rtl");
      expect(dirForLocale("he")).toBe("rtl");
      expect(dirForLocale("en")).toBe("ltr");
      expect(dirForLocale("ar-Latn")).toBe("ltr");
    } finally {
      vi.stubGlobal("Intl", { ...Intl, Locale: OrigLocale });
    }
  });
});
