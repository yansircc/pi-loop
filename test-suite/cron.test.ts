import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { nextCronInstant, parseCron, parseIntervalMs } from "../src/domain/cron.js";
import { TimeZone } from "../src/domain/model.js";

describe("cron algebra", () => {
  it("parses ranges, lists, and steps", () => {
    expect(parseCron("*/5 9-17 * * 1-5")).toBeDefined();
    expect(parseCron("61 * * * *")).toBeUndefined();
  });

  it("uses standard OR semantics when day-of-month and weekday are both restricted", () => {
    const after = Date.UTC(2026, 6, 1, 0, 0);
    const next = nextCronInstant(
      {
        expression: "0 9 15 * 1",
        timeZone: "UTC",
        missed: "coalesce",
        jitterFraction: 0,
        jitterCapMs: 0,
      },
      after,
    );
    expect(next).toBe(Date.UTC(2026, 6, 6, 9, 0));
  });

  it("preserves exact elapsed intervals", () => {
    expect(parseIntervalMs("7m")).toBe(420_000);
    expect(parseIntervalMs("25h")).toBe(90_000_000);
    expect(parseIntervalMs("0m")).toBeUndefined();
  });

  it("rejects unsupported time zones at the boundary", () => {
    expect(() => Schema.decodeUnknownSync(TimeZone)("Mars/Olympus")).toThrow();
    expect(Schema.decodeUnknownSync(TimeZone)("UTC")).toBe("UTC");
  });
});
