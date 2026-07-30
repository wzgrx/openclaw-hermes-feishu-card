#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const manifest = JSON.parse(
  await readFile(resolve(root, "openclaw.plugin.json"), "utf8"),
);
const hermesManifest = await readFile(resolve(root, "plugin.yaml"), "utf8");
const packagedHermesManifest = await readFile(
  resolve(root, "hermes_feishu_card_footer", "plugin.yaml"),
  "utf8",
);
const pythonPackage = await readFile(
  resolve(root, "hermes_feishu_card_footer", "__init__.py"),
  "utf8",
);
const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok, detail });
}

check(
  "OpenClaw version parity",
  packageJson.version === manifest.version,
  `${packageJson.version} / ${manifest.version}`,
);
const yamlVersion = hermesManifest.match(/^version:\s*(\S+)\s*$/m)?.[1];
const packagedYamlVersion = packagedHermesManifest.match(
  /^version:\s*(\S+)\s*$/m,
)?.[1];
const pythonVersion = pythonPackage.match(
  /^__version__\s*=\s*["']([^"']+)["']\s*$/m,
)?.[1];
check(
  "Hermes version parity",
  [yamlVersion, packagedYamlVersion, pythonVersion].every(
    (version) => version === packageJson.version,
  ),
  `${packageJson.version} / ${yamlVersion ?? "missing"} / ${packagedYamlVersion ?? "missing"} / ${pythonVersion ?? "missing"}`,
);
check(
  "Hermes manifest copy",
  hermesManifest === packagedHermesManifest,
  hermesManifest === packagedHermesManifest ? "identical" : "out of sync",
);
check("plugin id", packageJson.name === manifest.id, manifest.id);

for (const file of [
  "dist/index.mjs",
  "dist/index.d.mts",
  "openclaw.plugin.json",
  "plugin.yaml",
  "__init__.py",
  "hermes_feishu_card_footer/__init__.py",
]) {
  try {
    await access(resolve(root, file), constants.R_OK);
    check(file, true, "present");
  } catch {
    check(file, false, "missing; run pnpm build when this is a dist artifact");
  }
}

for (const item of checks) {
  process.stdout.write(`${item.ok ? "✓" : "✗"} ${item.name}: ${item.detail}\n`);
}
if (checks.some((item) => !item.ok)) {
  process.exitCode = 1;
}
