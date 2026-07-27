import type { CommandHandler } from "./index.js";
import type { CronService } from "../cron/service.js";

/**
 * /cron              — 列出所有定时任务
 * /cron logs [id]    — 查看最近执行记录（可按任务 ID 过滤）
 */
export function createCronCommands(cronService: CronService): CommandHandler[] {
  const cronCommand: CommandHandler = (cmd, ctx) => {
    if (cmd !== "/cron" && !cmd.startsWith("/cron ")) return false;

    const subCmd = cmd.slice("/cron".length).trim();

    // /cron logs [id]
    if (subCmd === "logs" || subCmd.startsWith("logs ")) {
      const jobId = subCmd.slice("logs".length).trim() || undefined;
      const logs = cronService.getRecentLogs(jobId, 10);
      if (logs.length === 0) {
        console.log(jobId ? `[Cron] 任务 ${jobId} 暂无执行记录` : "[Cron] 暂无执行记录");
      } else {
        console.log(`\n=== 执行记录（最近 ${logs.length} 条${jobId ? `，任务: ${jobId}` : ""}） ===`);
        for (const l of logs) {
          const icon = l.status === "success" ? "✓" : "✗";
          console.log(`  ${icon} [${l.status}] ${l.jobId} @ ${l.startedAt}`);
          const detail = l.error || l.output;
          if (detail) console.log(`    ${detail.slice(0, 120)}`);
        }
      }
      ctx.ask();
      return "async";
    }

    // /cron — 默认列出所有任务
    const jobs = cronService.list();
    if (jobs.length === 0) {
      console.log("[Cron] 当前没有定时任务");
    } else {
      console.log(`\n=== 定时任务（共 ${jobs.length} 个） ===`);
      for (const j of jobs) {
        console.log(`  [${j.status}] ${j.config.id} — ${j.config.name}`);
        console.log(`    调度: ${j.config.schedule} (${j.config.scheduleType}) | 来源: ${j.config.source}`);
        if (j.lastRun) {
          const icon = j.lastRun.status === "success" ? "✓" : "✗";
          console.log(`    上次: ${icon} ${j.lastRun.status} @ ${j.lastRun.finishedAt}`);
        }
      }
      console.log(`\n提示: /cron logs 查看执行记录 | /cron logs <任务ID> 按任务过滤`);
    }
    ctx.ask();
    return "async";
  };

  return [cronCommand];
}
