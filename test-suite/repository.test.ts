import { expect, it } from "@effect/vitest";
import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Cause, Effect, Ref } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { LeaseUnavailable, makeLoopRepository } from "../src/application/repository.js";
import { createLoop, DEFAULT_CONFIG } from "../src/domain/model.js";

const withDirectory = <A, E>(
  use: (directory: string, fs: FileSystem, path: Path) => Effect.Effect<A, E, FileSystem | Path>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-loop-test-" });
      return yield* use(directory, fs, path);
    }),
  ).pipe(Effect.provide(nodeServicesLayer));

it.effect("commits durable advance before returning an occurrence", () =>
  withDirectory((directory, fs, path) =>
    Effect.gen(function* () {
      const repository = yield* makeLoopRepository(directory, DEFAULT_CONFIG);
      const loop = createLoop({
        _tag: "Once",
        id: "durable-once",
        prompt: "run once",
        retention: "project",
        createdAt: 1,
        dueAt: 10,
      });
      yield* repository.add(loop);
      const occurrences = yield* repository.claimDue(10, "open", "project");
      expect(occurrences.map((item) => item.id)).toEqual(["durable-once:0"]);
      expect(yield* repository.list).toEqual([]);
      const encoded = yield* fs.readFileString(
        path.join(directory, DEFAULT_CONFIG.durableFilePath),
      );
      expect(JSON.parse(encoded)).toEqual({ version: 2, loops: [] });
      yield* repository.release;
    }),
  ),
);

it.effect("lets followers mutate session state but rejects durable mutations", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const owner = yield* makeLoopRepository(directory, DEFAULT_CONFIG);
      const follower = yield* makeLoopRepository(directory, DEFAULT_CONFIG);
      expect(owner.leaseOwned).toBe(true);
      expect(follower.leaseOwned).toBe(false);
      yield* follower.add(
        createLoop({
          _tag: "Once",
          id: "session-once",
          prompt: "session",
          retention: "session",
          createdAt: 1,
          dueAt: 10,
        }),
      );
      const exit = yield* Effect.exit(
        follower.add(
          createLoop({
            _tag: "Once",
            id: "project-once",
            prompt: "project",
            retention: "project",
            createdAt: 1,
            dueAt: 10,
          }),
        ),
      );
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(LeaseUnavailable);
      }
      yield* owner.release;
      yield* follower.release;
    }),
  ),
);

it.effect("fails closed on corrupt durable state", () =>
  withDirectory((directory, fs, path) =>
    Effect.gen(function* () {
      yield* fs.writeFileString(path.join(directory, DEFAULT_CONFIG.durableFilePath), "not-json");
      const exit = yield* Effect.exit(makeLoopRepository(directory, DEFAULT_CONFIG));
      expect(exit._tag).toBe("Failure");
      expect(yield* fs.exists(`${path.join(directory, DEFAULT_CONFIG.durableFilePath)}.lock`)).toBe(
        false,
      );
    }),
  ),
);

it.effect("migrates published v1 durable loops into the v2 state algebra", () =>
  withDirectory((directory, fs, path) =>
    Effect.gen(function* () {
      const filePath = path.join(directory, DEFAULT_CONFIG.durableFilePath);
      yield* fs.writeFileString(
        filePath,
        JSON.stringify({
          version: 1,
          loops: [
            {
              _tag: "Once",
              id: "legacy-once",
              prompt: "inspect",
              retention: "project",
              createdAt: 1,
              phase: { _tag: "Waiting", dueAt: 10, cursor: 0 },
            },
          ],
        }),
      );
      const repository = yield* makeLoopRepository(directory, DEFAULT_CONFIG);
      expect(yield* repository.list).toEqual([
        expect.objectContaining({ id: "legacy-once", enabled: true, manualCursor: 0 }),
      ]);
      yield* repository.setEnabled("legacy-once", false);
      expect(JSON.parse(yield* fs.readFileString(filePath))).toMatchObject({ version: 2 });
      yield* repository.release;
    }),
  ),
);

it.effect("persists every session-owned mutation through the session adapter", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const snapshots = yield* Ref.make<ReadonlyArray<ReadonlyArray<unknown>>>([]);
      const repository = yield* makeLoopRepository(directory, DEFAULT_CONFIG, {
        initial: [],
        persist: (loops) =>
          Ref.update(snapshots, (values) => [...values, loops]).pipe(Effect.asVoid),
      });
      const loop = createLoop({
        _tag: "Interval",
        id: "session-interval",
        prompt: "inspect",
        retention: "session",
        createdAt: 1,
        firstDueAt: 10,
        spec: { periodMs: 100, jitterFraction: 0, jitterCapMs: 0 },
      });
      yield* repository.add(loop);
      yield* repository.setEnabled(loop.id, false);
      yield* repository.remove(loop.id);
      expect((yield* Ref.get(snapshots)).map((snapshot) => snapshot.length)).toEqual([1, 1, 0]);
      yield* repository.release;
    }),
  ),
);
