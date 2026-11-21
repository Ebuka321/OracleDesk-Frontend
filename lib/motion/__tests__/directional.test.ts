import { describe, expect, it } from "vitest";
import { slideIn } from "../directional";

describe("slideIn", () => {
  it("slides in from negative x and exits to positive x in ltr", () => {
    const v = slideIn("ltr", 20);
    expect(v.initial).toEqual({ opacity: 0, x: -20 });
    expect(v.animate).toEqual({ opacity: 1, x: 0 });
    expect(v.exit).toEqual({ opacity: 0, x: 20 });
  });

  it("flips horizontal slide sign in rtl", () => {
    const v = slideIn("rtl", 20);
    expect(v.initial).toEqual({ opacity: 0, x: 20 });
    expect(v.animate).toEqual({ opacity: 1, x: 0 });
    expect(v.exit).toEqual({ opacity: 0, x: -20 });
  });
});
