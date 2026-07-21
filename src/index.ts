import "dotenv/config";
import { type ModelMessage, type LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createMockModel } from "./mock-model";
import { createInterface, emitKeypressEvents } from "node:readline";
import { allTools, ToolRegistry, MCPClient } from "./tools/index.js";
import type { ToolDefinition } from "./tools/index.js";
import { agentLoop } from "./agent/loop.js";
import { SessionStore } from "./session/store";
import {
  coreRules,
  deferredTools,
  PromptBuilder,
  sessionContext,
  toolGuide,
  type PromptContext,
} from "./context/prompt-builder";
import {
  microcompact,
  summarize,
  estimateTokens,
  CONTEXT_TOKEN_THRESHOLD,
} from "./context/compressor";
import { applyDefense } from "./context/defense";

const builder = new PromptBuilder()
  .pipe("coreRules", coreRules())
  .pipe("toolGuide", toolGuide())
  .pipe("deferredTools", deferredTools())
  .pipe("sessionContext", sessionContext());

let SYSTEM = "";

const qwen = createOpenAI({
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey: process.env.DASHSCOPE_API_KEY,
});

const registry = new ToolRegistry();
registry.register(...allTools);
async function connectMCP() {
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

  let canSpawn = true;
  try {
    const { execSync } = await import("node:child_process");
    execSync("echo test", { stdio: "ignore" });
  } catch {
    canSpawn = false;
  }

  if (githubToken && canSpawn) {
    console.log("\n连接 GitHub MCP Server...");
    try {
      const client = new MCPClient(
        "npx",
        ["-y", "@modelcontextprotocol/server-github"],
        { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
      );
      const tools = await registry.registerMCPServer("github", client);
      console.log(`  已注册 ${tools.length} 个 MCP 工具`);
      return;
    } catch (err) {
      console.log(
        `  MCP 连接失败: ${err instanceof Error ? err.message : err}`,
      );
      console.log("  降级为 Mock MCP...");
    }
  }

  if (!githubToken) {
    console.log("\n未配置 GITHUB_PERSONAL_ACCESS_TOKEN，使用 Mock MCP");
  }
}

const toolSearchTool: ToolDefinition = {
  name: "tool_search",
  description:
    "获取延迟工具的完整定义。传入工具名（从系统提示的延迟工具列表中选取），返回该工具的完整参数 Schema",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          '工具名，如 "mcp__github__list_issues"。支持逗号分隔多个工具名',
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ query }: { query: string }) => {
    const results = registry.searchTools(query);
    if (results.length === 0) return `没有找到匹配 "${query}" 的工具`;
    return results.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  },
};

registry.register(toolSearchTool);

const model = (
  process.env.DASHSCOPE_API_KEY ? qwen.chat("qwen3.7-plus") : createMockModel()
) as LanguageModel;

const isContinue = process.argv.includes("--continue");
const store = new SessionStore("default");

let messages: ModelMessage[] = [];
let summary = "";
let timestamps = new Map<number, number>(); // 消息索引 → 创建时间戳

if (isContinue && store.exists()) {
  const restored = store.loadWithTimestamps();
  messages = restored.messages;
  timestamps = restored.timestamps;
  console.log(`[Session] 恢复会话，${messages.length} 条历史消息`);
} else {
  console.log(`[Session] 新会话`);
}

/**
 * 统一上下文防御管线，从轻到重按顺序执行：
 * Layer 2: 截断超长工具结果 + 总量预算清理
 * Layer 3: TTL 软修剪 / 硬清除
 * Token 估算: 判断是否需要 LLM 压缩
 * Layer 4: Microcompact — 清理早期工具结果
 * Layer 5: Summarization — 超阈值时 LLM 摘要压缩
 */
async function runDefensePipeline() {
  // Layer 2 + 3: 截断 + TTL 修剪 + token 估算
  const defense = applyDefense(messages, timestamps);
  messages = defense.messages;

  // 诊断日志：始终输出，方便观察防御状态
  const toolMsgCount = messages.filter((m) => m.role === "tool").length;
  console.log(
    `[Defense] 消息=${messages.length} 工具结果=${toolMsgCount} ` +
      `截断=${defense.truncated} 压缩=${defense.compacted} ` +
      `软修剪=${defense.softPruned} 硬清除=${defense.hardPruned} ` +
      `~${defense.tokenEstimate} tokens`,
  );

  // Token 估算：判断是否需要更重的压缩
  let currentTokens = defense.tokenEstimate;
  console.log(`[Token] ~${currentTokens} tokens`);
  if (currentTokens <= CONTEXT_TOKEN_THRESHOLD) return; // 轻量手段已足够

  // Layer 4: Microcompact — 清理早期工具结果
  const mc = microcompact(messages);
  messages = mc.messages;
  if (mc.cleared > 0) {
    console.log(`[Layer 4: Microcompact] 清理了 ${mc.cleared} 个工具结果`);
  }

  // 重新估算，看是否还需要最重的手段
  currentTokens = estimateTokens(messages);
  if (currentTokens <= CONTEXT_TOKEN_THRESHOLD) return;

  // Layer 5: Summarization — LLM 摘要压缩
  console.log(
    `[Layer 5: Summarization] ~${currentTokens} tokens 仍超阈值，压缩中...`,
  );
  const compResult = await summarize(model, messages, summary);
  messages = compResult.messages;
  summary = compResult.summary;
  if (compResult.compressedCount > 0) {
    console.log(
      `[Layer 5: Summarization] 压缩了 ${compResult.compressedCount} 条消息`,
    );
  }
}

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

let exiting = false;

function exitRepl() {
  if (exiting) return;
  exiting = true;
  console.log("\nBye!");
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

    const prevLen = messages.length;
    messages.push({ role: "user", content: trimmed });
    timestamps.set(messages.length - 1, Date.now());

    // 每轮对话前执行统一防御管线（从轻到重）
    await runDefensePipeline();

    await agentLoop(model, registry, messages, SYSTEM, {
      used: 0,
      limit: 10000,
      inputTokens: 0,
      outputTokens: 0,
    });

    // 本轮新增的消息（user + assistant + tool-call/result）追加持久化
    store.appendAll(messages.slice(prevLen));

    ask();
  });
}

console.log('Super Agent v0.1 (type "exit", Esc, or Ctrl+C to quit)\n');

async function main() {
  await connectMCP();
  const allCount = registry.getAll().length;
  const activeTools = registry.getActiveTools();
  const estimate = registry.countTokenEstimate();

  const promptCtx: PromptContext = {
    toolCount: registry.getActiveTools().length,
    deferredToolSummary: registry.getDeferredToolSummary(),
    sessionMessageCount: messages.length,
    sessionId: "default",
  };
  SYSTEM = builder.build(promptCtx);
  builder.debug(promptCtx); // 显示各模块状态

  console.log(`\n=== 工具统计 ===`);
  console.log(`  全部工具: ${allCount} 个`);
  console.log(`  活跃工具: ${activeTools.length} 个`);
  console.log(`  延迟工具: ${allCount - activeTools.length} 个`);
  console.log(
    `  Token 估算: ~${estimate.active} (活跃) + ~${estimate.deferred} (延迟，不占 prompt)`,
  );
  for (const tool of registry.getAll()) {
    const flags = [
      tool.isConcurrencySafe ? "可并发" : "串行",
      tool.isReadOnly ? "只读" : "读写",
    ].join(", ");
  }
  // 启动时防御：处理恢复的历史消息
  if (messages.length > 0) {
    await runDefensePipeline();
  }

  ask();
}

main();
