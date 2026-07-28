import type { AppContext } from "./types.js";

/** 启动摘要：Prompt 管线各模块状态 + 工具统计 + Skills 清单 */
export function printStartupSummary(
  app: AppContext,
  skillNames: string[],
): void {
  const { registry, builder, makePromptCtx } = app;
  const allCount = registry.getAll().length;
  const activeTools = registry.getActiveTools();
  const estimate = registry.countTokenEstimate();

  builder.debug(makePromptCtx()); // 显示各模块状态

  console.log(`\n=== 工具统计 ===`);
  console.log(`  全部工具: ${allCount} 个`);
  console.log(`  活跃工具: ${activeTools.length} 个`);
  console.log(`  延迟工具: ${allCount - activeTools.length} 个`);
  console.log(
    `  Token 估算: ~${estimate.active} (活跃) + ~${estimate.deferred} (延迟，不占 prompt)`,
  );
  if (skillNames.length > 0) {
    console.log(
      `\n=== Skills ===\n  发现 ${skillNames.length} 个: ${skillNames
        .map((n) => `/${n}`)
        .join(", ")}\n  用 /skill 管理，或直接 /<name> 激活并执行`,
    );
  }
}

/** 启动已注册的通道（钉钉等），无通道时静默跳过 */
export async function startChannels(app: AppContext): Promise<void> {
  const channelList = app.gateway.list();
  if (channelList.length > 0) {
    console.log(`\n=== Channels ===`);
    await app.gateway.startAll();
  }
}

/** 加载并启动 Cron 定时任务（服务未启用时跳过） */
export function startCron(app: AppContext): void {
  const cronService = app.cronService;
  if (!cronService) return;

  cronService.load();
  cronService.start();
  const cronJobs = cronService.list();
  if (cronJobs.length > 0) {
    console.log(`\n=== Cron ===`);
    console.log(`  已加载 ${cronJobs.length} 个定时任务`);
    for (const job of cronJobs) {
      console.log(`  [${job.status}] ${job.config.id} — ${job.config.name}`);
    }
  }
}
