import type { LanguageModel } from "ai";
import type { ToolRegistry } from "../tools/registry.js";
import type { UsageTracker } from "../usage/tracker.js";
import type { SuperAgentConfig } from "../config/schema.js";
import { SubAgentRegistry } from "../agents/registry.js";
import type { SpawnContext } from "../agents/spawn.js";
import { createSpawnTool } from "../tools/spawn-tools.js";

export interface SubAgentDeps {
  model: LanguageModel;
  registry: ToolRegistry;
  tracker: UsageTracker;
  buildSystem: () => string;
}

/**
 * 子 Agent 系统：spawn_agent 工具把任务派给独立上下文的子 Agent 执行（支持并行）。
 * 子 Agent 用量同步记入全局 tracker，避免计费黑盒。
 */
export function createSubAgentSystem(
  config: SuperAgentConfig,
  deps: SubAgentDeps,
): SubAgentRegistry {
  const agentRegistry = new SubAgentRegistry({
    maxSpawnDepth: config.agents.maxSpawnDepth,
    maxConcurrent: config.agents.maxConcurrent,
    defaultTimeout: config.agents.defaultTimeout,
  });

  const makeSpawnCtx = (): SpawnContext => ({
    model: deps.model,
    registry: deps.registry,
    agentRegistry,
    buildSystem: deps.buildSystem,
    currentDepth: 0, // 主 Agent 深度为 0；子 Agent 内排除了 spawn_agent，不会再嵌套
    tracker: deps.tracker,
  });

  deps.registry.register(createSpawnTool(agentRegistry, makeSpawnCtx));
  return agentRegistry;
}
