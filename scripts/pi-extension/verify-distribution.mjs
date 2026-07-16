import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parse } from "acorn";
import crossSpawn from "cross-spawn";
import { t as listArchive, x as extractArchive } from "tar";
import config from "./config.mjs";
import {
  isAllowedExternal,
  isStandardDocument,
  projectRoot,
  readDistributionContract,
} from "./distribution-contract.mjs";

const projectManifest = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8"));
const packageManager = String(projectManifest.packageManager ?? "npm").split("@")[0];

const run = (command, args, options = {}) => {
  const result = crossSpawn.sync(command, args, {
    cwd: options.cwd ?? projectRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`);
  }
  return result.stdout ?? "";
};

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
  return files.sort((left, right) => left.localeCompare(right));
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
      assert.equal(node.source?.type, "Literal", "dynamic import must use a literal specifier");
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
  assert.deepEqual(
    listFiles(contract.outputDirectory),
    [contract.outputFileName],
    "Pi bundle directory must contain only the declared entry",
  );
  const imports = inspectModule(readFileSync(contract.entryAbsolute, "utf8"));
  const forbidden = imports.filter((specifier) => !isAllowedExternal(specifier));
  assert.deepEqual(
    forbidden,
    [],
    `bundle contains non-host runtime imports: ${forbidden.join(", ")}`,
  );
  return imports;
};

const verifyAssets = (contract) => {
  for (const asset of contract.assets) {
    assert.equal(asset.exists, true, `missing declared asset: ${asset.relative}`);
    if (asset.kind === "directory") {
      assert.ok(
        listFiles(asset.absolute).length > 0,
        `declared asset directory is empty: ${asset.relative}`,
      );
    }
  }
  return contract.assets.map(({ relative: path, kind }) => ({ path, kind }));
};

const verifyWithPiLoader = async (packageRoot, harnessRoot) => {
  const loaderModule = config.hostModules[0];
  const host = await import(loaderModule);
  assert.equal(
    typeof host.discoverAndLoadExtensions,
    "function",
    `${loaderModule} does not export discoverAndLoadExtensions`,
  );
  const result = await host.discoverAndLoadExtensions(
    [packageRoot],
    harnessRoot,
    resolve(harnessRoot, ".pi-agent-test"),
  );
  assert.deepEqual(result.errors, [], "Pi extension loader reported errors");
  assert.equal(result.extensions.length, 1, "Pi loader must load exactly one extension");
  const extension = result.extensions[0];
  assert.ok(extension);
  for (const command of config.expected.commands) {
    assert.ok(extension.commands.has(command), `archive did not register /${String(command)}`);
  }
  for (const tool of config.expected.tools) {
    assert.ok(extension.tools.has(tool), `archive did not register ${String(tool)}`);
  }
  for (const handler of config.expected.handlers) {
    assert.ok(extension.handlers.has(handler), `archive did not register ${String(handler)}`);
  }
  return {
    errors: result.errors,
    commands: [...config.expected.commands],
    tools: [...config.expected.tools],
    handlers: [...config.expected.handlers],
  };
};

const secretLike = (path) =>
  /(^|\/)(?:\.env(?:\.|$)|\.dev\.vars$|\.npmrc$|id_[^/]+$|[^/]+\.(?:pem|key|p12|pfx)$|credentials?(?:\.[^/]*)?$)/i.test(
    path,
  );

const runTarFile = (operation, options) =>
  new Promise((resolvePromise, rejectPromise) => {
    operation({ ...options, sync: false }, (error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    }).catch(rejectPromise);
  });

const inspectArchiveEntries = async (archive) => {
  const entries = [];
  await runTarFile(listArchive, {
    file: archive,
    onentry: (entry) => entries.push({ path: entry.path, mode: entry.mode }),
  });
  assert.ok(entries.length > 0, "archive must not be empty");
  for (const entry of entries) {
    assert.equal(entry.path.includes("\\"), false, `archive path must use /: ${entry.path}`);
    assert.equal(entry.path.startsWith("/"), false, `archive path must be relative: ${entry.path}`);
    assert.equal(
      entry.path.split("/").includes(".."),
      false,
      `archive path must not traverse: ${entry.path}`,
    );
    assert.ok(
      entry.path === "package" || entry.path.startsWith("package/"),
      `archive entry must be under package/: ${entry.path}`,
    );
    const packagePath = entry.path.replace(/^package\/?/, "").replace(/\/$/, "");
    if (packagePath)
      assert.equal(
        secretLike(packagePath),
        false,
        `archive contains secret-like file: ${packagePath}`,
      );
  }
  return entries;
};

const verifyRawPackage = async (archive) => {
  const nodeModules = resolve(projectRoot, "node_modules");
  assert.ok(
    existsSync(nodeModules),
    "install the repository test harness before archive verification",
  );
  const temporary = mkdtempSync(join(nodeModules, ".pi-extension-archive-"));
  try {
    const extracted = resolve(temporary, "raw");
    mkdirSync(extracted, { recursive: true });
    const archiveEntries = await inspectArchiveEntries(archive);
    await runTarFile(extractArchive, { file: archive, cwd: extracted });
    const packageRoot = resolve(extracted, "package");
    const contract = readDistributionContract(packageRoot);
    const remainingImports = verifyBundle(contract);
    const assets = verifyAssets(contract);
    const packageFiles = listFiles(packageRoot);
    const unexpected = packageFiles.filter((path) => {
      if (path === "package.json" || isStandardDocument(path)) return false;
      return !contract.publishedRoots.some((root) => path === root || path.startsWith(`${root}/`));
    });
    assert.deepEqual(unexpected, [], `archive contains undeclared files: ${unexpected.join(", ")}`);
    assert.deepEqual(packageFiles.filter(secretLike), [], "archive contains secret-like files");
    assert.equal(
      existsSync(resolve(packageRoot, "node_modules")),
      false,
      "archive must not contain node_modules",
    );
    assert.equal(existsSync(resolve(packageRoot, "src")), false, "archive must not contain src");
    const loader = await verifyWithPiLoader(packageRoot, temporary);
    return {
      temporary,
      packageRoot,
      facts: {
        profile: contract.profile,
        entry: contract.entryRelative,
        bundleBytes: statSync(contract.entryAbsolute).size,
        assets,
        remainingImports,
        packageFiles,
        archiveEntries: archiveEntries.length,
        loader,
      },
    };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
};

const archiveIntegrity = (archive) =>
  `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`;

const verifyArchive = async (archiveInput, invokeDomain) => {
  const archive = resolve(projectRoot, archiveInput);
  assert.ok(existsSync(archive), `missing archive: ${archive}`);
  const raw = await verifyRawPackage(archive);
  let domainCheck = null;
  try {
    if (invokeDomain && typeof projectManifest.scripts?.["pi:domain-check"] === "string") {
      run(packageManager, ["run", "pi:domain-check", "--", raw.packageRoot], {
        env: {
          ...process.env,
          PI_EXTENSION_ARCHIVE: archive,
          PI_EXTENSION_PACKAGE_ROOT: raw.packageRoot,
        },
      });
      domainCheck = "pi:domain-check";
    }
    return { ...raw.facts, integrity: archiveIntegrity(archive), domainCheck };
  } finally {
    rmSync(raw.temporary, { recursive: true, force: true });
  }
};

const packCurrentOutput = () => {
  const temporary = mkdtempSync(join(resolve(projectRoot, "node_modules"), ".pi-extension-pack-"));
  try {
    run("npm", ["pack", "--ignore-scripts", "--pack-destination", temporary]);
    const archives = readdirSync(temporary).filter((file) => file.endsWith(".tgz"));
    assert.equal(archives.length, 1, `expected one archive, found ${archives.length}`);
    return { temporary, archive: resolve(temporary, archives[0]) };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
};

const mode = process.argv[2];
assert.ok(
  new Set(["bundle", "package", "archive", "platform"]).has(mode),
  "usage: verify-distribution.mjs bundle|package|archive <path>|platform <path>",
);

let result;
if (mode === "bundle") {
  const contract = readDistributionContract();
  result = {
    profile: contract.profile,
    entry: contract.entryRelative,
    bundleBytes: statSync(contract.entryAbsolute).size,
    assets: verifyAssets(contract),
    remainingImports: verifyBundle(contract),
  };
} else if (mode === "package") {
  const packed = packCurrentOutput();
  try {
    result = await verifyArchive(packed.archive, false);
  } finally {
    rmSync(packed.temporary, { recursive: true, force: true });
  }
} else {
  const rawArguments = process.argv.slice(3);
  const archiveArguments = rawArguments[0] === "--" ? rawArguments.slice(1) : rawArguments;
  assert.equal(archiveArguments.length, 1, `${mode} mode requires exactly one archive path`);
  result = await verifyArchive(archiveArguments[0], mode === "archive");
}

process.stdout.write(`${JSON.stringify({ selfContained: true, ...result }, null, 2)}\n`);
