import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import config from "./config.mjs";

export const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

const normalizeRelative = (value, label) => {
  assert.equal(typeof value, "string", `${label} must be a string`);
  const normalized = value.split("\\").join("/").replace(/^\.\//, "").replace(/\/$/, "");
  assert.ok(normalized, `${label} must not be empty`);
  assert.equal(normalized.startsWith("/"), false, `${label} must be relative`);
  assert.equal(normalized.split("/").includes(".."), false, `${label} must not traverse`);
  return normalized;
};

const nodeModules = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const hostModules = new Set(config.hostModules);

export const isAllowedExternal = (specifier) =>
  nodeModules.has(specifier) || hostModules.has(specifier);

export const isStandardDocument = (path) =>
  !path.includes("/") &&
  /^(?:README|LICENSE|LICENCE|NOTICE|CHANGELOG|CONTRIBUTING|SECURITY)(?:\..+)?$/i.test(path);

export const readDistributionContract = (root = projectRoot) => {
  assert.ok(
    new Set(["single-file", "multi-file"]).has(config.profile?.kind),
    "invalid profile kind",
  );
  assert.ok(Array.isArray(config.profile?.assets), "profile.assets must be an array");
  assert.ok(
    Array.isArray(config.hostModules) && config.hostModules.length > 0,
    "hostModules must not be empty",
  );
  for (const key of ["commands", "tools", "handlers"]) {
    assert.ok(Array.isArray(config.expected?.[key]), `expected.${key} must be an array`);
  }

  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const extensions = manifest.pi?.extensions ?? [];
  assert.equal(extensions.length, 1, "package.json must declare exactly one Pi extension");
  const entryRelative = normalizeRelative(extensions[0], "Pi extension entry");
  assert.ok(
    entryRelative.startsWith("dist/") && entryRelative.endsWith(".js"),
    "Pi extension entry must be a JavaScript file under dist/",
  );
  const entryDirectory = dirname(entryRelative).split(sep).join("/");
  const assets = config.profile.assets.map((value, index) =>
    normalizeRelative(value, `profile.assets[${index}]`),
  );
  assert.equal(new Set(assets).size, assets.length, "profile.assets must not contain duplicates");
  assert.equal(
    assets.some(
      (asset) =>
        asset === entryDirectory ||
        asset.startsWith(`${entryDirectory}/`) ||
        entryDirectory.startsWith(`${asset}/`),
    ),
    false,
    "profile assets must not overlap the Pi bundle directory",
  );
  if (config.profile.kind === "single-file") {
    assert.deepEqual(assets, [], "single-file profile must not declare assets");
  }

  const expectedFiles = [entryDirectory, ...assets];
  assert.deepEqual(
    manifest.files,
    expectedFiles,
    "package.json.files diverges from the distribution profile",
  );
  assert.equal(manifest.type, "module", "Pi extension package must use type=module");
  assert.deepEqual(
    Object.keys(manifest.dependencies ?? {}),
    [],
    "self-contained packages must not declare ordinary dependencies",
  );

  const peerNames = Object.keys(manifest.peerDependencies ?? {}).sort();
  assert.deepEqual(
    peerNames.filter((name) => !hostModules.has(name)),
    [],
    "only declared host modules may remain peer dependencies",
  );
  for (const name of peerNames) {
    assert.equal(
      manifest.peerDependenciesMeta?.[name]?.optional,
      true,
      `host peer dependency must be optional: ${name}`,
    );
  }
  if (String(manifest.name ?? "").startsWith("@")) {
    assert.equal(manifest.publishConfig?.access, "public", "scoped package must publish publicly");
  }

  const outputDirectory = resolve(root, entryDirectory);
  const entryAbsolute = resolve(root, entryRelative);
  assert.equal(
    relative(outputDirectory, entryAbsolute).split(sep).includes(".."),
    false,
    "Pi entry escapes output directory",
  );

  const assetFacts = assets.map((asset) => {
    const absolute = resolve(root, asset);
    return Object.freeze({
      relative: asset,
      absolute,
      exists: existsSync(absolute),
      kind: existsSync(absolute)
        ? statSync(absolute).isDirectory()
          ? "directory"
          : "file"
        : "missing",
    });
  });

  return Object.freeze({
    root,
    manifest,
    profile: config.profile.kind,
    assets: Object.freeze(assetFacts),
    publishedRoots: Object.freeze(expectedFiles),
    outputDirectory,
    entryDirectory,
    entryRelative,
    entryAbsolute,
    outputFileName: basename(entryAbsolute),
  });
};
