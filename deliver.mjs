import { setTimeout as sleep } from "node:timers/promises";
import { herdr, idleSeconds, readPane, seconds, sendNtfy, writePane } from "./lib.mjs";

const job = JSON.parse(process.env.AFK_JOB ?? "{}");
const awaySeconds = seconds("AFK_AWAY_SECONDS", 180);
const pollMs = seconds("AFK_POLL_SECONDS", 15) * 1000;
const deadline = Date.now() + seconds("AFK_MAX_WAIT_SECONDS", 12 * 3600) * 1000;
const waitingStatuses = job.kind === "blocked" ? ["blocked"] : ["idle", "done"];

try {
  console.log(`${stamp()} ${job.paneId} ${job.kind}: ${await run()}`);
} catch (error) {
  console.log(`${stamp()} ${job.paneId} ${job.kind}: failed, ${error.message}`);
}

// Sends once the owner has been away long enough, and gives up as soon as the notification would be stale.
async function run() {
  while (Date.now() < deadline) {
    if (readPane(job.paneId).delivery !== job.delivery) {
      return "superseded";
    }
    const agent = herdr(["agent", "get", job.paneId]).json?.result?.agent;
    if (!agent) {
      return "pane gone";
    }
    if (!waitingStatuses.includes(agent.agent_status)) {
      return `agent is ${agent.agent_status} again`;
    }
    const idle = idleSeconds();
    if (idle !== null && idle < awaySeconds && agent.focused) {
      return "seen at the keyboard";
    }
    if (idle === null || idle >= awaySeconds) {
      await sendNtfy(message(agent));
      clearDelivery();
      return "sent";
    }
    await sleep(pollMs);
  }
  clearDelivery();
  return "gave up waiting";
}

function message(agent) {
  const name = titleCase(job.agent ?? agent.agent);
  const tab = tabName(agent, name);
  if (job.kind === "blocked") {
    return { title: `Agent needs you · ${tab}`, body: `${name} is waiting for your answer`, blocked: true };
  }
  return { title: `Agent done · ${tab}`, body: `${name} worked for ${job.minutes} min`, blocked: false };
}

// An automatic tab label is the tab's position in its workspace and says nothing, so the pane's terminal title stands in for it.
function tabName(agent, fallback) {
  const tabs = herdr(["tab", "list", "--workspace", agent.workspace_id]).json?.result?.tabs ?? [];
  const position = tabs.findIndex((tab) => tab.tab_id === agent.tab_id);
  const label = String(tabs[position]?.label ?? "").trim();
  if (label && label !== String(position + 1)) {
    return label;
  }
  return String(agent.terminal_title_stripped ?? "").trim() || fallback;
}

function clearDelivery() {
  const pane = readPane(job.paneId);
  if (pane.delivery === job.delivery) {
    delete pane.delivery;
    writePane(job.paneId, pane);
  }
}

function titleCase(value) {
  const text = String(value ?? "").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Agent";
}

function stamp() {
  return new Date().toISOString();
}
