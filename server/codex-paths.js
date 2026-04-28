import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const COMMON_APP_PATHS = [
  "/Applications/Codex.app",
  path.join(os.homedir(), "Applications", "Codex.app")
];

export function findCodexApp() {
  const configured = normalizePath(process.env.CODEX_DESKTOP_APP);
  if (configured && isDirectory(configured)) return configured;

  for (const candidate of COMMON_APP_PATHS) {
    if (isDirectory(candidate)) return candidate;
  }

  const spotlight = findWithSpotlight();
  if (spotlight) return spotlight;

  return "";
}

export function findCodexBinary() {
  const configured = normalizePath(process.env.CODEX_APP_SERVER_BIN || process.env.CODEX_BINARY);
  if (configured && isExecutableFile(configured)) return configured;

  const app = findCodexApp();
  if (app) {
    const bundled = path.join(app, "Contents", "Resources", "codex");
    if (isExecutableFile(bundled)) return bundled;
  }

  return "codex";
}

export function findCodexLaunchTarget() {
  return findCodexApp() || process.env.CODEX_DESKTOP_APP || "Codex";
}

function findWithSpotlight() {
  try {
    const output = execFileSync("/usr/bin/mdfind", [
      "kMDItemCFBundleIdentifier == 'com.openai.codex' || kMDItemFSName == 'Codex.app'"
    ], {
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"]
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.endsWith("/Codex.app") && isDirectory(line)) || "";
  } catch {
    return "";
  }
}

function normalizePath(value) {
  if (!value) return "";
  const text = String(value).trim();
  if (!text) return "";
  if (text === "Codex") return text;
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return text;
}

function isDirectory(value) {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function isExecutableFile(value) {
  try {
    fs.accessSync(value, fs.constants.X_OK);
    return fs.statSync(value).isFile();
  } catch {
    return false;
  }
}
