import "dotenv/config";
import { type ModelMessage, type LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createMockModel } from "./mock-model";
import { createInterface, emitKeypressEvents } from "node:readline";
import { allTools, ToolRegistry, MCPClient } from "./tools/index.js";
import { createToolSearchTool } from "./tools/tool-search.js";
import { createMemoryTool } from "./tools/memory-tools.js";
import { MemoryStore } from "./memory/store.js";
import { SqliteVectorStore } from "./rag/sqlite-store.js";
import {
  createMockEmbedder,
  createDashScopeEmbedder,
  type EmbeddingFn,
} from "./rag/embedding.js";
import { createRagTools } from "./tools/rag-tools.js";
import { agentLoop } from "./agent/loop.js";
import { UsageTracker } from "./usage/tracker.js";
import { SessionStore } from "./session/store";
import {
  coreRules,
  deferredTools,
  memoryContext,
  PromptBuilder,
  ragContext,
  sessionContext,
  skillContext,
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
import { createDispatcher, type CommandContext } from "./commands/index.js";
import { debugCommands } from "./commands/debug.js";
import { contextCommands } from "./commands/context.js";
import { memoryCommands } from "./commands/memory.js";
import { skillCommands } from "./commands/skill.js";
import { SkillLoader } from "./skills/loader.js";
import { createSkillTool } from "./tools/skill-tools.js";

const builder = new PromptBuilder()
  .pipe("coreRules", coreRules())
  .pipe("toolGuide", toolGuide())
  .pipe("deferredTools", deferredTools())
  .pipe("sessionContext", sessionContext())
  .pipe(
    "memoryContext",
    memoryContext(() => memoryStore.buildPromptSection()),
  )
  .pipe(
    "ragContext",
    ragContext(() => vectorStore),
  )
  .pipe(
    "skillContext",
    skillContext(() => skillLoader.buildPromptSection(activeSkills)),
  );

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

registry.register(createToolSearchTool(registry));

const memoryStore = new MemoryStore();
memoryStore.init();
registry.register(createMemoryTool(memoryStore));

// RAG 知识库（SQLite 持久化）
const vectorStore = new SqliteVectorStore();
const embedFn: EmbeddingFn = process.env.DASHSCOPE_API_KEY
  ? createDashScopeEmbedder(process.env.DASHSCOPE_API_KEY)
  : createMockEmbedder();
registry.register(...createRagTools(vectorStore, embedFn));

// Skills（.skills/<name>/SKILL.md）：动态注入 SOP 到 system prompt
const skillLoader = new SkillLoader(".");
const loadedSkills = skillLoader.load();
const activeSkills = new Set<string>();
registry.register(createSkillTool(skillLoader, activeSkills));

const model = (
  process.env.DASHSCOPE_API_KEY ? qwen.chat("qwen3.7-max") : createMockModel()
) as LanguageModel;

const isContinue = process.argv.includes("--continue");
const store = new SessionStore("default");
const tracker = new UsageTracker();

/** 每轮对话可重建的 PromptContext 工厂 */
function makePromptCtx(): PromptContext {
  return {
    toolCount: registry.getActiveTools().length,
    deferredToolSummary: registry.getDeferredToolSummary(),
    sessionMessageCount: messages.length,
    sessionId: "default",
  };
}

// 命令 dispatcher：责任链模式，第一个匹配的 handler 接管
const dispatch = createDispatcher([
  ...debugCommands,
  ...contextCommands,
  ...memoryCommands,
  ...skillCommands,
]);

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

/**
 * 注入一条 user message 并跑完整一轮 Agent（供 skill 快捷方式等复用）。
 * 与普通对话同一套流程：防御管线 → 重建 SYSTEM → agentLoop → 持久化。
 */
async function runAgentTurn(userContent: string) {
  const prevLen = messages.length;
  messages.push({ role: "user", content: userContent });
  timestamps.set(messages.length - 1, Date.now());

  await runDefensePipeline();
  SYSTEM = builder.build(makePromptCtx());
  await agentLoop(
    model,
    registry,
    messages,
    SYSTEM,
    { used: 0, limit: 10000, inputTokens: 0, outputTokens: 0 },
    tracker,
  );
  store.appendAll(messages.slice(prevLen));
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
      messages.push(userMsg);
      timestamps.set(messages.length - 1, Date.now());
      store.append(userMsg);

      await runDefensePipeline();
      SYSTEM = builder.build(makePromptCtx());
      await agentLoop(
        model,
        registry,
        messages,
        SYSTEM,
        { used: 0, limit: 10000, inputTokens: 0, outputTokens: 0 },
        tracker,
      );
      console.log("  [dream 完成]\n");
      ask();
      return;
    }

    // 构建命令上下文，交给 dispatcher 处理
    const cmdCtx: CommandContext = {
      messages,
      timestamps,
      registry,
      builder,
      tracker,
      sessionStore: store,
      model,
      makePromptCtx,
      ask,
      memoryStore,
      skillLoader,
      activeSkills,
      runAgentTurn,
    };
    const handled = dispatch(trimmed, cmdCtx);
    if (handled) return; // 命令已处理（同步或异步）

    const prevLen = messages.length;
    messages.push({ role: "user", content: trimmed });
    timestamps.set(messages.length - 1, Date.now());

    // 每轮对话前执行统一防御管线（从轻到重）
    await runDefensePipeline();

    // 每轮重建 system prompt（记忆等动态内容可能变化）
    SYSTEM = builder.build(makePromptCtx());

    await agentLoop(
      model,
      registry,
      messages,
      SYSTEM,
      {
        used: 0,
        limit: 10000,
        inputTokens: 0,
        outputTokens: 0,
      },
      tracker,
    );

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

  SYSTEM = builder.build(makePromptCtx());
  builder.debug(makePromptCtx()); // 显示各模块状态

  console.log(`\n=== 工具统计 ===`);
  console.log(`  全部工具: ${allCount} 个`);
  console.log(`  活跃工具: ${activeTools.length} 个`);
  console.log(`  延迟工具: ${allCount - activeTools.length} 个`);
  console.log(
    `  Token 估算: ~${estimate.active} (活跃) + ~${estimate.deferred} (延迟，不占 prompt)`,
  );
  if (loadedSkills.length > 0) {
    console.log(
      `\n=== Skills ===\n  发现 ${loadedSkills.length} 个: ${loadedSkills
        .map((s) => `/${s.name}`)
        .join(", ")}\n  用 /skill 管理，或直接 /<name> 激活并执行`,
    );
  }
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
