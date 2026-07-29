import type { LanguageModel, ModelMessage } from "ai";
import type { ToolRegistry } from "../tools/registry.js";
import type { PromptBuilder, PromptContext } from "../context/prompt-builder.js";
import type { UsageTracker } from "../usage/tracker.js";
import type { SessionStore } from "../session/store.js";
import type { MemoryStore } from "../memory/store.js";
import type { SkillLoader } from "../skills/loader.js";
import type { PluginManager } from "../plugins/manager.js";
import type { PluginDefinition } from "../plugins/types.js";
import type { ChannelGateway } from "../channels/gateway.js";
import type { CronService } from "../cron/service.js";
import type { SubAgentRegistry } from "../agents/registry.js";
import type { SuperAgentConfig } from "../config/schema.js";

/**
 * 会话状态：消息列表 + 消息时间戳 + 压缩摘要。
 * 防御管线会整体替换 messages，集中在对象里管理，避免散落的模块级 let 重新赋值。
 */
export class ConversationState {
  messages: ModelMessage[] = [];
  timestamps = new Map<number, number>();
  summary = "";
}

/** 应用上下文：各子系统装配完成后的共享依赖集合，供命令系统 / 通道 / REPL 复用 */
export interface AppContext {
  config: SuperAgentConfig;
  model: LanguageModel;
  registry: ToolRegistry;
  builder: PromptBuilder;
  tracker: UsageTracker;
  sessionStore: SessionStore;
  memoryStore: MemoryStore;
  skillLoader: SkillLoader;
  activeSkills: Set<string>;
  gateway: ChannelGateway;
  pluginManager: PluginManager;
  builtinPlugins: PluginDefinition[];
  cronService: CronService | null;
  agentRegistry: SubAgentRegistry;
  state: ConversationState;
  makePromptCtx: () => PromptContext;
}
