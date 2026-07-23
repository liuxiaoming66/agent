import type { ModelMessage } from "ai";
import type { ToolRegistry } from "../tools/registry.js";
import type { PromptBuilder, PromptContext } from "../context/prompt-builder.js";
import type { UsageTracker } from "../usage/tracker.js";
import type { SessionStore } from "../session/store.js";
import type { MemoryStore } from "../memory/store.js";
import type { SkillLoader } from "../skills/loader.js";

export interface CommandContext {
  messages: ModelMessage[];
  timestamps: Map<number, number>;
  registry: ToolRegistry;
  builder: PromptBuilder;
  tracker: UsageTracker;
  sessionStore: SessionStore;
  model: any;
  makePromptCtx: () => PromptContext;
  ask: () => void;
  memoryStore?: MemoryStore;
  skillLoader?: SkillLoader;
  activeSkills?: Set<string>;
  /** 注入一条 user message 并跑完整一轮 Agent（供 skill 快捷方式等复用） */
  runAgentTurn?: (userContent: string) => Promise<void>;
  [key: string]: any;
}

export type CommandHandler = (
  cmd: string,
  ctx: CommandContext,
) => boolean | "async";

export function createDispatcher(handlers: CommandHandler[]): CommandHandler {
  return (cmd, ctx) => {
    for (const h of handlers) {
      const result = h(cmd, ctx);
      if (result) return result;
    }
    return false;
  };
}
