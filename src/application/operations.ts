import { Clock, Data, Effect } from "effect";
import { nextCronDue, nextCronInstant, parseCron, parseIntervalMs } from "../domain/cron.js";
import { createLoop, type Loop, type LoopConfig, type Retention } from "../domain/model.js";
import type { LoopRepository } from "./repository.js";

export class InvalidSchedule extends Data.TaggedError("InvalidSchedule")<{
  readonly input: string;
}> {}

export class DelayOutOfRange extends Data.TaggedError("DelayOutOfRange")<{
  readonly delaySeconds: number;
}> {}

export type CronInput = {
  readonly expression: string;
  readonly prompt: string;
  readonly recurring: boolean;
  readonly retention: Retention;
  readonly label?: string;
};

const loopId = (): string => globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 8);

const cronSpec = (expression: string, config: LoopConfig) => ({
  expression,
  timeZone: config.timeZone,
  missed: "coalesce" as const,
  jitterFraction: config.recurringJitterFraction,
  jitterCapMs: config.recurringJitterCapMs,
});

export const makeLoopOperations = (repository: LoopRepository, config: LoopConfig) => {
  const createFixed = (interval: string, prompt: string) =>
    Effect.gen(function* () {
      const periodMs = parseIntervalMs(interval);
      if (!periodMs) return yield* new InvalidSchedule({ input: interval });
      const now = yield* Clock.currentTimeMillis;
      const id = loopId();
      const loop = createLoop({
        _tag: "Interval",
        id,
        prompt,
        retention: "session",
        createdAt: now,
        firstDueAt: now,
        spec: {
          periodMs,
          jitterFraction: config.recurringJitterFraction,
          jitterCapMs: config.recurringJitterCapMs,
        },
        ...(config.recurringMaxAgeMs === 0 ? {} : { until: now + config.recurringMaxAgeMs }),
      });
      yield* repository.add(loop);
      return loop;
    });

  const createDynamic = (prompt: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const id = loopId();
      const storedPrompt =
        `${prompt}\n\n[pi-loop: dynamic loop ${id}. After this iteration call ` +
        `schedule_wakeup with loopId "${id}" and a delay of 60-3600 seconds. ` +
        "Omit the call to stop.]";
      const loop = createLoop({
        _tag: "Manual",
        id,
        prompt: storedPrompt,
        retention: "session",
        createdAt: now,
        firstDueAt: now,
      });
      yield* repository.add(loop);
      return loop;
    });

  const createCron = (input: CronInput) =>
    Effect.gen(function* () {
      if (!parseCron(input.expression)) {
        return yield* new InvalidSchedule({ input: input.expression });
      }
      const now = yield* Clock.currentTimeMillis;
      const id = loopId();
      const spec = cronSpec(input.expression, config);
      const base = nextCronInstant(spec, now);
      if (base === undefined) return yield* new InvalidSchedule({ input: input.expression });
      const firstDueAt = input.recurring ? (nextCronDue(spec, now, id, 0) ?? base) : base;
      const common = {
        id,
        prompt: input.prompt,
        retention: input.retention,
        createdAt: now,
        ...(input.label === undefined ? {} : { label: input.label }),
      };
      const loop: Loop = input.recurring
        ? createLoop({
            _tag: "Cron",
            ...common,
            firstDueAt,
            spec,
            ...(config.recurringMaxAgeMs === 0 ? {} : { until: now + config.recurringMaxAgeMs }),
          })
        : createLoop({ _tag: "Once", ...common, dueAt: firstDueAt });
      yield* repository.add(loop);
      return loop;
    });

  const scheduleWakeup = (id: string, delaySeconds: number) =>
    Effect.gen(function* () {
      if (!Number.isFinite(delaySeconds) || delaySeconds < 60 || delaySeconds > 3_600) {
        return yield* new DelayOutOfRange({ delaySeconds });
      }
      const now = yield* Clock.currentTimeMillis;
      return yield* repository.arm(id, now + Math.floor(delaySeconds * 1_000));
    });

  return {
    createFixed,
    createDynamic,
    createCron,
    scheduleWakeup,
    list: repository.list,
    remove: repository.remove,
    removeAll: repository.removeAll,
  } as const;
};

export type LoopOperations = ReturnType<typeof makeLoopOperations>;
