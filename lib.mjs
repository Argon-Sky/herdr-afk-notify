import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const pluginRoot = dirname(fileURLToPath(import.meta.url));

export function loadDotEnv(path) {
  const paths = path ? [path] : defaultDotEnvPaths();
  for (const candidate of paths) {
    loadDotEnvFile(candidate);
  }
}

function defaultDotEnvPaths() {
  const paths = [];
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) {
    paths.push(join(process.env.HERDR_PLUGIN_CONFIG_DIR, ".env"));
  }
  paths.push(join(pluginRoot, ".env"));
  return [...new Set(paths)];
}

function loadDotEnvFile(path) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const equals = line.indexOf("=");
    if (equals === -1) {
      continue;
    }
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = parseValue(value);
  }
}

// Quoted values keep everything inside the quotes; unquoted values stop at
// the first whitespace-prefixed `#`, matching dotenv's inline comment rule.
function parseValue(value) {
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    if (end !== -1) {
      return value.slice(1, end);
    }
  }
  return value.replace(/\s+#.*$/, "").trim();
}

export function seconds(name, fallback) {
  const raw = process.env[name]?.trim();
  const value = Number(raw);
  return raw && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function stateDir() {
  if (process.env.HERDR_PLUGIN_STATE_DIR) {
    return process.env.HERDR_PLUGIN_STATE_DIR;
  }
  const stateHome =
    process.env.XDG_STATE_HOME ||
    (process.env.HOME ? join(process.env.HOME, ".local", "state") : pluginRoot);
  return join(stateHome, "herdr-afk-notify");
}

function panePath(paneId) {
  return join(stateDir(), "panes", `${paneId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

// Per pane: `start` is when the current turn began working, `delivery` names the one pending notification.
export function readPane(paneId) {
  try {
    const pane = JSON.parse(readFileSync(panePath(paneId), "utf8"));
    return pane && typeof pane === "object" ? pane : {};
  } catch {
    return {};
  }
}

export function writePane(paneId, pane) {
  const path = panePath(paneId);
  if (pane.start === undefined && pane.delivery === undefined) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(pane)}\n`, "utf8");
  renameSync(tmp, path);
}

export function herdr(args) {
  try {
    const bin = process.env.HERDR_BIN_PATH ?? "herdr";
    const result = spawnSync(bin, args, { encoding: "utf8" });
    let json = null;
    try {
      json = JSON.parse(result.stdout);
    } catch {
      json = null;
    }
    return { ok: !result.error && result.status === 0, json };
  } catch {
    return { ok: false, json: null };
  }
}

// Seconds since the last keyboard or mouse input on this Mac, or null when it cannot be read.
export function idleSeconds() {
  const bin = process.env.AFK_IOREG_PATH || "/usr/sbin/ioreg";
  const result = spawnSync(bin, ["-c", "IOHIDSystem", "-d", "4"], { encoding: "utf8" });
  const match = /"HIDIdleTime" = (\d+)/.exec(result.stdout ?? "");
  return match ? Number(match[1]) / 1e9 : null;
}

export async function sendNtfy({ title, body, blocked }) {
  const topic = process.env.NTFY_TOPIC?.trim();
  if (!topic) {
    throw new Error("missing NTFY_TOPIC");
  }
  const server = (process.env.NTFY_SERVER ?? "https://ntfy.sh").replace(/\/+$/, "");
  const token = process.env.NTFY_TOKEN?.trim();
  const headers = {
    // Header values are Latin-1; RFC 2047 carries the middle dot and any tab name intact.
    Title: `=?UTF-8?B?${Buffer.from(title).toString("base64")}?=`,
    Priority: blocked ? "4" : "3",
    Tags: blocked ? "eyes" : "white_check_mark",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${server}/${topic}`, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${response.status} ${text}`);
  }
}
