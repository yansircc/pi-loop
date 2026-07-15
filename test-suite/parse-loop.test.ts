import { describe, expect, it } from "@effect/vitest";
import { parseLoop } from "../src/pi/parse-loop.js";

describe("loop input algebra", () => {
  it("separates elapsed intervals from prompts", () => {
    expect(parseLoop("7m inspect build")).toEqual({
      _tag: "Fixed",
      interval: "7m",
      prompt: "inspect build",
    });
    expect(parseLoop("inspect build every 25 hours")).toEqual({
      _tag: "Fixed",
      interval: "25h",
      prompt: "inspect build",
    });
  });

  it("rejects an interval with no prompt", () => {
    expect(parseLoop("5m")).toBeUndefined();
    expect(parseLoop("every 5 minutes")).toBeUndefined();
  });

  it("treats inputs without a time expression as dynamic", () => {
    expect(parseLoop("monitor deploy")).toEqual({ _tag: "Dynamic", prompt: "monitor deploy" });
  });
});
