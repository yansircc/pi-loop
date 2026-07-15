# pi-loop

Effect-based temporal loops for Pi.

```sh
pi install npm:@yansircc/pi-loop
```

## Commands

```text
/loop 7m inspect the build       # execute now, then every exact 7 minutes
/loop monitor the deployment     # model-paced dynamic loop
/loop-list
/loop-kill <id|all>
```

Fixed intervals are elapsed durations, not approximated cron expressions. Dynamic loops execute
once, enter `AwaitingArm`, and continue only when the model calls:

```text
schedule_wakeup { loopId, delaySeconds, reason }
```

## Model tools

- `cron_create`: recurring calendar cron or one-shot prompt.
- `cron_delete`: cancel by id or `all`.
- `cron_list`: list active loops.
- `schedule_wakeup`: arm one dynamic loop for 60–3600 seconds.

`cron_create` accepts a five-field cron expression, prompt, `recurring`, `durable`, and optional
label. Cron uses an explicit IANA timezone and standard day-of-month/day-of-week OR semantics.
Missed recurring occurrences coalesce into one claim.

## State and delivery

Session loops remain in memory. Durable cron and one-shot loops are stored in `.pi-loop.json`.
One PID lease owns durable mutation; follower sessions may still run session loops.

Delivery is at-most-once after claim: durable state commits before Pi receives the prompt. A failed
commit emits no occurrence; a Pi failure after commit is logged and is not retried.

Project overrides belong in `.pi-loop.config.json`:

```json
{
  "maxLoops": 50,
  "recurringMaxAgeMs": 604800000,
  "recurringJitterFraction": 0.5,
  "recurringJitterCapMs": 1800000,
  "checkIntervalMs": 1000,
  "durableFilePath": ".pi-loop.json",
  "timeZone": "Asia/Shanghai"
}
```

## Development

```sh
pnpm install
pnpm run verify
pnpm run pi:pack
```

The package gate builds one self-contained Node ESM entry, packs it, extracts it without installing
dependencies, and loads it through Pi's real extension loader.
