import { expect, it } from "@effect/vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect, Exit } from "effect";
import { createLoop } from "../src/domain/model.js";
import { makeSessionLoopPersistence } from "../src/pi/session-state.js";
import { projectLoop, projectLoops } from "../src/pi/status.js";

const loop = createLoop({
  _tag: "Interval",
  id: "automation-a",
  prompt: "inspect the project",
  retention: "session",
  createdAt: 1_000,
  firstDueAt: 61_000,
  spec: { periodMs: 60_000, jitterFraction: 0, jitterCapMs: 0 },
});

it.effect("restores session automation only for the owning session", () =>
  Effect.gen(function* () {
    const entries: Array<unknown> = [];
    const pi = {
      appendEntry: (customType: string, data: unknown) =>
        entries.push({ type: "custom", customType, data }),
    } as unknown as ExtensionAPI;
    const context = (sessionId: string) =>
      ({
        sessionManager: {
          getSessionId: () => sessionId,
          getEntries: () => entries,
        },
      }) as unknown as ExtensionContext;

    const owner = yield* makeSessionLoopPersistence(pi, context("session-a"));
    expect(owner.initial).toEqual([]);
    yield* owner.persist([loop]);
    expect((yield* makeSessionLoopPersistence(pi, context("session-a"))).initial).toEqual([loop]);
    expect((yield* makeSessionLoopPersistence(pi, context("forked-session"))).initial).toEqual([]);
  }),
);

it("projects the canonical schedule and phase", () => {
  expect(projectLoop(loop)).toEqual({
    id: "automation-a",
    prompt: "inspect the project",
    createdAt: 1_000,
    enabled: true,
    retention: "session",
    schedule: { _tag: "Interval", periodMs: 60_000 },
    phase: { _tag: "Scheduled", dueAt: 61_000 },
  });
  expect(projectLoop({ ...loop, enabled: false }).phase).toEqual({ _tag: "Paused", dueAt: 61_000 });
});

it("projects every loop in stable creation order", () => {
  const later = { ...loop, id: "automation-b", createdAt: 2_000 };
  expect(projectLoops([later, loop]).map((item) => item.id)).toEqual([
    "automation-a",
    "automation-b",
  ]);
});

it.effect("fails closed instead of reviving an older state after corruption", () =>
  Effect.gen(function* () {
    const entries: Array<unknown> = [
      {
        type: "custom",
        customType: "pi-loop/session-state",
        data: { version: 1, sessionId: "session-a", loops: [loop] },
      },
      {
        type: "custom",
        customType: "pi-loop/session-state",
        data: { version: 1, sessionId: "session-a", loops: "corrupt" },
      },
    ];
    const context = {
      sessionManager: {
        getSessionId: () => "session-a",
        getEntries: () => entries,
      },
    } as unknown as ExtensionContext;
    const result = yield* Effect.exit(makeSessionLoopPersistence({} as ExtensionAPI, context));
    expect(Exit.isFailure(result)).toBe(true);
  }),
);
