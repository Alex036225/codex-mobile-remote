import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const codexHome = path.join(os.homedir(), ".codex");
const stateDbPath = path.join(codexHome, "state_5.sqlite");

export async function readSessionBackedThread(threadId) {
  const thread = await readThreadRecord(threadId);
  if (!thread?.rolloutPath) return null;

  const messages = await readSessionMessages(thread.rolloutPath);
  return {
    thread,
    messages
  };
}

async function readThreadRecord(threadId) {
  const sql = [
    "select id, title, rollout_path, cwd, updated_at_ms, updated_at",
    "from threads",
    `where id = '${escapeSql(threadId)}'`,
    "limit 1;"
  ].join(" ");

  const { stdout } = await execFile("sqlite3", [
    "-separator",
    "\t",
    stateDbPath,
    sql
  ]);

  const line = stdout.trim();
  if (!line) return null;

  const [id, title, rolloutPath, cwd, updatedAtMs, updatedAt] = line.split("\t");
  return {
    id,
    title,
    rolloutPath,
    cwd,
    updatedAtMs: Number(updatedAtMs) || null,
    updatedAt: Number(updatedAt) || null
  };
}

async function readSessionMessages(sessionPath) {
  const raw = await fs.readFile(sessionPath, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const messages = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = entry?.payload;
    if (entry?.type !== "response_item" || payload?.type !== "message") continue;
    if (payload.role !== "user" && payload.role !== "assistant") continue;

    const text = extractMessageText(payload.content || []);
    if (!text) continue;

    messages.push({
      id: `session-${index}`,
      role: payload.role,
      text,
      phase: payload.phase || null,
      timestamp: entry.timestamp || null
    });
  }

  return messages;
}

function extractMessageText(content) {
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
        return part.text || "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function escapeSql(value) {
  return String(value || "").replaceAll("'", "''");
}
