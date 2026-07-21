import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelMessage } from "ai";

const SESSION_DIR = ".sessions";

export interface SessionEntry {
  type: "message";
  timestamp: string;
  message: ModelMessage;
}

export class SessionStore {
  private dir: string;
  private sessionId: string;

  constructor(sessionId: string = "default") {
    this.sessionId = sessionId;
    this.dir = SESSION_DIR;
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  private get filePath(): string {
    return join(this.dir, `${this.sessionId}.jsonl`);
  }

  append(message: ModelMessage): void {
    const entry: SessionEntry = {
      type: "message",
      timestamp: new Date().toISOString(),
      message,
    };
    appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
  }

  appendAll(messages: ModelMessage[]): void {
    for (const msg of messages) {
      this.append(msg);
    }
  }

  load(): ModelMessage[] {
    return this.loadEntries().map((e) => e.message);
  }

  /** 加载消息并携带原始时间戳（供 TTL 防御使用） */
  loadWithTimestamps(): { messages: ModelMessage[]; timestamps: Map<number, number> } {
    const entries = this.loadEntries();
    const messages: ModelMessage[] = [];
    const timestamps = new Map<number, number>();
    entries.forEach((entry, i) => {
      messages.push(entry.message);
      timestamps.set(i, new Date(entry.timestamp).getTime() || Date.now());
    });
    return { messages, timestamps };
  }

  private loadEntries(): SessionEntry[] {
    if (!existsSync(this.filePath)) return [];
    const content = readFileSync(this.filePath, "utf-8").trim();
    if (!content) return [];

    const entries: SessionEntry[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry: SessionEntry = JSON.parse(line);
        if (entry.type === "message") {
          entries.push(entry);
        }
      } catch {
        /* skip malformed lines */
      }
    }
    return entries;
  }

  exists(): boolean {
    return existsSync(this.filePath);
  }
}
