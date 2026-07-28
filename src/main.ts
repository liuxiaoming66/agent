import "dotenv/config";
import { type LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createMockModel } from "./mock-model.js";
import { allTools, ToolRegistry } from "./tools/index.js";
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
import { UsageTracker } from "./usage/tracker.js";
import { SessionStore } from "./session/store.js";
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
} from "./context/prompt-builder.js";
import { SkillLoader } from "./skills/loader.js";
import { createSkillTool } from "./tools/skill-tools.js";
import { PluginManager } from "./plugins/manager.js";
import { supabasePlugin } from "./plugins/supabase-plugin.js";
import { ChannelGateway, DingTalkChannel } from "./channels/index.js";
import { loadConfig } from "./config/loader.js";
import { ConversationState, type AppContext } from "./bootstrap/types.js";
import { connectMCP } from "./bootstrap/mcp.js";
import { setupHookPipeline } from "./bootstrap/security.js";
import { createCronService } from "./bootstrap/cron.js";
import { createSubAgentSystem } from "./bootstrap/agents.js";
import { loadConfiguredPlugins } from "./bootstrap/plugins.js";
import { createCommandDispatcher } from "./bootstrap/commands.js";
import {
  printStartupSummary,
  startChannels,
  startCron,
} from "./bootstrap/startup.js";
import { runDefensePipeline } from "./runtime/defense.js";
import { startRepl } from "./runtime/repl.js";

// 全局配置：super-agent.config.json → 环境变量替换 → Zod 校验（缺失时用默认值）
const config = loadConfig();

// 模型 API Key：配置文件优先，环境变量兜底
const resolvedApiKey =
  config.model.apiKey || process.env.DASHSCOPE_API_KEY || "";

const llm = createOpenAI({
  baseURL: config.model.baseURL,
  apiKey: resolvedApiKey,
});

const model = (
  resolvedApiKey ? llm.chat(config.model.name) : createMockModel()
) as LanguageModel;

// 工具注册表：内置工具 + 延迟工具搜索入口
const registry = new ToolRegistry();
registry.register(...allTools);
registry.register(createToolSearchTool(registry));

// 安全管线：HookPipeline + 默认 Hook + 注入 registry
const hookPipeline = setupHookPipeline(config, registry);

// 记忆存储（跨会话持久化）
const memoryStore = new MemoryStore(config.memory.dataDir);
memoryStore.init();
registry.register(createMemoryTool(memoryStore));

// RAG 知识库（SQLite 持久化）：config.rag.enabled 关闭时完全不初始化
let vectorStore: SqliteVectorStore | null = null;
if (config.rag.enabled) {
  vectorStore = new SqliteVectorStore();
  const embedFn: EmbeddingFn = resolvedApiKey
    ? createDashScopeEmbedder(resolvedApiKey)
    : createMockEmbedder();
  registry.register(...createRagTools(vectorStore, embedFn));
}

// Skills（.skills/<name>/SKILL.md）：动态注入 SOP 到 system prompt
const skillLoader = new SkillLoader(".");
const loadedSkills = skillLoader.load();
const activeSkills = new Set<string>();
registry.register(createSkillTool(skillLoader, activeSkills));

// System Prompt 构建管线：核心规则 → 工具指引 → 会话/记忆/RAG/Skill 上下文
const builder = new PromptBuilder()
  .pipe("coreRules", coreRules())
  .pipe("toolGuide", toolGuide())
  .pipe("deferredTools", deferredTools())
  .pipe("sessionContext", sessionContext())
  .pipe(
    "memoryContext",
    memoryContext(() => memoryStore.buildPromptSection()),
  );

// RAG 上下文仅在启用时接入 prompt 管线
if (config.rag.enabled) {
  builder.pipe(
    "ragContext",
    ragContext(() => vectorStore!),
  );
}
builder.pipe(
  "skillContext",
  skillContext(() => skillLoader.buildPromptSection(activeSkills)),
);

// 会话状态与持久化
const state = new ConversationState();
const sessionStore = new SessionStore(config.session.id);
const tracker = new UsageTracker();

const isContinue = process.argv.includes("--continue");
if (isContinue && sessionStore.exists()) {
  const restored = sessionStore.loadWithTimestamps();
  state.messages = restored.messages;
  state.timestamps = restored.timestamps;
  console.log(`[Session] 恢复会话，${state.messages.length} 条历史消息`);
} else {
  console.log(`[Session] 新会话`);
}

/** 每轮对话可重建的 PromptContext 工厂 */
function makePromptCtx(): PromptContext {
  return {
    toolCount: registry.getActiveTools().length,
    deferredToolSummary: registry.getDeferredToolSummary(),
    sessionMessageCount: state.messages.length,
    sessionId: config.session.id,
  };
}

// Channels 通道网关：接收外部消息 → Agent 处理 → 回复
const gateway = new ChannelGateway({
  model,
  registry,
  buildSystem: () => builder.build(makePromptCtx()),
  tracker,
});
// 通道条件启用：enabled=false 时不创建实例、不启动 HTTP 服务、不占端口
if (config.channels.dingtalk.enabled) {
  gateway.register(
    new DingTalkChannel({
      clientId: config.channels.dingtalk.clientId,
      clientSecret: config.channels.dingtalk.clientSecret,
      port: config.channels.dingtalk.port,
      cardTemplateId: config.channels.dingtalk.cardTemplateId,
    }),
  );
}

// 插件系统：核心只管推理循环与工具调度，具体能力通过 Plugin 动态加载
const pluginManager = new PluginManager(registry, gateway);
const builtinPlugins = [supabasePlugin];
// 插件目录：name → 定义，供 config.plugins 按名查找
const pluginCatalog = new Map(builtinPlugins.map((p) => [p.name, p]));

// Cron 定时任务 + 子 Agent 系统（内部完成各自的工具注册）
const cronService = createCronService(config, {
  model,
  registry,
  builder,
  tracker,
  makePromptCtx,
});
const agentRegistry = createSubAgentSystem(config, {
  model,
  registry,
  tracker,
  buildSystem: () => builder.build(makePromptCtx()),
});

// 装配应用上下文，供命令系统 / 通道 / REPL 共享
const app: AppContext = {
  config,
  model,
  registry,
  builder,
  tracker,
  sessionStore,
  memoryStore,
  skillLoader,
  activeSkills,
  gateway,
  pluginManager,
  builtinPlugins,
  cronService,
  agentRegistry,
  state,
  makePromptCtx,
};

const dispatch = createCommandDispatcher(app, hookPipeline);

console.log('Super Agent v0.1 (type "exit", Esc, or Ctrl+C to quit)\n');

export async function startAgent() {
  await connectMCP(registry);

  // 加载插件（在工具统计之前，以便计数包含插件注册的工具）
  await loadConfiguredPlugins(config, pluginManager, pluginCatalog);

  printStartupSummary(
    app,
    loadedSkills.map((s) => s.name),
  );

  // 启动时防御：处理恢复的历史消息
  if (state.messages.length > 0) {
    await runDefensePipeline(state, model);
  }

  await startChannels(app);
  startCron(app);

  startRepl(app, dispatch);
}
