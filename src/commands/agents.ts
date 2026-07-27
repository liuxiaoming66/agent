import type { CommandHandler } from "./index.js";
import type { SubAgentRegistry } from "../agents/registry.js";

const STATUS_ICONS: Record<string, string> = {
  running: "⏳",
  completed: "✓",
  error: "✗",
  timeout: "⏱",
};

/**
 * /agents            — 列出所有子 Agent 运行记录
 * /agents active     — 只看正在运行的
 * /agents <id>       — 查看某次运行的完整结果
 */
export function createAgentsCommands(
  agentRegistry: SubAgentRegistry,
): CommandHandler[] {
  const agentsCommand: CommandHandler = (cmd, ctx) => {
    if (cmd !== "/agents" && !cmd.startsWith("/agents ")) return false;

    const subCmd = cmd.slice("/agents".length).trim();

    // /agents <id> — 查看单次运行详情
    if (subCmd && subCmd !== "active") {
      const run = agentRegistry.get(subCmd);
      if (!run) {
        console.log(`[Agents] 未找到运行记录: ${subCmd}`);
      } else {
        console.log(`\n=== ${run.id} [${run.status}] ===`);
        console.log(`任务: ${run.task}`);
        console.log(`深度: ${run.depth} | 开始: ${run.startedAt}${run.finishedAt ? ` | 结束: ${run.finishedAt}` : ""}`);
        if (run.inputTokens !== undefined || run.outputTokens !== undefined) {
          console.log(`用量: ${run.inputTokens ?? 0} 入 + ${run.outputTokens ?? 0} 出 tokens`);
        }
        if (run.error) console.log(`错误: ${run.error}`);
        if (run.result) {
          console.log(`---`);
          console.log(run.result);
        }
      }
      ctx.ask();
      return "async";
    }

    // /agents [active] — 列表
    const runs = subCmd === "active" ? agentRegistry.getActiveRuns() : agentRegistry.getAllRuns();
    if (runs.length === 0) {
      console.log(subCmd === "active" ? "[Agents] 当前没有运行中的子 Agent" : "[Agents] 暂无子 Agent 运行记录");
    } else {
      const config = agentRegistry.getConfig();
      const activeCount = agentRegistry.getActiveRuns().length;
      console.log(`\n=== 子 Agent 运行记录（共 ${runs.length} 条，运行中 ${activeCount}/${config.maxConcurrent}） ===`);
      for (const r of runs) {
        const icon = STATUS_ICONS[r.status] || "?";
        const duration = r.finishedAt
          ? `${((new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000).toFixed(1)}s`
          : "运行中";
        console.log(`  ${icon} [${r.status}] ${r.id} — ${r.task.slice(0, 50)}`);
        const tokens =
          r.inputTokens !== undefined || r.outputTokens !== undefined
            ? ` | tokens: ${r.inputTokens ?? 0}+${r.outputTokens ?? 0}`
            : "";
        console.log(`    深度: ${r.depth} | 耗时: ${duration}${tokens}${r.error ? ` | 错误: ${r.error}` : ""}`);
        if (r.result) console.log(`    结果: ${r.result.slice(0, 80).replace(/\n/g, " ")}...`);
      }
      console.log(`\n提示: /agents <ID> 查看完整结果 | /agents active 只看运行中`);
    }
    ctx.ask();
    return "async";
  };

  return [agentsCommand];
}
