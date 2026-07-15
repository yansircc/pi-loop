import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bumpVersion, releaseBumpFromMessage } from "./version.mjs";

const root = resolve(import.meta.dirname, "../..");
const sourceSha = process.argv[2];
if (!sourceSha) throw new Error("usage: prepare.mjs <source-sha>");

const git = (args, options = {}) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "pipe", "ignore"] : ["ignore", "pipe", "inherit"],
  }).trim();

git(["cat-file", "-e", `${sourceSha}^{commit}`]);
const existingCommit = git(
  [
    "log",
    "origin/main",
    "--format=%H",
    "--fixed-strings",
    `--grep=Release-Source: ${sourceSha}`,
    "-n",
    "1",
  ],
  { quiet: true },
);

let mode;
let bump;
if (existingCommit) {
  mode = "existing";
  git(["checkout", "--detach", existingCommit]);
  bump = releaseBumpFromMessage(git(["show", "-s", "--format=%B", existingCommit]));
} else {
  mode = "new";
  bump = releaseBumpFromMessage(git(["show", "-s", "--format=%B", sourceSha]));
}

const manifestPath = resolve(root, "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const version = mode === "new" ? bumpVersion(manifest.version, bump) : manifest.version;
if (mode === "new") {
  manifest.version = version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

const tag = `v${version}`;
if (mode === "new") {
  try {
    git(["rev-parse", "--verify", `refs/tags/${tag}`], { quiet: true });
    throw new Error(`release tag already exists: ${tag}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("release tag already exists"))
      throw error;
  }
}

const result = {
  mode,
  name: manifest.name,
  bump,
  version,
  tag,
  sourceSha,
  existingCommit: existingCommit || undefined,
};
const githubOutput = process.env.GITHUB_OUTPUT;
if (githubOutput) {
  appendFileSync(
    githubOutput,
    Object.entries(result)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
  );
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
