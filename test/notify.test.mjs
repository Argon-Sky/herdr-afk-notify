import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const execFileAsync = promisify(execFile);

// Fake `herdr` serves canned `agent get` and `tab list` JSON; fake `ioreg` reports the idle seconds kept in a file.
const FAKE_HERDR = `#!/bin/sh
case "$1 $2" in
  "agent get") cat "$FAKE_DIR/agent.json" ;;
  "tab list") cat "$FAKE_DIR/tabs.json" ;;
esac
`;
const FAKE_IOREG = `#!/bin/sh
echo "  |   \\"HIDIdleTime\\" = $(cat "$FAKE_DIR/idle")000000000"
`;

function harness({ status = "done", focused = false, idle = 600, label = "174", title = "Refine 174" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "afk-"));
  writeFileSync(join(dir, "herdr"), FAKE_HERDR, { mode: 0o755 });
  writeFileSync(join(dir, "ioreg"), FAKE_IOREG, { mode: 0o755 });
  const h = {
    stateDir: join(dir, "state"),
    configDir: join(dir, "config"),
    agent(fields) {
      const agent = { agent: "claude", agent_status: status, focused, workspace_id: "w1", tab_id: "w1:t2", terminal_title_stripped: title, ...fields };
      writeFileSync(join(dir, "agent.json"), JSON.stringify({ result: { agent } }));
    },
    idle(value) {
      writeFileSync(join(dir, "idle"), String(value));
    },
    env: {
      FAKE_DIR: dir,
      HERDR_BIN_PATH: join(dir, "herdr"),
      AFK_IOREG_PATH: join(dir, "ioreg"),
      HERDR_PLUGIN_STATE_DIR: join(dir, "state"),
      HERDR_PLUGIN_CONFIG_DIR: join(dir, "config"),
      AFK_POLL_SECONDS: "0.1",
      AFK_MIN_WORKING_SECONDS: "0",
    },
    log() {
      const path = join(dir, "state", "deliver.log");
      return existsSync(path) ? readFileSync(path, "utf8") : "";
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
  h.agent({});
  h.idle(idle);
  writeFileSync(join(dir, "tabs.json"), JSON.stringify({ result: { tabs: [{ tab_id: "w1:t1", label: "1" }, { tab_id: "w1:t2", label }] } }));
  return h;
}

async function hook(h, status, env = {}) {
  const event = JSON.stringify({ event: "pane_agent_status_changed", data: { pane_id: "w1:p2", workspace_id: "w1", agent_status: status, agent: "claude" } });
  return execFileAsync(process.execPath, [join(root, "notify.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...h.env, HERDR_PLUGIN_EVENT_JSON: event, ...env },
  });
}

async function withNtfy(fn) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200).end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn({ NTFY_SERVER: `http://127.0.0.1:${server.address().port}`, NTFY_TOPIC: "t" }, requests);
  } finally {
    server.close();
  }
}

// The delivery runs detached, so a test waits for its one-line outcome in deliver.log.
async function outcome(h, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const log = h.log().trim();
    if (log) {
      return log.split("\n").at(-1).replace(/^\S+ /, "");
    }
    await sleep(25);
  }
  return "";
}

function decodeTitle(header) {
  const match = /^=\?UTF-8\?B\?(.+)\?=$/.exec(header);
  return match ? Buffer.from(match[1], "base64").toString("utf8") : header;
}

test("a long turn that ends while you are away sends Agent done with the tab name", async () => {
  const h = harness();
  try {
    await withNtfy(async (ntfy, requests) => {
      await hook(h, "working", ntfy);
      await hook(h, "done", ntfy);
      assert.equal(await outcome(h), "w1:p2 done: sent");
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, "/t");
      assert.equal(decodeTitle(requests[0].headers.title), "Agent done · 174");
      assert.equal(requests[0].body, "Claude worked for 0 min");
      assert.equal(requests[0].headers.priority, "3");
    });
  } finally {
    h.cleanup();
  }
});

test("blocked sends Agent needs you at priority 4 without a working turn", async () => {
  const h = harness({ status: "blocked" });
  try {
    await withNtfy(async (ntfy, requests) => {
      await hook(h, "blocked", ntfy);
      assert.equal(await outcome(h), "w1:p2 blocked: sent");
      assert.equal(decodeTitle(requests[0].headers.title), "Agent needs you · 174");
      assert.equal(requests[0].body, "Claude is waiting for your answer");
      assert.equal(requests[0].headers.priority, "4");
      assert.equal(requests[0].headers.tags, "eyes");
    });
  } finally {
    h.cleanup();
  }
});

test("a turn shorter than AFK_MIN_WORKING_SECONDS, or one never seen working, starts no delivery", async () => {
  const h = harness();
  try {
    await withNtfy(async (ntfy) => {
      await hook(h, "idle", ntfy);
      await hook(h, "working", { ...ntfy, AFK_MIN_WORKING_SECONDS: "300" });
      await hook(h, "done", { ...ntfy, AFK_MIN_WORKING_SECONDS: "300" });
      await sleep(300);
      assert.equal(h.log(), "");
      assert.equal(existsSync(join(h.stateDir, "panes", "w1_p2.json")), false);
    });
  } finally {
    h.cleanup();
  }
});

test("idle then done for one turn sends once", async () => {
  const h = harness();
  try {
    await withNtfy(async (ntfy, requests) => {
      await hook(h, "working", ntfy);
      await hook(h, "idle", ntfy);
      await hook(h, "done", ntfy);
      assert.equal(await outcome(h), "w1:p2 done: sent");
      await sleep(300);
      assert.equal(requests.length, 1);
    });
  } finally {
    h.cleanup();
  }
});

test("at the keyboard it waits, then sends once you have been away long enough", async () => {
  const h = harness({ idle: 5 });
  try {
    await withNtfy(async (ntfy, requests) => {
      await hook(h, "working", ntfy);
      await hook(h, "done", ntfy);
      await sleep(400);
      assert.equal(requests.length, 0);
      h.idle(200);
      assert.equal(await outcome(h), "w1:p2 done: sent");
      assert.equal(requests.length, 1);
    });
  } finally {
    h.cleanup();
  }
});

test("a focused pane at the keyboard counts as seen and is not sent", async () => {
  const h = harness({ idle: 5, focused: true });
  try {
    await withNtfy(async (ntfy, requests) => {
      await hook(h, "working", ntfy);
      await hook(h, "done", ntfy);
      assert.equal(await outcome(h), "w1:p2 done: seen at the keyboard");
      assert.equal(requests.length, 0);
    });
  } finally {
    h.cleanup();
  }
});

test("an agent that moves on while you are at the keyboard is not sent", async () => {
  const h = harness({ status: "blocked", idle: 5 });
  try {
    await withNtfy(async (ntfy, requests) => {
      await hook(h, "blocked", ntfy);
      await sleep(300);
      h.agent({ agent_status: "working" });
      assert.equal(await outcome(h), "w1:p2 blocked: agent is working again");
      assert.equal(requests.length, 0);
    });
  } finally {
    h.cleanup();
  }
});

test("a new turn supersedes a pending delivery", async () => {
  const h = harness({ status: "blocked", idle: 5 });
  try {
    await withNtfy(async (ntfy, requests) => {
      await hook(h, "blocked", ntfy);
      await sleep(300);
      await hook(h, "working", ntfy);
      assert.equal(await outcome(h), "w1:p2 blocked: superseded");
      assert.equal(requests.length, 0);
    });
  } finally {
    h.cleanup();
  }
});

test("an automatic tab label falls back to the pane's terminal title", async () => {
  const h = harness({ label: "2" });
  try {
    await withNtfy(async (ntfy, requests) => {
      await hook(h, "working", ntfy);
      await hook(h, "done", ntfy);
      assert.equal(await outcome(h), "w1:p2 done: sent");
      assert.equal(decodeTitle(requests[0].headers.title), "Agent done · Refine 174");
    });
  } finally {
    h.cleanup();
  }
});

test("config comes from the plugin config dir .env", async () => {
  const h = harness();
  try {
    await withNtfy(async (ntfy, requests) => {
      mkdirSync(h.configDir);
      writeFileSync(join(h.configDir, ".env"), `NTFY_SERVER=${ntfy.NTFY_SERVER} # comment\nNTFY_TOPIC="from-dotenv"\nNTFY_TOKEN='tk#1'\n`);
      await hook(h, "working");
      await hook(h, "done");
      assert.equal(await outcome(h), "w1:p2 done: sent");
      assert.equal(requests[0].url, "/from-dotenv");
      assert.equal(requests[0].headers.authorization, "Bearer tk#1");
    });
  } finally {
    h.cleanup();
  }
});

test("a missing topic or an unreachable server is logged, never thrown", async () => {
  const h = harness({ status: "blocked" });
  try {
    await hook(h, "blocked");
    assert.equal(await outcome(h), "w1:p2 blocked: failed, missing NTFY_TOPIC");
    rmSync(join(h.stateDir, "deliver.log"));
    await hook(h, "blocked", { NTFY_SERVER: "http://127.0.0.1:9", NTFY_TOPIC: "t" });
    assert.match(await outcome(h), /^w1:p2 blocked: failed, /);
  } finally {
    h.cleanup();
  }
});

test("the hook exits 0 and stays silent on malformed events", async () => {
  const h = harness();
  try {
    for (const json of ["garbage", "null", "{}", JSON.stringify({ data: { pane_id: "w1:p2" } })]) {
      const { stdout, stderr } = await hook(h, "done", { HERDR_PLUGIN_EVENT_JSON: json });
      assert.equal(stdout, "");
      assert.equal(stderr, "");
    }
  } finally {
    h.cleanup();
  }
});

test("run.sh finds node and runs the hook", async () => {
  const h = harness();
  try {
    const event = JSON.stringify({ data: { pane_id: "w1:p2", agent_status: "working", agent: "pi" } });
    const { stdout } = await execFileAsync("/bin/sh", [join(root, "run.sh"), "notify.mjs"], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...h.env, HERDR_PLUGIN_EVENT_JSON: event },
    });
    assert.equal(stdout.trim(), "w1:p2 pi working");
  } finally {
    h.cleanup();
  }
});
