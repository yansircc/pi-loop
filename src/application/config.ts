import { Data, Effect, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { DEFAULT_CONFIG, type LoopConfig, TimeZone } from "../domain/model.js";

const optional = Schema.optionalKey;
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

const ConfigOverrides = Schema.Struct({
  maxLoops: optional(PositiveInt),
  recurringMaxAgeMs: optional(NonNegativeInt),
  recurringJitterFraction: optional(
    Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  ),
  recurringJitterCapMs: optional(NonNegativeInt),
  checkIntervalMs: optional(PositiveInt),
  durableFilePath: optional(Schema.NonEmptyString),
  timeZone: optional(TimeZone),
});

export class ConfigFailure extends Data.TaggedError("ConfigFailure")<{
  readonly path: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const loadLoopConfig = (
  cwd: string,
): Effect.Effect<LoopConfig, ConfigFailure, FileSystem | Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;
    const configPath = path.join(cwd, ".pi-loop.config.json");
    const exists = yield* fs
      .exists(configPath)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ConfigFailure({ path: configPath, message: "Could not inspect config", cause }),
        ),
      );
    if (!exists) return DEFAULT_CONFIG;
    const encoded = yield* fs
      .readFileString(configPath)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ConfigFailure({ path: configPath, message: "Could not read config", cause }),
        ),
      );
    const overrides = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ConfigOverrides), {
      onExcessProperty: "error",
    })(encoded).pipe(
      Effect.mapError(
        (cause) => new ConfigFailure({ path: configPath, message: "Invalid config", cause }),
      ),
    );
    return { ...DEFAULT_CONFIG, ...overrides };
  });
