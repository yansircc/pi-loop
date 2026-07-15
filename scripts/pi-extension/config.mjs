export default Object.freeze({
  source: "src/pi/extension.ts",
  hostModules: Object.freeze(["@earendil-works/pi-coding-agent"]),
  profile: Object.freeze({
    kind: "single-file",
    assets: Object.freeze([]),
  }),
  expected: Object.freeze({
    commands: Object.freeze(["loop", "loop-control", "loop-kill", "loop-list"]),
    tools: Object.freeze(["cron_create", "cron_delete", "cron_list", "schedule_wakeup"]),
    handlers: Object.freeze(["agent_end", "agent_start", "session_shutdown", "session_start"]),
  }),
});
