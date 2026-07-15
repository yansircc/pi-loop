import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { layer as nodeServicesLayer, type NodeServices } from "@effect/platform-node/NodeServices";
import { Type } from "@sinclair/typebox";
import { Clock, Data, Effect, Fiber, ManagedRuntime, Schema } from "effect";
import { loadLoopConfig } from "../application/config.js";
import { makeLoopOperations, type LoopOperations } from "../application/operations.js";
import { makeLoopRepository, type LoopRepository } from "../application/repository.js";
import { makeScheduler, PromptDeliveryFailure, type Scheduler } from "../application/scheduler.js";
import { cronToHuman } from "../domain/cron.js";
import type { Loop, LoopConfig, Occurrence } from "../domain/model.js";
import { parseLoop } from "./parse-loop.js";
import { LoopControlRequest, projectLoops } from "./status.js";
import { makeSessionLoopPersistence } from "./session-state.js";

const runtime = ManagedRuntime.make(nodeServicesLayer);

type Session = {
  readonly context: ExtensionContext;
  readonly config: LoopConfig;
  readonly repository: LoopRepository;
  readonly operations: LoopOperations;
  readonly scheduler: Scheduler;
  readonly fiber: Fiber.Fiber<never, unknown>;
};

export class SessionUnavailable extends Data.TaggedError("SessionUnavailable")<{
  readonly message: string;
}> {}

const sessions = new WeakMap<object, Session>();

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices>): Promise<A> =>
  runtime.runPromise(effect);

const runDetached = <A, E>(effect: Effect.Effect<A, E, NodeServices>): void => {
  runtime.runFork(effect);
};

const withSession = <A, E>(
  pi: ExtensionAPI,
  use: (active: Session) => Effect.Effect<A, E, NodeServices>,
): Effect.Effect<A, E | SessionUnavailable, NodeServices> =>
  Effect.gen(function* () {
    const active = sessions.get(pi as object);
    if (!active) {
      return yield* new SessionUnavailable({ message: "pi-loop session has not started" });
    }
    return yield* use(active);
  });

const describeLoop = (loop: Loop): string => {
  const phase =
    loop.phase._tag === "Waiting"
      ? `due ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(loop.phase.dueAt)}`
      : loop.phase._tag === "AwaitingArm"
        ? "awaiting model arm"
        : `stopped: ${loop.phase.reason}`;
  const cadence =
    loop._tag === "Cron"
      ? cronToHuman(loop.spec.expression)
      : loop._tag === "Interval"
        ? `every ${loop.spec.periodMs}ms`
        : loop._tag.toLowerCase();
  return `[${loop.id}] ${cadence} — ${loop.prompt.slice(0, 60)} (${phase}, ${loop.retention})`;
};

const toolResult = (text: string): AgentToolResult<undefined> => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
});

const notifyFailure = (context: ExtensionContext, error: unknown) =>
  Effect.sync(() => {
    if (context.hasUI) {
      const message = error instanceof Error ? error.message : String(error);
      context.ui.notify(`pi-loop: ${message}`, "error");
    }
  });

const refreshStatus = (active: Session) =>
  active.repository.list.pipe(
    Effect.flatMap((loops) =>
      Clock.currentTimeMillis.pipe(Effect.map((observedAt) => ({ loops, observedAt }))),
    ),
    Effect.flatMap(({ loops, observedAt }) =>
      Effect.sync(() => {
        if (!active.context.hasUI) return;
        const ui = active.context.ui as typeof active.context.ui & {
          setStructuredStatus?: (key: string, value?: unknown) => void;
        };
        active.context.ui.setStatus(
          "pi-loop",
          loops.length === 0 ? undefined : `${loops.length} loop${loops.length === 1 ? "" : "s"}`,
        );
        ui.setStructuredStatus?.("pi-loop", {
          kind: "pi-loop/status",
          version: 1,
          sessionId: active.context.sessionManager.getSessionId(),
          observedAt,
          loops: projectLoops(loops),
        });
        ui.setStructuredStatus?.(
          "pi-loop/runtime-lease",
          loops[0]
            ? {
                kind: "pi/runtime-lease",
                version: 1,
                owner: "pi-loop",
                reason: "automation-present",
              }
            : undefined,
        );
      }),
    ),
  );

const decodeControl = (input: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(LoopControlRequest), {
    onExcessProperty: "error",
  })(input);

const stopSession = (pi: ExtensionAPI, active: Session) =>
  Fiber.interrupt(active.fiber).pipe(
    Effect.andThen(active.repository.release),
    Effect.ensuring(Effect.sync(() => sessions.delete(pi as object))),
  );

const startSession = (pi: ExtensionAPI, context: ExtensionContext) =>
  Effect.gen(function* () {
    const previous = sessions.get(pi as object);
    if (previous) yield* stopSession(pi, previous);
    const config = yield* loadLoopConfig(context.cwd);
    const sessionPersistence = yield* makeSessionLoopPersistence(pi, context);
    const repository = yield* makeLoopRepository(context.cwd, config, sessionPersistence);
    const operations = makeLoopOperations(repository, config);
    const deliver = (item: Occurrence) =>
      Effect.try({
        try: () => {
          if (context.hasUI) context.ui.notify(`Loop firing: ${item.loopId}`, "info");
          pi.sendUserMessage(item.prompt);
        },
        catch: (cause) => new PromptDeliveryFailure({ occurrenceId: item.id, cause }),
      }).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            const current = sessions.get(pi as object);
            return current ? refreshStatus(current) : Effect.void;
          }),
        ),
      );
    const scheduler = yield* makeScheduler(repository, deliver, config);
    const fiber = yield* Effect.forkDetach(
      scheduler.run.pipe(
        Effect.catch((error) =>
          Effect.logError("pi-loop scheduler stopped", { cause: error }).pipe(
            Effect.andThen(Effect.never),
          ),
        ),
      ),
    );
    const active: Session = { context, config, repository, operations, scheduler, fiber };
    yield* Effect.sync(() => sessions.set(pi as object, active));
    yield* refreshStatus(active);
    if (context.hasUI && !repository.leaseOwned) {
      context.ui.notify(
        "Another Pi session owns project-retained loops; session loops remain available.",
        "warning",
      );
    }
  });

const registrations = new WeakSet<object>();

export default function piLoop(pi: ExtensionAPI): void {
  if (registrations.has(pi as object)) return;
  registrations.add(pi as object);

  pi.registerCommand("loop", {
    description: "Run a prompt now and continue on a fixed interval or model-selected wakeup",
    handler(args, context) {
      const parsed = parseLoop(args);
      if (!parsed) {
        if (context.hasUI) context.ui.notify("Usage: /loop [interval] <prompt>", "warning");
        return run(Effect.void);
      }
      return run(
        withSession(pi, (active) =>
          (parsed._tag === "Fixed"
            ? active.operations.createFixed(parsed.interval, parsed.prompt)
            : active.operations.createDynamic(parsed.prompt)
          ).pipe(
            Effect.tap(() => active.scheduler.drain),
            Effect.tap(() => refreshStatus(active)),
            Effect.tap((loop) =>
              Effect.sync(() => {
                if (context.hasUI) context.ui.notify(`Loop ${loop.id} created`, "info");
              }),
            ),
          ),
        ).pipe(
          Effect.catch((error) => notifyFailure(context, error)),
          Effect.asVoid,
        ),
      );
    },
  });

  pi.registerCommand("loop-list", {
    description: "List active loops",
    handler(_args, context) {
      return run(
        withSession(pi, (active) => active.operations.list).pipe(
          Effect.tap((loops) =>
            Effect.sync(() => {
              if (context.hasUI) {
                context.ui.notify(
                  loops.length === 0 ? "No active loops" : loops.map(describeLoop).join("\n"),
                  "info",
                );
              }
            }),
          ),
          Effect.catch((error) => notifyFailure(context, error)),
          Effect.asVoid,
        ),
      );
    },
  });

  pi.registerCommand("loop-kill", {
    description: "Cancel a loop by id, or all loops",
    handler(args, context) {
      const id = args.trim();
      if (!id) {
        if (context.hasUI) context.ui.notify("Usage: /loop-kill <id|all>", "warning");
        return run(Effect.void);
      }
      return run(
        withSession(pi, (active) =>
          Effect.gen(function* () {
            if (id === "all") yield* active.operations.removeAll;
            else yield* active.operations.remove(id);
          }).pipe(
            Effect.ensuring(refreshStatus(active)),
            Effect.tap(() =>
              Effect.sync(() => {
                if (context.hasUI) context.ui.notify(`Cancelled ${id}`, "info");
              }),
            ),
          ),
        ).pipe(
          Effect.catch((error) => notifyFailure(context, error)),
          Effect.asVoid,
        ),
      );
    },
  });

  pi.registerCommand("loop-control", {
    description: "Typed pi-web control surface for the current session automation",
    handler(args, context) {
      return run(
        withSession(pi, (active) =>
          Effect.gen(function* () {
            const request = yield* decodeControl(args);
            switch (request.action._tag) {
              case "CreateInterval":
                yield* active.operations.createInterval(
                  request.action.periodMs,
                  request.action.prompt,
                  false,
                );
                break;
              case "UpdateInterval":
                yield* active.operations.updateInterval(
                  request.action.id,
                  request.action.periodMs,
                  request.action.prompt,
                );
                break;
              case "SetEnabled":
                yield* active.operations.setEnabled(request.action.id, request.action.enabled);
                break;
              case "Delete":
                yield* active.operations.remove(request.action.id);
                break;
              case "RunNow":
                yield* active.scheduler.runNow(request.action.id);
                break;
            }
          }).pipe(Effect.ensuring(refreshStatus(active))),
        ).pipe(Effect.tapError((error) => notifyFailure(context, error))),
      );
    },
  });

  pi.registerTool({
    name: "cron_create",
    label: "Create Scheduled Loop",
    description: "Create a recurring or one-shot prompt on a five-field local-time cron schedule.",
    parameters: Type.Object({
      cron: Type.String(),
      prompt: Type.String(),
      recurring: Type.Boolean({ default: true }),
      durable: Type.Boolean({ default: false }),
      label: Type.Optional(Type.String()),
    }),
    execute(_id, parameters) {
      return run(
        withSession(pi, (active) =>
          active.operations
            .createCron({
              expression: parameters.cron ?? "",
              prompt: parameters.prompt ?? "",
              recurring: parameters.recurring ?? true,
              retention: parameters.durable ? "project" : "session",
              ...(parameters.label === undefined ? {} : { label: parameters.label }),
            })
            .pipe(
              Effect.tap(() => refreshStatus(active)),
              Effect.map((loop) => toolResult(`Scheduled ${describeLoop(loop)}`)),
            ),
        ).pipe(
          Effect.catch((error) =>
            Effect.succeed(toolResult(`cron_create failed: ${String(error)}`)),
          ),
        ),
      );
    },
  });

  pi.registerTool({
    name: "cron_delete",
    label: "Cancel Scheduled Loop",
    description: "Cancel a scheduled loop by id, or pass all.",
    parameters: Type.Object({ id: Type.String() }),
    execute(_id, parameters) {
      return run(
        withSession(pi, (active) =>
          Effect.gen(function* () {
            const id = parameters.id ?? "";
            if (id === "all") yield* active.operations.removeAll;
            else yield* active.operations.remove(id);
          }).pipe(
            Effect.ensuring(refreshStatus(active)),
            Effect.map(() => toolResult(`Cancelled ${parameters.id ?? ""}`)),
          ),
        ).pipe(
          Effect.catch((error) =>
            Effect.succeed(toolResult(`cron_delete failed: ${String(error)}`)),
          ),
        ),
      );
    },
  });

  pi.registerTool({
    name: "cron_list",
    label: "List Scheduled Loops",
    description: "List active temporal loops.",
    parameters: Type.Object({}),
    execute() {
      return run(
        withSession(pi, (active) =>
          active.operations.list.pipe(
            Effect.map((loops) =>
              toolResult(
                loops.length === 0 ? "No active loops" : loops.map(describeLoop).join("\n"),
              ),
            ),
          ),
        ).pipe(
          Effect.catch((error) => Effect.succeed(toolResult(`cron_list failed: ${String(error)}`))),
        ),
      );
    },
  });

  pi.registerTool({
    name: "schedule_wakeup",
    label: "Arm Dynamic Loop",
    description: "Arm a dynamic loop that is awaiting the model's next wakeup decision.",
    parameters: Type.Object({
      loopId: Type.String(),
      delaySeconds: Type.Number({ minimum: 60, maximum: 3_600 }),
      reason: Type.String(),
    }),
    execute(_id, parameters) {
      return run(
        withSession(pi, (active) =>
          active.operations
            .scheduleWakeup(parameters.loopId ?? "", parameters.delaySeconds ?? 0)
            .pipe(
              Effect.tap(() => refreshStatus(active)),
              Effect.map(() =>
                toolResult(
                  `Armed ${parameters.loopId ?? ""} in ${parameters.delaySeconds ?? 0}s: ${parameters.reason ?? ""}`,
                ),
              ),
            ),
        ).pipe(
          Effect.catch((error) =>
            Effect.succeed(toolResult(`schedule_wakeup failed: ${String(error)}`)),
          ),
        ),
      );
    },
  });

  pi.on("session_start", (_event, context) =>
    run(
      startSession(pi, context).pipe(
        Effect.catch((error) => notifyFailure(context, error)),
        Effect.asVoid,
      ),
    ),
  );
  pi.on("session_shutdown", () => {
    const active = sessions.get(pi as object);
    return active
      ? run(stopSession(pi, active).pipe(Effect.catch((error) => Effect.logError(error))))
      : run(Effect.void);
  });
  pi.on("agent_start", () => {
    const active = sessions.get(pi as object);
    if (active) runDetached(active.scheduler.setBusy);
  });
  pi.on("agent_end", () => {
    const active = sessions.get(pi as object);
    if (active) runDetached(active.scheduler.setIdle);
  });
}
