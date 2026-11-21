import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SafeText } from "../safe-text";
import { QuestionVerificationBadge } from "../question-verification-badge";
import { SafeTraceViewer } from "../safe-trace-viewer";

describe("SafeText Component", () => {
  it("renders plain safe text with no warnings", () => {
    render(<SafeText text="Will Bitcoin reach $100k?" />);
    expect(screen.getByText("Will Bitcoin reach $100k?")).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows warning and escaped view toggle when bidi is detected", () => {
    const rloText = "Market \u202Ereversed\u202C question";
    render(<SafeText text={rloText} />);

    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByText(/Hidden chars/i)).toBeDefined();

    // Toggle inspect tokens
    const button = screen.getByRole("button", { name: /inspect <tokens>/i });
    fireEvent.click(button);

    expect(screen.getByText(/<U\+202E>/)).toBeDefined();
  });

  it("renders confusable badge for mixed script", () => {
    const mixed = "Source: Re\u043Eters"; // Cyrillic small 'о'
    render(<SafeText text={mixed} />);

    expect(screen.getByText(/Confusables/i)).toBeDefined();
  });
});

describe("QuestionVerificationBadge Text Safety Integration", () => {
  it("shows qualified warning state when question contains bidi overrides", () => {
    const bidiQuestion = "Will Fed cut \u202Erates\u202C in Q4?";
    render(
      <QuestionVerificationBadge
        status="verified"
        displayedText={bidiQuestion}
      />
    );

    expect(screen.getByText(/contains hidden or deceptive characters/i)).toBeDefined();
    expect(screen.queryByText(/^Question Verified$/i)).toBeNull();
  });

  it("shows softer warning when question contains confusables", () => {
    const confusableQuestion = "Will Re\u043Eters publish the report?";
    render(
      <QuestionVerificationBadge
        status="verified"
        displayedText={confusableQuestion}
      />
    );

    expect(screen.getByText(/confusable warnings/i)).toBeDefined();
  });

  it("shows normal Question Verified for clean text", () => {
    render(
      <QuestionVerificationBadge
        status="verified"
        displayedText="Will the Fed cut rates in Q4?"
      />
    );

    expect(screen.getByText("Question Verified")).toBeDefined();
  });
});

describe("SafeTraceViewer Qualified Verified Badge", () => {
  it("shows qualified warning badge when trace content has bidi", () => {
    const maliciousContent = {
      version: 1,
      reasoning: "Legitimate \u202Edeceptive\u202C text",
      sources: [],
    };

    render(<SafeTraceViewer content={maliciousContent} verified={true} />);

    expect(screen.getByText(/contains hidden or deceptive characters/i)).toBeDefined();
  });
});
