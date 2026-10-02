import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { loadDotEnv, pluginRoot, readPane, seconds, stateDir, writePane } from "./lib.mjs";

// Anything unexpected exits 0: this hook must never surface as a Herdr failure.
try {
  main();
} catch (error) {
  console.error(`afk-notify: ${error.message}`);
}
process.exit(0);

function main() {
  const data = readEvent()?.data ?? {};
  const paneId = typeof data.pane_id === "string" ? data.pane_id : "";
  const status = typeof data.agent_status === "string" ? data.agent_status.toLowerCase() : "";
  if (!paneId || !status) {
    return;
  }
  // One line per event lands in `herdr plugin log list`, which is how a harness's state sequence is checked.
  console.log(`${paneId} ${data.agent ?? "?"} ${status}`);

  loadDotEnv();
  const now = Date.now();
  const pane = readPane(paneId);
  let kind;
  let minutes;

  if (status === "working") {
    pane.start ??= now;
    delete pane.delivery;
    writePane(paneId, pane);
    return;
  }
  if (status === "blocked") {
    kind = "blocked";
  } else if (status === "idle" || status === "done") {
    const start = pane.start;
    delete pane.start;
    if (start === undefined || now - start < seconds("AFK_MIN_WORKING_SECONDS", 300) * 1000) {
      writePane(paneId, pane);
      return;
    }
    kind = "done";
    minutes = Math.round((now - start) / 60000);
  } else {
    return;
  }

  pane.delivery = randomUUID();
  writePane(paneId, pane);
  deliver({ paneId, delivery: pane.delivery, kind, agent: data.agent, minutes });
}

function readEvent() {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON ?? "");
  } catch {
    return null;
  }
}

// Waiting for the owner to walk away can take hours, so it runs detached and the hook returns at once.
function deliver(job) {
  mkdirSync(stateDir(), { recursive: true });
  const log = openSync(join(stateDir(), "deliver.log"), "a");
  spawn(process.execPath, [join(pluginRoot, "deliver.mjs")], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, AFK_JOB: JSON.stringify(job) },
  }).unref();
}
