import { createInterface, emitKeypressEvents } from "node:readline";
import type { ModelMessage } from "ai";
import type { CommandHandler } from "../commands/index.js";
import { agentLoop } from "../agent/loop.js";
import type { AppContext } from "../bootstrap/types.js";
import { buildCommandContext } from "../bootstrap/commands.js";
import { runDefensePipeline } from "./defense.js";
import { createRunAgentTurn } from "./turn.js";

/** 启动交互式 REPL：命令分发 → 防御管线 → agentLoop → 持久化 */
export function startRepl(app: AppContext, dispatch: CommandHandler): void {
  const { state } = app;
  const runAgentTurn = createRunAgentTurn(app);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let exiting = false;

  async function exitRepl() {
    if (exiting) return;
    exiting = true;
    console.log("\nBye!");
    // Graceful Shutdown：停止所有通道
    try {
      await app.gateway.stopAll();
    } catch (err) {
      console.error(
        `[Gateway] 停止出错: ${err instanceof Error ? err.message : err}`,
      );
    }
    // Graceful Shutdown：卸载所有插件（触发各自的 destroy 释放资源）
    try {
      await app.pluginManager.unloadAll();
    } catch (err) {
      console.error(
        `[Plugin] 卸载出错: ${err instanceof Error ? err.message : err}`,
      );
    }
    // Graceful Shutdown：停止所有定时任务
    try {
      app.cronService?.stop();
    } catch (err) {
      console.error(
        `[Cron] 停止出错: ${err instanceof Error ? err.message : err}`,
      );
    }
    rl.close();
    process.exit(0);
  }

  if (process.stdin.isTTY) {
    emitKeypressEvents(process.stdin, rl);
  }

  rl.on("SIGINT", exitRepl);
  process.on("SIGINT", exitRepl);

  process.stdin.on("keypress", (_str, key) => {
    if (key?.name === "escape") {
      exitRepl();
    }
  });

  function ask() {
    rl.question("\nYou: ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === "exit") {
        exitRepl();
        return;
      }

      // /dream — 记忆自动整理（定位→检测→整理→报告）
      if (trimmed === "/dream" || trimmed === "dream") {
        console.log("\n[dream] 开始记忆整理...");
        const dreamPrompt = [
          "请对记忆库做一次完整的整理（dream），按以下阶段执行：",
          "",
          "**阶段 1：定位** — 用 memory lint 扫描全库（结果已包含内容预览和问题清单，不需要逐条 read）。",
          "**阶段 2：整理** — 根据 lint 报告直接操作：",
          "  - 路径过期且长期未用的，直接 memory delete（传 filename）删掉",
          "  - 同名重复的，用 memory save 保存合并后的版本（同名自动覆盖），再 delete 多余的",
          "  - 内容仍然有效但描述不准确的，用 memory save 覆盖更新",
          "**阶段 3：报告** — 用一段文字总结这次整理做了什么。",
          "",
          "注意：read 和 delete 都需要传 filename（如 project_deploy-process.md），不是 name。",
        ].join("\n");

        const userMsg: ModelMessage = { role: "user", content: dreamPrompt };
        state.messages.push(userMsg);
        state.timestamps.set(state.messages.length - 1, Date.now());
        app.sessionStore.append(userMsg);

        await runDefensePipeline(state, app.model);
        await agentLoop(
          app.model,
          app.registry,
          state.messages,
          app.builder.build(app.makePromptCtx()),
          { used: 0, limit: 10000, inputTokens: 0, outputTokens: 0 },
          app.tracker,
        );
        console.log("  [dream 完成]\n");
        ask();
        return;
      }

      // 构建命令上下文，交给 dispatcher 处理
      const cmdCtx = buildCommandContext(
        app,
        state.messages,
        state.timestamps,
        ask,
        runAgentTurn,
      );
      const handled = dispatch(trimmed, cmdCtx);
      if (handled) return; // 命令已处理（同步或异步）

      const prevLen = state.messages.length;
      state.messages.push({ role: "user", content: trimmed });
      state.timestamps.set(state.messages.length - 1, Date.now());

      // 每轮对话前执行统一防御管线（从轻到重）
      await runDefensePipeline(state, app.model);

      // 每轮重建 system prompt（记忆等动态内容可能变化）
      const system = app.builder.build(app.makePromptCtx());

      await agentLoop(
        app.model,
        app.registry,
        state.messages,
        system,
        {
          used: 0,
          limit: 10000,
          inputTokens: 0,
          outputTokens: 0,
        },
        app.tracker,
      ).catch((err) => {
        // 兜底保险：agentLoop 内部已降级处理模型错误，这里捕获其余未预期异常，保住 REPL 不退出
        console.log(`\n[Agent 异常] ${err instanceof Error ? err.message : err}`);
      });

      // 本轮新增的消息（user + assistant + tool-call/result）追加持久化
      app.sessionStore.appendAll(state.messages.slice(prevLen));

      ask();
    });
  }

  ask();
}
