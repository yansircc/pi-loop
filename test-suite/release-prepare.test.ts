import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vite-plus/test";

const projectRoot = resolve(import.meta.dirname, "..");

const run = (cwd: string, command: string, args: ReadonlyArray<string>) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const git = (cwd: string, ...args: ReadonlyArray<string>) => run(cwd, "git", args);

const writeManifest = (root: string, version: string) =>
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "@fixture/release", version, scripts: { verify: "node -e 0" } }, null, 2)}\n`,
  );

const makeRepository = () => {
  const root = mkdtempSync(join(tmpdir(), "pi-loop-release-test-"));
  const remote = `${root}-remote.git`;
  git(tmpdir(), "init", "--bare", remote);
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "release-test");
  git(root, "config", "user.email", "release-test@example.invalid");
  git(root, "remote", "add", "origin", remote);
  mkdirSync(join(root, "scripts", "release"), { recursive: true });
  for (const file of ["prepare.mjs", "version.mjs", "version.d.mts"]) {
    cpSync(join(projectRoot, "scripts", "release", file), join(root, "scripts", "release", file));
  }
  return { root, remote };
};

const commitAll = (root: string, message: string) => {
  git(root, "add", "-A");
  git(root, "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
};

const prepare = (root: string, sourceSha: string) =>
  JSON.parse(run(root, process.execPath, ["scripts/release/prepare.mjs", sourceSha])) as {
    mode: "new" | "existing";
    version: string;
    sourceSha: string;
  };

it("reuses the release previously produced for the same source sha", () => {
  const fixture = makeRepository();
  try {
    writeManifest(fixture.root, "0.5.0");
    const sourceSha = commitAll(fixture.root, "feat: source");
    git(fixture.root, "push", "-u", "origin", "main");

    expect(prepare(fixture.root, sourceSha)).toMatchObject({
      mode: "new",
      version: "0.5.1",
      sourceSha,
    });
    commitAll(
      fixture.root,
      `chore(release): v0.5.1\n\nRelease-Source: ${sourceSha}\n\nRelease-Bump: patch`,
    );
    git(fixture.root, "push", "origin", "main");
    git(fixture.root, "checkout", "--detach", sourceSha);

    expect(prepare(fixture.root, sourceSha)).toMatchObject({
      mode: "existing",
      version: "0.5.1",
      sourceSha,
    });
    expect(JSON.parse(readFileSync(join(fixture.root, "package.json"), "utf8")).version).toBe(
      "0.5.1",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.remote, { recursive: true, force: true });
  }
});

it("rejects a source push that manually changes the CI-owned version", () => {
  const fixture = makeRepository();
  try {
    writeManifest(fixture.root, "0.5.0");
    const firstSource = commitAll(fixture.root, "feat: initial source");
    git(fixture.root, "push", "-u", "origin", "main");
    prepare(fixture.root, firstSource);
    commitAll(
      fixture.root,
      `chore(release): v0.5.1\n\nRelease-Source: ${firstSource}\n\nRelease-Bump: patch`,
    );
    git(fixture.root, "push", "origin", "main");

    writeManifest(fixture.root, "9.0.0");
    const driftedSource = commitAll(fixture.root, "feat: drift version manually");
    git(fixture.root, "push", "origin", "main");
    expect(() => prepare(fixture.root, driftedSource)).toThrow(
      "package version is CI-owned; expected 0.5.1",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.remote, { recursive: true, force: true });
  }
});
