import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { createLoop, Loop as LoopSchema, type Loop } from "../src/domain/model.js";
import { arm, cancel, tick } from "../src/domain/transition.js";

const manual = (): Loop =>
  createLoop({
    _tag: "Manual",
    id: "loop-1",
    prompt: "inspect build",
    retention: "session",
    createdAt: 100,
    firstDueAt: 100,
  });

describe("temporal transition", () => {
  it("preserves state while admission is closed", () => {
    const loop = manual();
    expect(tick(loop, 200, "closed")).toEqual({ loop });
  });

  it("claims one cursor once and waits for manual arm", () => {
    const first = tick(manual(), 100, "open");
    expect(first.occurrence?.id).toBe("loop-1:0");
    expect(first.loop.phase).toEqual({ _tag: "AwaitingArm", cursor: 1 });
    expect(tick(first.loop, 200, "open")).toEqual({ loop: first.loop });
  });

  it("only arms a manual loop that is awaiting an arm", () => {
    const loop = manual();
    expect(arm(loop, 300)).toBeUndefined();
    const claimed = tick(loop, 100, "open").loop;
    expect(arm(claimed, 300)?.phase).toEqual({ _tag: "Waiting", dueAt: 300, cursor: 1 });
  });

  it("makes cancellation terminal", () => {
    const stopped = cancel(manual());
    expect(cancel(stopped)).toBe(stopped);
    expect(tick(stopped, 1_000, "open")).toEqual({ loop: stopped });
  });

  it("keeps arbitrary fixed intervals exact across clock boundaries", () => {
    const loop = createLoop({
      _tag: "Interval",
      id: "interval-7m",
      prompt: "poll",
      retention: "session",
      createdAt: 3_480_000,
      firstDueAt: 3_480_000,
      spec: { periodMs: 420_000, jitterFraction: 0, jitterCapMs: 0 },
    });
    const claimed = tick(loop, 3_480_000, "open").loop;
    expect(claimed.phase).toEqual({ _tag: "Waiting", dueAt: 3_900_000, cursor: 1 });
  });

  it("cannot decode a project-retained manual loop", () => {
    expect(() =>
      Schema.decodeUnknownSync(LoopSchema)({
        _tag: "Manual",
        id: "illegal",
        prompt: "x",
        retention: "project",
        createdAt: 1,
        phase: { _tag: "AwaitingArm", cursor: 1 },
      }),
    ).toThrow();
  });
});
