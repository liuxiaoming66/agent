import type { LanguageModel, ModelMessage } from "ai";
import type { ToolRegistry } from "../tools/registry.js";
import type { PromptBuilder, PromptContext } from "../context/prompt-builder.js";
import type { UsageTracker } from "../usage/tracker.js";
import type { SuperAgentConfig } from "../config/schema.js";
import { CronService } from "../cron/service.js";
import { createCronTool } from "../tools/cron-tools.js";
import { agentLoop } from "../agent/loop.js";

export interface CronDeps {
  model: LanguageModel;
  registry: ToolRegistry;
  builder: PromptBuilder;
  tracker: UsageTracker;
  makePromptCtx: () => PromptContext;
}

/** 取消息列表中最后一条 assistant 消息的文本内容 */
function extractAssistantText(msgs: ModelMessage[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .filter(
          (p): p is { type: "text"; text: string } =>
            typeof p === "object" &&
            p !== null &&
            "type" in p &&
            p.type === "text",
        )
        .map((p) => p.text)
        .join("");
    }
  }
  return "(无输出)";
}

/**
 * 创建 Cron 服务并注入 Agent 执行器：任务触发时在独立上下文里跑一个 agentLoop。
 * config.cron.enabled = false 时返回 null，完全不初始化。
 */
export function createCronService(
  config: SuperAgentConfig,
  deps: CronDeps,
): CronService | null {
  if (!config.cron.enabled) return null;

  const cronService = new CronService(config.cron.dataDir);
  cronService.setExecutor({
    runAgentPrompt: async (prompt, timeout = 60000) => {
      const cronMessages: ModelMessage[] = [{ role: "user", content: prompt }];
      const system = deps.builder.build(deps.makePromptCtx());
      const run = agentLoop(
        deps.model,
        deps.registry,
        cronMessages,
        system,
        { used: 0, limit: 10000, inputTokens: 0, outputTokens: 0 },
        deps.tracker,
      );
      await Promise.race([
        run,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeout),
        ),
      ]);
      return extractAssistantText(cronMessages);
    },
    notify: (message) => console.log(message),
  });
  deps.registry.register(createCronTool(cronService));
  return cronService;
}
