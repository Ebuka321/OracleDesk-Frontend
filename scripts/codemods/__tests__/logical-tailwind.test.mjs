import { describe, expect, it } from "vitest";
import { transformClassString, transformSource } from "../logical-tailwind.mjs";

describe("logical-tailwind codemod", () => {
  it("rewrites physical spacing and alignment utilities", () => {
    expect(transformClassString("ml-2 mr-4 pl-1 pr-3 text-left text-right")).toBe(
      "ms-2 me-4 ps-1 pe-3 text-start text-end",
    );
  });

  it("preserves variant prefixes", () => {
    expect(transformClassString("hover:pr-4 sm:ml-2 focus:left-4")).toBe(
      "hover:pe-4 sm:ms-2 focus:start-4",
    );
  });

  it("leaves left-1/2 paired with -translate-x-1/2 untouched", () => {
    expect(transformClassString("absolute left-1/2 -translate-x-1/2 top-0")).toBe(
      "absolute left-1/2 -translate-x-1/2 top-0",
    );
  });

  it("rewrites standalone left-4 and right-0", () => {
    expect(transformClassString("fixed bottom-4 left-4 right-0")).toBe(
      "fixed bottom-4 start-4 end-0",
    );
  });

  it("handles JSX className strings and template expressions", () => {
    const input = `<div className="ml-1" /><span className={\`\${x} pr-2\`} />`;
    const res = transformSource(input);
    expect(res.changed).toBe(true);
    expect(res.code).toContain('className="ms-1"');
    expect(res.skippedTemplates).toBe(1);
  });
});
