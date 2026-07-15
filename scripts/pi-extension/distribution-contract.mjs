import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import config from "./config.mjs";

export const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

const nodeModules = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const hostModules = new Set(config.hostModules);

export const isAllowedExternal = (specifier) =>
  nodeModules.has(specifier) || hostModules.has(specifier);

export const readDistributionContract = (root = projectRoot) => {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const extensions = manifest.pi?.extensions ?? [];
  assert.equal(extensions.length, 1, "package.json must declare exactly one Pi extension");
  const entryRelative = extensions[0]?.replace(/^\.\//, "");
  assert.ok(entryRelative, "Pi extension entry is missing");
  assert.ok(
    entryRelative.startsWith("dist/") && entryRelative.endsWith(".js"),
    "Pi extension entry must be a JavaScript file under dist/",
  );
  const entryDirectory = dirname(entryRelative).split(sep).join("/");
  assert.deepEqual(manifest.files, [entryDirectory], "package files diverge from Pi entry");
  assert.deepEqual(
    Object.keys(manifest.dependencies ?? {}),
    [],
    "self-contained packages must not declare ordinary dependencies",
  );
  const peerNames = Object.keys(manifest.peerDependencies ?? {}).sort();
  assert.deepEqual(
    peerNames.filter((name) => !hostModules.has(name)),
    [],
    "only declared host modules may remain peers",
  );
  for (const name of peerNames) {
    assert.equal(manifest.peerDependenciesMeta?.[name]?.optional, true);
  }
  const outputDirectory = resolve(root, entryDirectory);
  const entryAbsolute = resolve(root, entryRelative);
  assert.ok(entryAbsolute.startsWith(`${outputDirectory}${sep}`));
  return Object.freeze({
    root,
    manifest,
    outputDirectory,
    entryDirectory,
    entryRelative,
    entryAbsolute,
    outputFileName: basename(entryAbsolute),
  });
};
