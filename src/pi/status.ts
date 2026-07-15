import { Schema } from "effect";
import type { Loop } from "../domain/model.js";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

export const LoopScheduleProjection = Schema.Union([
  Schema.TaggedStruct("Interval", { periodMs: PositiveInt }),
  Schema.TaggedStruct("Dynamic", {}),
  Schema.TaggedStruct("Cron", {
    expression: Schema.NonEmptyString,
    timeZone: Schema.NonEmptyString,
  }),
  Schema.TaggedStruct("Once", {}),
]);

export const LoopPhaseProjection = Schema.Union([
  Schema.TaggedStruct("Scheduled", { dueAt: NonNegativeInt }),
  Schema.TaggedStruct("AwaitingAgent", {}),
  Schema.TaggedStruct("Paused", { dueAt: Schema.optionalKey(NonNegativeInt) }),
]);

export const LoopProjection = Schema.Struct({
  id: Schema.NonEmptyString,
  prompt: Schema.NonEmptyString,
  label: Schema.optionalKey(Schema.NonEmptyString),
  createdAt: NonNegativeInt,
  enabled: Schema.Boolean,
  retention: Schema.Literals(["session", "project"]),
  schedule: LoopScheduleProjection,
  phase: LoopPhaseProjection,
});
export type LoopProjection = typeof LoopProjection.Type;

export const LoopStatusProjection = Schema.Struct({
  kind: Schema.Literal("pi-loop/status"),
  version: Schema.Literal(1),
  sessionId: Schema.NonEmptyString,
  observedAt: NonNegativeInt,
  loops: Schema.Array(LoopProjection),
});
export type LoopStatusProjection = typeof LoopStatusProjection.Type;

export const RuntimeLeaseProjection = Schema.Struct({
  kind: Schema.Literal("pi/runtime-lease"),
  version: Schema.Literal(1),
  owner: Schema.NonEmptyString,
  reason: Schema.NonEmptyString,
});

export const LoopControlRequest = Schema.Struct({
  kind: Schema.Literal("pi-loop/control"),
  version: Schema.Literal(1),
  action: Schema.Union([
    Schema.TaggedStruct("CreateInterval", { periodMs: PositiveInt, prompt: Schema.NonEmptyString }),
    Schema.TaggedStruct("UpdateInterval", {
      id: Schema.NonEmptyString,
      periodMs: PositiveInt,
      prompt: Schema.NonEmptyString,
    }),
    Schema.TaggedStruct("SetEnabled", { id: Schema.NonEmptyString, enabled: Schema.Boolean }),
    Schema.TaggedStruct("Delete", { id: Schema.NonEmptyString }),
    Schema.TaggedStruct("RunNow", { id: Schema.NonEmptyString }),
  ]),
});
export type LoopControlRequest = typeof LoopControlRequest.Type;

const schedule = (loop: Loop): LoopProjection["schedule"] => {
  switch (loop._tag) {
    case "Interval":
      return { _tag: "Interval", periodMs: loop.spec.periodMs };
    case "Manual":
      return { _tag: "Dynamic" };
    case "Cron":
      return { _tag: "Cron", expression: loop.spec.expression, timeZone: loop.spec.timeZone };
    case "Once":
      return { _tag: "Once" };
  }
};

const phase = (loop: Loop): LoopProjection["phase"] => {
  if (!loop.enabled) {
    return {
      _tag: "Paused",
      ...(loop.phase._tag === "Waiting" ? { dueAt: loop.phase.dueAt } : {}),
    };
  }
  return loop.phase._tag === "Waiting"
    ? { _tag: "Scheduled", dueAt: loop.phase.dueAt }
    : { _tag: "AwaitingAgent" };
};

export const projectLoop = (loop: Loop): LoopProjection => ({
  id: loop.id,
  prompt: loop.prompt,
  ...(loop.label === undefined ? {} : { label: loop.label }),
  createdAt: loop.createdAt,
  enabled: loop.enabled,
  retention: loop.retention,
  schedule: schedule(loop),
  phase: phase(loop),
});

export const projectLoops = (loops: ReadonlyArray<Loop>): ReadonlyArray<LoopProjection> =>
  [...loops]
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map(projectLoop);
