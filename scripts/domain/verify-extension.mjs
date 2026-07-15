import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageRootInput = process.env.PI_EXTENSION_PACKAGE_ROOT ?? process.argv[2];
assert.ok(packageRootInput, "pi:domain-check requires the raw package root");
const packageRoot = resolve(packageRootInput);
const extensionPath = resolve(packageRoot, "dist", "pi", "extension.js");
const extension = (await import(pathToFileURL(extensionPath).href)).default;
assert.equal(typeof extension, "function", "archive extension must export a registration function");

const cwd = mkdtempSync(resolve(tmpdir(), "pi-loop-domain-"));
const handlers = new Map();
const tools = new Map();
const entries = [];
const pi = {
  on: (name, handler) => handlers.set(name, handler),
  registerCommand: () => undefined,
  registerTool: (tool) => tools.set(tool.name, tool),
  sendUserMessage: () => undefined,
  appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
};
const context = {
  cwd,
  hasUI: false,
  ui: {
    notify: () => undefined,
    setStatus: () => undefined,
    setStructuredStatus: () => undefined,
  },
  sessionManager: {
    getSessionId: () => "release-domain-check",
    getEntries: () => entries,
  },
};
const textOf = (result) => result.content.map((item) => item.text ?? "").join("\n");

try {
  extension(pi);
  const start = handlers.get("session_start");
  const shutdown = handlers.get("session_shutdown");
  const create = tools.get("cron_create");
  const list = tools.get("cron_list");
  const remove = tools.get("cron_delete");
  assert.ok(
    start && shutdown && create && list && remove,
    "archive lifecycle/cron surface is incomplete",
  );

  await start({}, context);
  const created = textOf(
    await create.execute("release-create", {
      cron: "*/5 * * * *",
      prompt: "release domain probe",
      recurring: true,
      durable: false,
    }),
  );
  assert.match(created, /^Scheduled \[/, "cron_create did not create an archive-backed loop");
  const id = created.match(/^Scheduled \[([^\]]+)\]/)?.[1];
  assert.ok(id, "cron_create result did not expose the loop id");

  const listed = textOf(await list.execute("release-list", {}));
  assert.match(listed, /release domain probe/, "cron_list did not observe the created loop");
  const deleted = textOf(await remove.execute("release-delete", { id }));
  assert.equal(deleted, `Cancelled ${id}`);
  assert.equal(textOf(await list.execute("release-list-empty", {})), "No active loops");
  await shutdown({}, context);

  process.stdout.write(`${JSON.stringify({ cronLifecycle: true, id })}\n`);
} finally {
  try {
    await handlers.get("session_shutdown")?.({}, context);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
