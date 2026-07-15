export default Object.freeze({
  source: "src/pi/extension.ts",
  target: "node22",
  hostModules: ["@earendil-works/pi-coding-agent"],
  loaderModule: "@earendil-works/pi-coding-agent",
  expected: Object.freeze({
    commands: ["loop", "loop-control", "loop-kill", "loop-list"],
    tools: ["cron_create", "cron_delete", "cron_list", "schedule_wakeup"],
    handlers: ["agent_end", "agent_start", "session_shutdown", "session_start"],
  }),
});
