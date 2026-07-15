import { Data, Effect, Schema } from "effect";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Loop, type Loop as LoopValue } from "../domain/model.js";
import { RepositoryFailure, type SessionLoopPersistence } from "../application/repository.js";

const CUSTOM_TYPE = "pi-loop/session-state";

const SessionState = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.NonEmptyString,
  loops: Schema.Array(Loop),
});

const CustomEntry = Schema.Struct({
  type: Schema.Literal("custom"),
  customType: Schema.String,
  data: Schema.optionalKey(Schema.Unknown),
});

class SessionStateFailure extends Data.TaggedError("SessionStateFailure")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const decodeEntry = Schema.decodeUnknownEffect(CustomEntry);
const decodeState = Schema.decodeUnknownEffect(SessionState, { onExcessProperty: "error" });

export const makeSessionLoopPersistence = (
  pi: ExtensionAPI,
  context: ExtensionContext,
): Effect.Effect<SessionLoopPersistence, SessionStateFailure> =>
  Effect.gen(function* () {
    const sessionId = context.sessionManager.getSessionId();
    const entries = context.sessionManager.getEntries();
    let initial: ReadonlyArray<LoopValue> = [];
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = yield* decodeEntry(entries[index]).pipe(Effect.option);
      if (entry._tag === "None" || entry.value.customType !== CUSTOM_TYPE) continue;
      const state = yield* decodeState(entry.value.data).pipe(
        Effect.mapError(
          (cause) =>
            new SessionStateFailure({ message: "Invalid session automation state", cause }),
        ),
      );
      if (state.sessionId === sessionId) {
        initial = state.loops.filter((loop) => loop.retention === "session");
        break;
      }
    }

    return {
      initial,
      persist: (loops) =>
        Effect.try({
          try: () =>
            pi.appendEntry(CUSTOM_TYPE, {
              version: 1,
              sessionId,
              loops,
            }),
          catch: (cause) =>
            new RepositoryFailure({
              operation: "persist",
              message: "Could not persist session automation state",
              cause,
            }),
        }),
    };
  });
