import type { CronSpec } from "./model.js";

type Field = {
  readonly values: ReadonlySet<number>;
  readonly wildcard: boolean;
};

export type ParsedCron = {
  readonly minute: Field;
  readonly hour: Field;
  readonly dayOfMonth: Field;
  readonly month: Field;
  readonly dayOfWeek: Field;
};

const ranges = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
] as const;

const parseField = (source: string, minimum: number, maximum: number): Field | undefined => {
  const values = new Set<number>();
  for (const part of source.split(",")) {
    const stepMatch = /^(.*)\/(\d+)$/.exec(part);
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    const range = stepMatch?.[1] ?? part;
    if (!Number.isInteger(step) || step < 1) return undefined;
    if (range === "*") {
      for (let value = minimum; value <= maximum; value += step) values.add(value);
      continue;
    }
    const rangeMatch = /^(\d+)-(\d+)$/.exec(range);
    if (rangeMatch) {
      const low = Number(rangeMatch[1]);
      const high = Number(rangeMatch[2]);
      if (low < minimum || high > maximum || low > high) return undefined;
      for (let value = low; value <= high; value += step) values.add(value);
      continue;
    }
    if (!/^\d+$/.test(range)) return undefined;
    const value = Number(range);
    if (value < minimum || value > maximum) return undefined;
    values.add(value);
  }
  return values.size === 0 ? undefined : { values, wildcard: /^\*(?:\/\d+)?$/.test(source) };
};

export const parseCron = (source: string): ParsedCron | undefined => {
  const parts = source.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const fields = parts.map((part, index) => {
    const range = ranges[index];
    return range ? parseField(part, range[0], range[1]) : undefined;
  });
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  return minute && hour && dayOfMonth && month && dayOfWeek
    ? { minute, hour, dayOfMonth, month, dayOfWeek }
    : undefined;
};

type LocalParts = {
  readonly minute: number;
  readonly hour: number;
  readonly dayOfMonth: number;
  readonly month: number;
  readonly dayOfWeek: number;
};

const weekday = new Map([
  ["Sun", 0],
  ["Mon", 1],
  ["Tue", 2],
  ["Wed", 3],
  ["Thu", 4],
  ["Fri", 5],
  ["Sat", 6],
]);

const localParts = (instant: number, formatter: Intl.DateTimeFormat): LocalParts | undefined => {
  const parts = formatter.formatToParts(instant);
  const byType = new Map(parts.map(({ type, value }) => [type, value]));
  const dayOfWeek = weekday.get(byType.get("weekday") ?? "");
  if (dayOfWeek === undefined) return undefined;
  return {
    minute: Number(byType.get("minute")),
    hour: Number(byType.get("hour")),
    dayOfMonth: Number(byType.get("day")),
    month: Number(byType.get("month")),
    dayOfWeek,
  };
};

const matches = (cron: ParsedCron, parts: LocalParts): boolean => {
  const dayOfMonthMatches = cron.dayOfMonth.values.has(parts.dayOfMonth);
  const dayOfWeekMatches = cron.dayOfWeek.values.has(parts.dayOfWeek);
  const dayMatches = cron.dayOfMonth.wildcard
    ? dayOfWeekMatches
    : cron.dayOfWeek.wildcard
      ? dayOfMonthMatches
      : dayOfMonthMatches || dayOfWeekMatches;
  return (
    cron.minute.values.has(parts.minute) &&
    cron.hour.values.has(parts.hour) &&
    cron.month.values.has(parts.month) &&
    dayMatches
  );
};

export const nextCronInstant = (spec: CronSpec, after: number): number | undefined => {
  const parsed = parseCron(spec.expression);
  if (!parsed) return undefined;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: spec.timeZone,
    minute: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    day: "2-digit",
    month: "2-digit",
    weekday: "short",
  });
  const start = Math.floor(after / 60_000) * 60_000 + 60_000;
  const limit = start + 366 * 24 * 60 * 60 * 1_000;
  for (let candidate = start; candidate < limit; candidate += 60_000) {
    const parts = localParts(candidate, formatter);
    if (parts && matches(parsed, parts)) return candidate;
  }
  return undefined;
};

const stableFraction = (seed: string): number => {
  let hash = 0x811c9dc5;
  for (const character of seed) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
};

export const nextCronDue = (
  spec: CronSpec,
  after: number,
  loopId: string,
  cursor: number,
): number | undefined => {
  const base = nextCronInstant(spec, after);
  if (base === undefined) return undefined;
  const following = nextCronInstant(spec, base);
  if (following === undefined) return base;
  const gap = following - base;
  const jitter = Math.min(
    stableFraction(`${loopId}:${cursor}`) * spec.jitterFraction * gap,
    spec.jitterCapMs,
  );
  return base + Math.floor(jitter);
};

export const parseIntervalMs = (interval: string): number | undefined => {
  const match = /^(\d+)([smhd])$/.exec(interval);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isInteger(amount) || amount < 1) return undefined;
  const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] ?? ""];
  if (unitMs === undefined) return undefined;
  const period = amount * unitMs;
  return Number.isSafeInteger(period) ? period : undefined;
};

export const cronToHuman = (expression: string): string => {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = expression.trim().split(/\s+/);
  const everyMinutes = /^\*\/(\d+)$/.exec(minute ?? "");
  if (everyMinutes && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `every ${everyMinutes[1]} minute${everyMinutes[1] === "1" ? "" : "s"}`;
  }
  const everyHours = /^\*\/(\d+)$/.exec(hour ?? "");
  if (minute === "0" && everyHours && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `every ${everyHours[1]} hour${everyHours[1] === "1" ? "" : "s"}`;
  }
  return expression;
};
