import { Schema } from "effect";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const NonBlankString = Schema.String.check(Schema.isPattern(/\S/));
const optional = Schema.optionalKey;
const supportedTimeZones = new Set(["UTC", ...Intl.supportedValuesOf("timeZone")]);

export const TimeZone = NonBlankString.check(
  Schema.makeFilter((value) =>
    supportedTimeZones.has(value) ? undefined : `Unsupported IANA time zone: ${value}`,
  ),
);
export type TimeZone = Schema.Schema.Type<typeof TimeZone>;

export const LoopId = NonBlankString;
export type LoopId = Schema.Schema.Type<typeof LoopId>;

export const Prompt = NonBlankString;
export type Prompt = Schema.Schema.Type<typeof Prompt>;

export const Retention = Schema.Literals(["session", "project"]);
export type Retention = Schema.Schema.Type<typeof Retention>;

export const StopReason = Schema.Literals(["completed", "cancelled", "expired"]);
export type StopReason = Schema.Schema.Type<typeof StopReason>;

export const CronSpec = Schema.Struct({
  expression: NonBlankString,
  timeZone: TimeZone,
  missed: Schema.Literal("coalesce"),
  jitterFraction: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  jitterCapMs: NonNegativeInt,
});
export type CronSpec = Schema.Schema.Type<typeof CronSpec>;

export const IntervalSpec = Schema.Struct({
  periodMs: PositiveInt,
  jitterFraction: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  jitterCapMs: NonNegativeInt,
});
export type IntervalSpec = Schema.Schema.Type<typeof IntervalSpec>;

export const Waiting = Schema.TaggedStruct("Waiting", {
  dueAt: NonNegativeInt,
  cursor: NonNegativeInt,
});
export type Waiting = Schema.Schema.Type<typeof Waiting>;

export const AwaitingArm = Schema.TaggedStruct("AwaitingArm", {
  cursor: NonNegativeInt,
});
export type AwaitingArm = Schema.Schema.Type<typeof AwaitingArm>;

export const Stopped = Schema.TaggedStruct("Stopped", {
  reason: StopReason,
  cursor: NonNegativeInt,
});
export type Stopped = Schema.Schema.Type<typeof Stopped>;

const BaseFields = {
  id: LoopId,
  prompt: Prompt,
  createdAt: NonNegativeInt,
  enabled: Schema.Boolean,
  manualCursor: NonNegativeInt,
  label: optional(NonBlankString),
};

export const OnceLoop = Schema.TaggedStruct("Once", {
  ...BaseFields,
  retention: Retention,
  phase: Schema.Union([Waiting, Stopped]),
});
export type OnceLoop = Schema.Schema.Type<typeof OnceLoop>;

export const CronLoop = Schema.TaggedStruct("Cron", {
  ...BaseFields,
  retention: Retention,
  spec: CronSpec,
  until: optional(NonNegativeInt),
  phase: Schema.Union([Waiting, Stopped]),
});
export type CronLoop = Schema.Schema.Type<typeof CronLoop>;

export const IntervalLoop = Schema.TaggedStruct("Interval", {
  ...BaseFields,
  retention: Retention,
  spec: IntervalSpec,
  until: optional(NonNegativeInt),
  phase: Schema.Union([Waiting, Stopped]),
});
export type IntervalLoop = Schema.Schema.Type<typeof IntervalLoop>;

export const ManualLoop = Schema.TaggedStruct("Manual", {
  ...BaseFields,
  retention: Schema.Literal("session"),
  phase: Schema.Union([Waiting, AwaitingArm, Stopped]),
});
export type ManualLoop = Schema.Schema.Type<typeof ManualLoop>;

export const Loop = Schema.Union([OnceLoop, CronLoop, IntervalLoop, ManualLoop]);
export type Loop = Schema.Schema.Type<typeof Loop>;

const LegacyBaseFields = {
  id: LoopId,
  prompt: Prompt,
  createdAt: NonNegativeInt,
  label: optional(NonBlankString),
};

const LegacyLoop = Schema.Union([
  Schema.TaggedStruct("Once", {
    ...LegacyBaseFields,
    retention: Retention,
    phase: Schema.Union([Waiting, Stopped]),
  }),
  Schema.TaggedStruct("Cron", {
    ...LegacyBaseFields,
    retention: Retention,
    spec: CronSpec,
    until: optional(NonNegativeInt),
    phase: Schema.Union([Waiting, Stopped]),
  }),
  Schema.TaggedStruct("Interval", {
    ...LegacyBaseFields,
    retention: Retention,
    spec: IntervalSpec,
    until: optional(NonNegativeInt),
    phase: Schema.Union([Waiting, Stopped]),
  }),
  Schema.TaggedStruct("Manual", {
    ...LegacyBaseFields,
    retention: Schema.Literal("session"),
    phase: Schema.Union([Waiting, AwaitingArm, Stopped]),
  }),
]);
export type LegacyLoop = Schema.Schema.Type<typeof LegacyLoop>;

export const DurableFileV1 = Schema.Struct({
  version: Schema.Literal(1),
  loops: Schema.Array(LegacyLoop),
});

export const DurableFile = Schema.Struct({
  version: Schema.Literal(2),
  loops: Schema.Array(Loop),
});
export type DurableFile = Schema.Schema.Type<typeof DurableFile>;

export const LoopConfig = Schema.Struct({
  maxLoops: PositiveInt,
  recurringMaxAgeMs: NonNegativeInt,
  recurringJitterFraction: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  recurringJitterCapMs: NonNegativeInt,
  checkIntervalMs: PositiveInt,
  durableFilePath: NonBlankString,
  timeZone: TimeZone,
});
export type LoopConfig = Schema.Schema.Type<typeof LoopConfig>;

export const DEFAULT_CONFIG: LoopConfig = {
  maxLoops: 50,
  recurringMaxAgeMs: 7 * 24 * 60 * 60 * 1_000,
  recurringJitterFraction: 0.5,
  recurringJitterCapMs: 30 * 60 * 1_000,
  checkIntervalMs: 1_000,
  durableFilePath: ".pi-loop.json",
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
};

export type Occurrence = {
  readonly id: string;
  readonly loopId: LoopId;
  readonly cursor: number;
  readonly prompt: Prompt;
  readonly dueAt: number;
  readonly claimedAt: number;
  readonly trigger: "scheduled" | "manual";
};

export type CreateLoop =
  | {
      readonly _tag: "Once";
      readonly id: LoopId;
      readonly prompt: Prompt;
      readonly retention: Retention;
      readonly createdAt: number;
      readonly dueAt: number;
      readonly label?: string;
    }
  | {
      readonly _tag: "Cron";
      readonly id: LoopId;
      readonly prompt: Prompt;
      readonly retention: Retention;
      readonly createdAt: number;
      readonly firstDueAt: number;
      readonly spec: CronSpec;
      readonly until?: number;
      readonly label?: string;
    }
  | {
      readonly _tag: "Interval";
      readonly id: LoopId;
      readonly prompt: Prompt;
      readonly retention: Retention;
      readonly createdAt: number;
      readonly firstDueAt: number;
      readonly spec: IntervalSpec;
      readonly until?: number;
      readonly label?: string;
    }
  | {
      readonly _tag: "Manual";
      readonly id: LoopId;
      readonly prompt: Prompt;
      readonly retention: "session";
      readonly createdAt: number;
      readonly firstDueAt: number;
      readonly label?: string;
    };

export const createLoop = (input: CreateLoop): Loop => {
  const common = {
    id: input.id,
    prompt: input.prompt,
    retention: input.retention,
    createdAt: input.createdAt,
    enabled: true,
    manualCursor: 0,
    ...(input.label === undefined ? {} : { label: input.label }),
  };
  switch (input._tag) {
    case "Once":
      return {
        _tag: "Once",
        ...common,
        phase: { _tag: "Waiting", dueAt: input.dueAt, cursor: 0 },
      };
    case "Cron":
      return {
        _tag: "Cron",
        ...common,
        spec: input.spec,
        ...(input.until === undefined ? {} : { until: input.until }),
        phase: { _tag: "Waiting", dueAt: input.firstDueAt, cursor: 0 },
      };
    case "Interval":
      return {
        _tag: "Interval",
        ...common,
        spec: input.spec,
        ...(input.until === undefined ? {} : { until: input.until }),
        phase: { _tag: "Waiting", dueAt: input.firstDueAt, cursor: 0 },
      };
    case "Manual":
      return {
        _tag: "Manual",
        ...common,
        retention: "session",
        phase: { _tag: "Waiting", dueAt: input.firstDueAt, cursor: 0 },
      };
  }
};

const dynamicInstruction = (id: string) =>
  `\n\n[pi-loop: dynamic loop ${id}. After this iteration call ` +
  `schedule_wakeup with loopId "${id}" and a delay of 60-3600 seconds. ` +
  "Omit the call to stop.]";

export const occurrencePrompt = (loop: Loop): Prompt =>
  loop._tag === "Manual" ? `${loop.prompt}${dynamicInstruction(loop.id)}` : loop.prompt;

export const migrateLegacyLoop = (loop: LegacyLoop): Loop => {
  const suffix = loop._tag === "Manual" ? dynamicInstruction(loop.id) : "";
  const prompt =
    suffix && loop.prompt.endsWith(suffix) ? loop.prompt.slice(0, -suffix.length) : loop.prompt;
  return { ...loop, prompt, enabled: true, manualCursor: 0 } as Loop;
};
