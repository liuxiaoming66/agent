import { agentLoop } from "../agent/loop.js";
import type { AppContext } from "../bootstrap/types.js";
import { runDefensePipeline } from "./defense.js";

/**
 * 创建 runAgentTurn：注入一条 user message 并跑完整一轮 Agent（供 skill 快捷方式等复用）。
 * 与普通对话同一套流程：防御管线 → 重建 SYSTEM → agentLoop → 持久化。
 */
export function createRunAgentTurn(
  app: AppContext,
): (userContent: string) => Promise<void> {
  return async (userContent: string) => {
    const { state } = app;
    const prevLen = state.messages.length;
    state.messages.push({ role: "user", content: userContent });
    state.timestamps.set(state.messages.length - 1, Date.now());

    await runDefensePipeline(state, app.model);
    await agentLoop(
      app.model,
      app.registry,
      state.messages,
      app.builder.build(app.makePromptCtx()),
      { used: 0, limit: 10000, inputTokens: 0, outputTokens: 0 },
      app.tracker,
    );
    app.sessionStore.appendAll(state.messages.slice(prevLen));
  };
}
