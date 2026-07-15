import { Clock, Data, Effect, Ref, Schema, Semaphore } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { arm as armTransition, cancel, tick, type Gate } from "../domain/transition.js";
import {
  DurableFile,
  DurableFileV1,
  migrateLegacyLoop,
  occurrencePrompt,
  type Loop,
  type LoopConfig,
  type LoopId,
  type Occurrence,
} from "../domain/model.js";

export class RepositoryFailure extends Data.TaggedError("RepositoryFailure")<{
  readonly operation: "load" | "persist" | "lease";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class LeaseUnavailable extends Data.TaggedError("LeaseUnavailable")<{
  readonly message: string;
}> {}

export class CapacityExceeded extends Data.TaggedError("CapacityExceeded")<{
  readonly maximum: number;
}> {}

export class LoopNotFound extends Data.TaggedError("LoopNotFound")<{
  readonly id: string;
}> {}

export class LoopStateConflict extends Data.TaggedError("LoopStateConflict")<{
  readonly id: string;
  readonly expected: string;
}> {}

export type MutationError =
  | RepositoryFailure
  | LeaseUnavailable
  | CapacityExceeded
  | LoopNotFound
  | LoopStateConflict;

export type LoopRepository = {
  readonly leaseOwned: boolean;
  readonly add: (loop: Loop) => Effect.Effect<void, MutationError>;
  readonly list: Effect.Effect<ReadonlyArray<Loop>>;
  readonly get: (id: LoopId) => Effect.Effect<Loop, LoopNotFound>;
  readonly remove: (id: LoopId) => Effect.Effect<Loop, MutationError>;
  readonly removeAll: (
    retention: Loop["retention"],
  ) => Effect.Effect<ReadonlyArray<Loop>, RepositoryFailure | LeaseUnavailable>;
  readonly arm: (id: LoopId, at: number) => Effect.Effect<Loop, MutationError>;
  readonly updateInterval: (
    id: LoopId,
    periodMs: number,
    prompt: string,
    now: number,
  ) => Effect.Effect<Loop, MutationError>;
  readonly setEnabled: (id: LoopId, enabled: boolean) => Effect.Effect<Loop, MutationError>;
  readonly claimNow: (
    id: LoopId,
    now: number,
    gate: Gate,
  ) => Effect.Effect<Occurrence, MutationError>;
  readonly claimDue: (
    now: number,
    gate: Gate,
    retention: Loop["retention"],
  ) => Effect.Effect<ReadonlyArray<Occurrence>, RepositoryFailure>;
  readonly release: Effect.Effect<void, RepositoryFailure>;
};

export type SessionLoopPersistence = {
  readonly initial: ReadonlyArray<Loop>;
  readonly persist: (loops: ReadonlyArray<Loop>) => Effect.Effect<void, RepositoryFailure>;
};

const repositoryFailure =
  (operation: RepositoryFailure["operation"], message: string) => (cause: unknown) =>
    new RepositoryFailure({ operation, message, cause });

const LockFile = Schema.Struct({ pid: Schema.Int, acquiredAt: Schema.Int });

class PidProbeFailure extends Data.TaggedError("PidProbeFailure")<{
  readonly permissionDenied: boolean;
}> {}

const isPidAlive = (pid: number) =>
  Effect.try({
    try: () => {
      process.kill(pid, 0);
      return true;
    },
    catch: (cause) =>
      new PidProbeFailure({
        permissionDenied:
          typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EPERM",
      }),
  }).pipe(
    Effect.match({
      onFailure: (failure) => failure.permissionDenied,
      onSuccess: () => true,
    }),
  );

const PersistedFile = Schema.Union([DurableFile, DurableFileV1]);

const decodeDurableFile = (encoded: string, filePath: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(PersistedFile), {
    onExcessProperty: "error",
  })(encoded).pipe(
    Effect.map((file) => (file.version === 1 ? file.loops.map(migrateLegacyLoop) : file.loops)),
    Effect.mapError(repositoryFailure("load", `Invalid durable file ${filePath}`)),
  );

export const makeLoopRepository = (
  cwd: string,
  config: LoopConfig,
  sessionPersistence?: SessionLoopPersistence,
): Effect.Effect<LoopRepository, RepositoryFailure, FileSystem | Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;
    const filePath = path.join(cwd, config.durableFilePath);
    const lockPath = `${filePath}.lock`;
    const mutationLock = yield* Semaphore.make(1);
    const acquiredAt = yield* Clock.currentTimeMillis;

    const tryAcquire = fs
      .writeFileString(lockPath, JSON.stringify({ pid: process.pid, acquiredAt }), {
        flag: "wx",
        mode: 0o600,
      })
      .pipe(
        Effect.as(true),
        Effect.catch((error) =>
          error.reason._tag === "AlreadyExists"
            ? Effect.succeed(false)
            : Effect.fail(repositoryFailure("lease", `Could not create ${lockPath}`)(error)),
        ),
      );

    let leaseOwned = yield* tryAcquire;
    if (!leaseOwned) {
      const stale = yield* fs.readFileString(lockPath).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(LockFile))),
        Effect.flatMap(({ pid }) => isPidAlive(pid).pipe(Effect.map((alive) => !alive))),
        Effect.orElseSucceed(() => false),
      );
      if (stale) {
        yield* fs
          .remove(lockPath, { force: true })
          .pipe(Effect.mapError(repositoryFailure("lease", `Could not remove stale ${lockPath}`)));
        leaseOwned = yield* tryAcquire;
      }
    }

    const loaded = new Map<LoopId, Loop>();
    if (leaseOwned) {
      const durableExists = yield* fs
        .exists(filePath)
        .pipe(Effect.mapError(repositoryFailure("load", `Could not inspect ${filePath}`)));
      if (durableExists) {
        const durable = yield* Effect.gen(function* () {
          const encoded = yield* fs
            .readFileString(filePath)
            .pipe(Effect.mapError(repositoryFailure("load", `Could not read ${filePath}`)));
          return yield* decodeDurableFile(encoded, filePath);
        }).pipe(Effect.onError(() => fs.remove(lockPath, { force: true }).pipe(Effect.ignore)));
        for (const loop of durable) loaded.set(loop.id, loop);
      }
    }
    for (const loop of sessionPersistence?.initial ?? []) {
      if (loaded.has(loop.id)) {
        return yield* new RepositoryFailure({
          operation: "load",
          message: `Duplicate loop id ${loop.id}`,
        });
      }
      loaded.set(loop.id, loop);
    }
    const state = yield* Ref.make<ReadonlyMap<LoopId, Loop>>(loaded);

    const persist = (next: ReadonlyMap<LoopId, Loop>) =>
      Effect.gen(function* () {
        const loops = [...next.values()].filter((loop) => loop.retention === "project");
        const encoded = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(DurableFile))({
          version: 2,
          loops,
        }).pipe(Effect.mapError(repositoryFailure("persist", `Could not encode ${filePath}`)));
        const temporary = `${filePath}.staging-${globalThis.crypto.randomUUID()}`;
        yield* fs
          .writeFileString(temporary, encoded, { flag: "wx", mode: 0o600 })
          .pipe(Effect.mapError(repositoryFailure("persist", `Could not stage ${filePath}`)));
        yield* fs
          .rename(temporary, filePath)
          .pipe(
            Effect.mapError(repositoryFailure("persist", `Could not replace ${filePath}`)),
            Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
          );
      });

    const commit = (
      current: ReadonlyMap<LoopId, Loop>,
      next: ReadonlyMap<LoopId, Loop>,
      retention: Loop["retention"],
    ) =>
      Effect.gen(function* () {
        if (retention === "project") {
          if (!leaseOwned) {
            return yield* new LeaseUnavailable({
              message: "Another Pi session owns project-retained loops",
            });
          }
          yield* persist(next);
        } else if (sessionPersistence) {
          yield* sessionPersistence.persist(
            [...next.values()].filter((loop) => loop.retention === "session"),
          );
        }
        if (current !== next) yield* Ref.set(state, next);
      });

    const add = (loop: Loop) =>
      mutationLock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.size >= config.maxLoops) {
            return yield* new CapacityExceeded({ maximum: config.maxLoops });
          }
          if (current.has(loop.id)) {
            return yield* new LoopStateConflict({ id: loop.id, expected: "unused loop id" });
          }
          const next = new Map(current);
          next.set(loop.id, loop);
          yield* commit(current, next, loop.retention);
        }),
      );

    const get = (id: LoopId) =>
      Ref.get(state).pipe(
        Effect.flatMap((current) => {
          const loop = current.get(id);
          return loop ? Effect.succeed(loop) : Effect.fail(new LoopNotFound({ id }));
        }),
      );

    const remove = (id: LoopId) =>
      mutationLock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const loop = current.get(id);
          if (!loop) return yield* new LoopNotFound({ id });
          const next = new Map(current);
          next.set(id, cancel(loop));
          next.delete(id);
          yield* commit(current, next, loop.retention);
          return loop;
        }),
      );

    const armLoop = (id: LoopId, at: number) =>
      mutationLock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const loop = current.get(id);
          if (!loop) return yield* new LoopNotFound({ id });
          const armed = armTransition(loop, at);
          if (!armed) {
            return yield* new LoopStateConflict({ id, expected: "manual loop awaiting arm" });
          }
          const next = new Map(current);
          next.set(id, armed);
          yield* commit(current, next, loop.retention);
          return armed;
        }),
      );

    const updateInterval = (id: LoopId, periodMs: number, prompt: string, now: number) =>
      mutationLock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const loop = current.get(id);
          if (!loop) return yield* new LoopNotFound({ id });
          if (loop._tag !== "Interval") {
            return yield* new LoopStateConflict({ id, expected: "fixed-interval automation" });
          }
          const updated: Loop = {
            ...loop,
            prompt,
            spec: { ...loop.spec, periodMs },
            phase:
              loop.phase._tag === "Waiting" ? { ...loop.phase, dueAt: now + periodMs } : loop.phase,
          };
          const next = new Map(current);
          next.set(id, updated);
          yield* commit(current, next, loop.retention);
          return updated;
        }),
      );

    const setEnabled = (id: LoopId, enabled: boolean) =>
      mutationLock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const loop = current.get(id);
          if (!loop) return yield* new LoopNotFound({ id });
          const updated = { ...loop, enabled } as Loop;
          const next = new Map(current);
          next.set(id, updated);
          yield* commit(current, next, loop.retention);
          return updated;
        }),
      );

    const claimNow = (id: LoopId, now: number, gate: Gate) =>
      mutationLock.withPermits(1)(
        Effect.gen(function* () {
          if (gate === "closed")
            return yield* new LoopStateConflict({ id, expected: "idle session" });
          const current = yield* Ref.get(state);
          const loop = current.get(id);
          if (!loop) return yield* new LoopNotFound({ id });
          if (!loop.enabled)
            return yield* new LoopStateConflict({ id, expected: "enabled automation" });
          const cursor = loop.manualCursor + 1;
          const updated = { ...loop, manualCursor: cursor } as Loop;
          const next = new Map(current);
          next.set(id, updated);
          yield* commit(current, next, loop.retention);
          return {
            id: `${id}:manual:${cursor}`,
            loopId: id,
            cursor,
            prompt: occurrencePrompt(loop),
            dueAt: now,
            claimedAt: now,
            trigger: "manual" as const,
          };
        }),
      );

    const removeAll = (retention: Loop["retention"]) =>
      mutationLock
        .withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            const loops = [...current.values()].filter((loop) => loop.retention === retention);
            const next = new Map(current);
            for (const loop of loops) next.delete(loop.id);
            yield* commit(current, next, retention);
            return loops;
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error instanceof LeaseUnavailable
              ? error
              : new RepositoryFailure({
                  operation: "persist",
                  message: "Could not remove all loops",
                  cause: error,
                }),
          ),
        );

    const claimDue = (now: number, gate: Gate, retention: Loop["retention"]) =>
      mutationLock
        .withPermits(1)(
          Effect.gen(function* () {
            if (gate === "closed") return [];
            const current = yield* Ref.get(state);
            const next = new Map(current);
            const occurrences: Array<Occurrence> = [];
            let touchesProject = false;
            for (const loop of current.values()) {
              if (loop.retention !== retention) continue;
              const result = tick(loop, now, gate);
              if (!result.occurrence) continue;
              occurrences.push(result.occurrence);
              touchesProject = true;
              if (result.loop.phase._tag === "Stopped") next.delete(loop.id);
              else next.set(loop.id, result.loop);
            }
            if (touchesProject) yield* commit(current, next, retention);
            return occurrences;
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error instanceof RepositoryFailure
              ? error
              : new RepositoryFailure({
                  operation: "persist",
                  message: "Could not claim due loops",
                  cause: error,
                }),
          ),
        );

    const release = leaseOwned
      ? fs
          .remove(lockPath, { force: true })
          .pipe(Effect.mapError(repositoryFailure("lease", `Could not release ${lockPath}`)))
      : Effect.void;

    return {
      leaseOwned,
      add,
      list: Ref.get(state).pipe(Effect.map((current) => [...current.values()])),
      get,
      remove,
      removeAll,
      arm: armLoop,
      updateInterval,
      setEnabled,
      claimNow,
      claimDue,
      release,
    };
  });
