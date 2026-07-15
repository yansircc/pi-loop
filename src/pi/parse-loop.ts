export type ParsedLoop =
  | { readonly _tag: "Fixed"; readonly interval: string; readonly prompt: string }
  | { readonly _tag: "Dynamic"; readonly prompt: string };

const leading = /^(\d+[smhd])\s+(.+)$/s;
const trailing = /^(.*?)\s+every\s+(\d+)\s*([smhd]|seconds?|minutes?|hours?|days?)\s*$/is;
const units: Readonly<Record<string, string>> = {
  s: "s",
  second: "s",
  seconds: "s",
  m: "m",
  minute: "m",
  minutes: "m",
  h: "h",
  hour: "h",
  hours: "h",
  d: "d",
  day: "d",
  days: "d",
};

export const parseLoop = (input: string): ParsedLoop | undefined => {
  const source = input.trim();
  if (!source) return undefined;
  if (
    /^\d+[smhd]$/.test(source) ||
    /^every\s+\d+\s*(?:[smhd]|seconds?|minutes?|hours?|days?)$/i.test(source)
  ) {
    return undefined;
  }
  const first = leading.exec(source);
  if (first?.[1] && first[2]) {
    return { _tag: "Fixed", interval: first[1], prompt: first[2] };
  }
  const last = trailing.exec(source);
  if (last?.[1] && last[2] && last[3]) {
    const unit = units[last[3].toLowerCase()];
    if (unit) return { _tag: "Fixed", interval: `${last[2]}${unit}`, prompt: last[1] };
  }
  return { _tag: "Dynamic", prompt: source };
};
