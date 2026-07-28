import type { ModelMessage } from "ai";
import {
  createDispatcher,
  type CommandContext,
  type CommandHandler,
} from "../commands/index.js";
import { debugCommands } from "../commands/debug.js";
import { contextCommands } from "../commands/context.js";
import { memoryCommands } from "../commands/memory.js";
import { skillCommands } from "../commands/skill.js";
import { pluginCommands } from "../commands/plugin.js";
import { createChannelCommands } from "../commands/channel.js";
import { createSecurityCommands } from "../commands/security.js";
import { createCronCommands } from "../commands/cron.js";
import { createAgentsCommands } from "../commands/agents.js";
import type { HookPipeline } from "../security/hooks.js";
import type { AppContext } from "./types.js";

/** 构建命令上下文：REPL 与通道共用的装配逻辑 */
export function buildCommandContext(
  app: AppContext,
  messages: ModelMessage[],
  timestamps: Map<number, number>,
  ask: () => void,
  runAgentTurn?: (userContent: string) => Promise<void>,
): CommandContext {
  return {
    messages,
    timestamps,
    registry: app.registry,
    builder: app.builder,
    tracker: app.tracker,
    sessionStore: app.sessionStore,
    model: app.model,
    makePromptCtx: app.makePromptCtx,
    ask,
    memoryStore: app.memoryStore,
    skillLoader: app.skillLoader,
    activeSkills: app.activeSkills,
    pluginManager: app.pluginManager,
    availablePlugins: app.builtinPlugins,
    runAgentTurn,
  };
}

/**
 * 命令 dispatcher：责任链模式，第一个匹配的 handler 接管。
 * 同时注入 gateway，使钉钉/飞书等通道也能拦截 / 命令。
 */
export function createCommandDispatcher(
  app: AppContext,
  hookPipeline: HookPipeline,
): CommandHandler {
  const dispatch = createDispatcher([
    ...debugCommands,
    ...contextCommands,
    ...memoryCommands,
    ...pluginCommands,
    ...skillCommands,
    ...createChannelCommands(app.gateway),
    ...createSecurityCommands(app.registry, hookPipeline),
    ...(app.cronService ? createCronCommands(app.cronService) : []),
    ...createAgentsCommands(app.agentRegistry),
  ]);

  app.gateway.setCommandDispatcher(dispatch, (sessionMessages) =>
    buildCommandContext(app, sessionMessages, new Map(), () => {}),
  );

  return dispatch;
}
