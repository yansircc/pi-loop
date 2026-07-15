import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse } from "acorn";
import config from "./config.mjs";
import {
  isAllowedExternal,
  projectRoot,
  readDistributionContract,
} from "./distribution-contract.mjs";

const listFiles = (root) => {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    assert.ok(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else files.push(relative(root, path).split(sep).join("/"));
    }
  }
  return files.sort();
};

const inspectModule = (source) => {
  const root = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const imports = new Set();
  const pending = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    const node = value;
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration"
    ) {
      if (node.source) imports.add(String(node.source.value));
    } else if (node.type === "ImportExpression") {
      assert.equal(node.source?.type, "Literal", "dynamic import must be literal");
      imports.add(String(node.source.value));
    } else if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === "require"
    ) {
      assert.fail("bundle must not contain require() calls");
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "start" && key !== "end" && key !== "loc") pending.push(child);
    }
  }
  return [...imports].sort((left, right) => left.localeCompare(right));
};

const verifyBundle = (contract) => {
  assert.ok(existsSync(contract.entryAbsolute), `missing bundle: ${contract.entryRelative}`);
  assert.deepEqual(listFiles(contract.outputDirectory), [contract.outputFileName]);
  const imports = inspectModule(readFileSync(contract.entryAbsolute, "utf8"));
  const forbidden = imports.filter((specifier) => !isAllowedExternal(specifier));
  assert.deepEqual(forbidden, [], `unbundled runtime imports: ${forbidden.join(", ")}`);
  return imports;
};

const verifyWithPiLoader = async (packageRoot) => {
  const host = await import(config.loaderModule);
  assert.equal(typeof host.discoverAndLoadExtensions, "function");
  const result = await host.discoverAndLoadExtensions(
    [packageRoot],
    packageRoot,
    resolve(packageRoot, ".pi-agent-test"),
  );
  assert.deepEqual(result.errors, [], "Pi extension loader reported errors");
  assert.equal(result.extensions.length, 1, "Pi loader must load exactly one extension");
  const extension = result.extensions[0];
  assert.ok(extension);
  for (const command of config.expected.commands) {
    assert.ok(extension.commands.has(command), `bundle did not register /${command}`);
  }
  for (const tool of config.expected.tools) {
    assert.ok(extension.tools.has(tool), `bundle did not register ${tool}`);
  }
  for (const handler of config.expected.handlers) {
    assert.ok(extension.handlers.has(handler), `bundle did not register ${handler}`);
  }
  return {
    commands: config.expected.commands,
    tools: config.expected.tools,
    handlers: config.expected.handlers,
  };
};

const isStandardDocument = (path) =>
  !path.includes("/") && /^(?:README|LICENSE|LICENCE|NOTICE)(?:\..+)?$/i.test(path);

const verifyPackage = async () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-loop-package-"));
  try {
    const archive = join(temporary, "extension.tgz");
    const extracted = join(temporary, "extracted");
    execFileSync("pnpm", ["--config.ignore-scripts=true", "pack", "--out", archive], {
      cwd: projectRoot,
      stdio: "pipe",
    });
    mkdirSync(extracted, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "-C", extracted]);
    const packageRoot = join(extracted, "package");
    const contract = readDistributionContract(packageRoot);
    const imports = verifyBundle(contract);
    const files = listFiles(packageRoot);
    const unexpected = files.filter(
      (path) =>
        path !== "package.json" && path !== contract.entryRelative && !isStandardDocument(path),
    );
    assert.deepEqual(unexpected, [], `tarball contains undeclared files: ${unexpected.join(", ")}`);
    assert.equal(existsSync(join(packageRoot, "node_modules")), false);
    assert.equal(existsSync(join(packageRoot, "src")), false);
    const loader = await verifyWithPiLoader(packageRoot);
    const requestedArchive = process.env.PI_PACKAGE_ARCHIVE;
    const exportedArchive = requestedArchive ? resolve(projectRoot, requestedArchive) : undefined;
    if (exportedArchive) {
      mkdirSync(dirname(exportedArchive), { recursive: true });
      copyFileSync(archive, exportedArchive);
    }
    return {
      entry: contract.entryRelative,
      bundleBytes: statSync(contract.entryAbsolute).size,
      remainingImports: imports,
      packageFiles: files,
      loader,
      ...(exportedArchive
        ? { exportedArchive: relative(projectRoot, exportedArchive).split(sep).join("/") }
        : {}),
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
};

const mode = process.argv[2];
assert.ok(mode === "bundle" || mode === "package", "usage: verify-distribution.mjs bundle|package");
const contract = readDistributionContract();
const imports = verifyBundle(contract);
const result =
  mode === "package"
    ? await verifyPackage()
    : {
        entry: contract.entryRelative,
        bundleBytes: statSync(contract.entryAbsolute).size,
        remainingImports: imports,
      };
process.stdout.write(`${JSON.stringify({ selfContained: true, ...result }, null, 2)}\n`);
