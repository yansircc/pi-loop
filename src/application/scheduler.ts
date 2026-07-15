import { Clock, Data, Effect, Fiber, Ref, Schedule } from "effect";
import type { LoopConfig, Occurrence } from "../domain/model.js";
import type { LoopRepository, MutationError, RepositoryFailure } from "./repository.js";

export type PromptDelivery = (occurrence: Occurrence) => Effect.Effect<void, PromptDeliveryFailure>;

export class PromptDeliveryFailure extends Data.TaggedError("PromptDeliveryFailure")<{
  readonly occurrenceId: string;
  readonly cause: unknown;
}> {}

export type Scheduler = {
  readonly setBusy: Effect.Effect<void>;
  readonly setIdle: Effect.Effect<void>;
  readonly drain: Effect.Effect<void, RepositoryFailure>;
  readonly runNow: (id: string) => Effect.Effect<void, MutationError | PromptDeliveryFailure>;
  readonly run: Effect.Effect<never, RepositoryFailure>;
};

export const makeScheduler = (
  repository: LoopRepository,
  deliver: PromptDelivery,
  config: LoopConfig,
): Effect.Effect<Scheduler> =>
  Effect.gen(function* () {
    const busy = yield* Ref.make(false);
    const tick = Effect.gen(function* () {
      const isBusy = yield* Ref.get(busy);
      const now = yield* Clock.currentTimeMillis;
      for (const retention of ["session", "project"] as const) {
        const occurrences = yield* repository.claimDue(now, isBusy ? "closed" : "open", retention);
        yield* Effect.forEach(occurrences, (item) =>
          deliver(item).pipe(
            Effect.catch((error) =>
              Effect.logError("pi-loop delivery lost after claim", {
                occurrenceId: item.id,
                cause: error,
              }),
            ),
          ),
        );
      }
    });
    return {
      setBusy: Ref.set(busy, true),
      setIdle: Ref.set(busy, false),
      drain: tick,
      runNow: (id) =>
        Effect.gen(function* () {
          const isBusy = yield* Ref.get(busy);
          const now = yield* Clock.currentTimeMillis;
          const occurrence = yield* repository.claimNow(id, now, isBusy ? "closed" : "open");
          yield* deliver(occurrence);
        }),
      run: tick.pipe(
        Effect.repeat({ schedule: Schedule.spaced(`${config.checkIntervalMs} millis`) }),
      ) as Effect.Effect<never, RepositoryFailure>,
    };
  });

export const stopScheduler = (fiber: Fiber.Fiber<never, RepositoryFailure>) =>
  Fiber.interrupt(fiber).pipe(Effect.asVoid);
