import type { ToolDefinition } from "./registry.js";
import type { SubAgentRegistry } from "../agents/registry.js";
import { spawnAgent, spawnParallel, type SpawnContext } from "../agents/spawn.js";

export function createSpawnTool(
  agentRegistry: SubAgentRegistry,
  getSpawnCtx: () => SpawnContext,
): ToolDefinition {
  return {
    name: "spawn_agent",
    description:
      "派一个子 Agent 去执行任务。子 Agent 有独立的上下文，完成后返回结果摘要。支持同时派多个子 Agent 并行执行。" +
      "注意：每个任务应聚焦单一模块或单个问题（如分析 2-3 个文件），避免“读取整个目录下所有文件”这种大而全的任务；" +
      "并发上限 3 个，一次派超过 3 个任务会被拒绝，多余的任务请分批派发。",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "单个任务描述（与 tasks 二选一）",
        },
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "多个任务描述，并行执行（与 task 二选一，最多 3 个）",
        },
        timeout: {
          type: "number",
          description: "单个子 Agent 执行超时 ms，默认 180000",
        },
      },
    },
    isConcurrencySafe: false,
    isReadOnly: true,
    execute: async (input: { task?: string; tasks?: string[]; timeout?: number }) => {
      const ctx = getSpawnCtx();

      if (input.tasks && input.tasks.length > 0) {
        const requests = input.tasks.map((t) => ({ task: t, timeout: input.timeout }));
        const results = await spawnParallel(requests, ctx);
        return results
          .map((r, i) => `## 子 Agent ${i + 1}: ${r.task.slice(0, 40)}\n\n${r.result}`)
          .join("\n\n---\n\n");
      }

      if (input.task) {
        return spawnAgent({ task: input.task, timeout: input.timeout }, ctx);
      }

      return "需要提供 task 或 tasks 参数";
    },
  };
}
