import { expect, it } from "@effect/vitest";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  RegisteredCommand,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Data, Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { setTimeout as delay } from "node:timers/promises";
import piLoop from "../src/pi/extension.js";

class InvocationFailure extends Data.TaggedError("InvocationFailure")<{
  readonly name: string;
  readonly cause: unknown;
}> {}

class WaitFailure extends Data.TaggedError("WaitFailure")<{
  readonly cause: unknown;
}> {}

const wait = (milliseconds: number) =>
  Effect.tryPromise({
    try: () => delay(milliseconds),
    catch: (cause) => new WaitFailure({ cause }),
  });

type Handler = (event: unknown, context: ExtensionContext) => Promise<void> | void;

const invoke = (name: string, call: () => Promise<void> | void) =>
  Effect.suspend(() => {
    const result = call();
    return result instanceof Promise
      ? Effect.tryPromise({
          try: () => result,
          catch: (cause) => new InvocationFailure({ name, cause }),
        })
      : Effect.void;
  });

it.effect("gates the real Pi callback path until the agent becomes idle", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "pi-loop-extension-" });
      yield* fs.writeFileString(
        `${cwd}/.pi-loop.config.json`,
        JSON.stringify({ checkIntervalMs: 10, recurringJitterFraction: 0 }),
      );

      const handlers = new Map<string, Handler>();
      const commands = new Map<string, RegisteredCommand>();
      const tools = new Map<string, ToolDefinition>();
      const messages: Array<string> = [];
      const entries: Array<unknown> = [];
      const statuses = new Map<string, unknown>();
      const pi = {
        on: (name: string, handler: Handler) => handlers.set(name, handler),
        registerCommand: (name: string, command: RegisteredCommand) => commands.set(name, command),
        registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
        sendUserMessage: (message: string) => messages.push(message),
        appendEntry: (customType: string, data: unknown) =>
          entries.push({ type: "custom", customType, data }),
      } as unknown as ExtensionAPI;
      piLoop(pi);

      const context = {
        cwd,
        hasUI: true,
        ui: {
          notify: () => undefined,
          setStatus: () => undefined,
          setStructuredStatus: (key: string, value?: unknown) => {
            if (value === undefined) statuses.delete(key);
            else statuses.set(key, value);
          },
        },
        sessionManager: {
          getSessionId: () => "session-automation",
          getEntries: () => entries,
        },
      } as unknown as ExtensionContext;
      const commandContext = context as unknown as ExtensionCommandContext;
      const start = handlers.get("session_start");
      const busy = handlers.get("agent_start");
      const idle = handlers.get("agent_end");
      const shutdown = handlers.get("session_shutdown");
      const loop = commands.get("loop");
      const loopControl = commands.get("loop-control");
      expect(start).toBeDefined();
      expect(busy).toBeDefined();
      expect(idle).toBeDefined();
      expect(shutdown).toBeDefined();
      expect(loop).toBeDefined();
      expect(loopControl).toBeDefined();
      expect([...tools.keys()].sort((left, right) => left.localeCompare(right))).toEqual([
        "cron_create",
        "cron_delete",
        "cron_list",
        "schedule_wakeup",
      ]);

      yield* invoke("session_start", () => start?.({}, context));
      yield* invoke("agent_start", () => busy?.({}, context));
      yield* wait(20);
      yield* invoke("loop", () => loop?.handler("7m inspect build", commandContext));
      yield* wait(30);
      expect(messages).toEqual([]);

      yield* invoke("agent_end", () => idle?.({}, context));
      yield* wait(30);
      expect(messages).toEqual(["inspect build"]);

      yield* invoke("loop-immediate", () => loop?.handler("9m immediate probe", commandContext));
      expect(messages).toEqual(["inspect build", "immediate probe"]);
      expect(statuses.get("pi-loop")).toMatchObject({
        kind: "pi-loop/status",
        version: 1,
        sessionId: "session-automation",
        loops: [{ prompt: "inspect build" }, { prompt: "immediate probe" }],
      });
      expect(statuses.get("pi-loop/runtime-lease")).toMatchObject({
        kind: "pi/runtime-lease",
        version: 1,
        owner: "pi-loop",
      });

      yield* invoke("run-now", () =>
        loopControl?.handler(
          JSON.stringify({
            kind: "pi-loop/control",
            version: 1,
            action: { _tag: "RunNow", id: "missing" },
          }),
          commandContext,
        ),
      ).pipe(Effect.exit);
      expect(messages).toEqual(["inspect build", "immediate probe"]);

      yield* invoke("session_shutdown", () => shutdown?.({}, context));
      yield* invoke("session_restart", () => start?.({}, context));
      yield* invoke("agent_idle", () => idle?.({}, context));
      yield* wait(20);
      expect(messages).toEqual(["inspect build", "immediate probe"]);

      yield* invoke("session_shutdown", () => shutdown?.({}, context));
      expect(yield* fs.exists(`${cwd}/.pi-loop.json.lock`)).toBe(false);
    }),
  ).pipe(Effect.provide(nodeServicesLayer)),
);
