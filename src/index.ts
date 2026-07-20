import "dotenv/config";
import { stepCountIs, streamText, type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createMockModel } from "./mock-model";
import { createInterface, emitKeypressEvents } from "node:readline";
import { allTools, calculatorTool, weatherTool } from "./tools/utility-tools";
import { agentLoop } from "./agent-loop";
import { ToolDefinition, ToolRegistry } from "./tool-registry";
import { MCPClient } from "./mcp-client";

const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
需要查询信息时，主动使用工具，不要编造数据。
回答要简洁直接。`;

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

function registerSimulatedTools() {
  const simulatedTools: ToolDefinition[] = [
    // === Notion ===
    {
      name: "mcp__notion__search_pages",
      description: "[MCP:notion] 搜索 Notion 页面",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "搜索关键词" } },
        required: ["query"],
      },
      shouldDefer: true,
      searchHint: "notion search pages documents",
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async ({ query }: any) =>
        JSON.stringify([{ title: `Mock: ${query}`, id: "page-001" }]),
    },
    {
      name: "mcp__notion__create_page",
      description: "[MCP:notion] 创建 Notion 页面",
      parameters: {
        type: "object",
        properties: {
          parent_id: { type: "string", description: "父页面/数据库 ID" },
          title: { type: "string", description: "页面标题" },
          content: { type: "string", description: "页面内容（Markdown）" },
        },
        required: ["parent_id", "title"],
      },
      shouldDefer: true,
      searchHint: "notion create page write new document",
      isConcurrencySafe: false,
      isReadOnly: false,
      execute: async ({ title }: any) =>
        JSON.stringify({
          id: "page-new-001",
          title,
          url: "https://notion.so/mock-page",
        }),
    },
    {
      name: "mcp__notion__list_databases",
      description: "[MCP:notion] 列出 Notion 数据库",
      parameters: {
        type: "object",
        properties: { filter: { type: "string", description: "过滤条件" } },
        required: [],
      },
      shouldDefer: true,
      searchHint: "notion list databases tables",
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async () =>
        JSON.stringify([
          {
            id: "db-001",
            title: "任务管理",
            properties: ["名称", "状态", "截止日期"],
          },
          {
            id: "db-002",
            title: "知识库",
            properties: ["标题", "标签", "更新时间"],
          },
        ]),
    },

    // === Browser ===
    {
      name: "mcp__browser__navigate",
      description: "[MCP:browser] 导航到指定 URL",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "目标网址" } },
        required: ["url"],
      },
      shouldDefer: true,
      searchHint: "browser navigate open url webpage",
      isConcurrencySafe: false,
      isReadOnly: false,
      execute: async ({ url }: any) =>
        JSON.stringify({ status: "loaded", url, title: `Mock Page - ${url}` }),
    },
    {
      name: "mcp__browser__screenshot",
      description: "[MCP:browser] 截取当前页面截图",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "可选，截取指定元素" },
        },
        required: [],
      },
      shouldDefer: true,
      searchHint: "browser screenshot capture image snapshot",
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async () =>
        JSON.stringify({
          path: "/tmp/screenshot.png",
          width: 1280,
          height: 720,
        }),
    },
    {
      name: "mcp__browser__click",
      description: "[MCP:browser] 点击页面元素",
      parameters: {
        type: "object",
        properties: { selector: { type: "string", description: "CSS 选择器" } },
        required: ["selector"],
      },
      shouldDefer: true,
      searchHint: "browser click button element interact",
      isConcurrencySafe: false,
      isReadOnly: false,
      execute: async ({ selector }: any) =>
        JSON.stringify({ clicked: selector, success: true }),
    },
    {
      name: "mcp__browser__fill",
      description: "[MCP:browser] 在输入框中填写内容",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS 选择器" },
          value: { type: "string", description: "要填入的值" },
        },
        required: ["selector", "value"],
      },
      shouldDefer: true,
      searchHint: "browser fill input type text form",
      isConcurrencySafe: false,
      isReadOnly: false,
      execute: async ({ selector, value }: any) =>
        JSON.stringify({ filled: selector, value, success: true }),
    },
    {
      name: "mcp__browser__get_text",
      description: "[MCP:browser] 获取页面或元素的文本内容",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS 选择器，默认 body" },
        },
        required: [],
      },
      shouldDefer: true,
      searchHint: "browser get text content extract read page",
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async ({ selector = "body" }: any) =>
        JSON.stringify({ selector, text: `Mock text content of ${selector}` }),
    },

    // === Supabase ===
    {
      name: "mcp__supabase__query",
      description: "[MCP:supabase] 执行 SQL 查询",
      parameters: {
        type: "object",
        properties: { sql: { type: "string", description: "SQL 语句" } },
        required: ["sql"],
      },
      shouldDefer: true,
      searchHint: "supabase query sql database select insert",
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async ({ sql }: any) =>
        JSON.stringify({
          rows: [{ id: 1, result: `Mock result for: ${sql}` }],
          count: 1,
        }),
    },
    {
      name: "mcp__supabase__list_tables",
      description: "[MCP:supabase] 列出数据库所有表",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      shouldDefer: true,
      searchHint: "supabase list tables schema database",
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async () =>
        JSON.stringify(["users", "posts", "comments", "tags"]),
    },
    {
      name: "mcp__supabase__describe_table",
      description: "[MCP:supabase] 查看表结构（字段、类型、约束）",
      parameters: {
        type: "object",
        properties: { table: { type: "string", description: "表名" } },
        required: ["table"],
      },
      shouldDefer: true,
      searchHint: "supabase describe table columns structure schema",
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async ({ table }: any) =>
        JSON.stringify({
          table,
          columns: [
            { name: "id", type: "uuid", primary: true },
            { name: "created_at", type: "timestamptz" },
            { name: "name", type: "text" },
          ],
        }),
    },
  ];

  registry.register(...simulatedTools);
  return simulatedTools.length;
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

const model = process.env.DASHSCOPE_API_KEY
  ? qwen.chat("qwen3.7-plus")
  : createMockModel();

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

const messages: ModelMessage[] = [];

function ask() {
  rl.question("\nYou: ", async (input) => {
    const trimmed = input.trim();
    if (!trimmed || trimmed === "exit") {
      exitRepl();
      return;
    }

    messages.push({ role: "user", content: trimmed });

    await agentLoop(model, registry, messages, SYSTEM, {
      used: 0,
      limit: 10000,
      inputTokens: 0,
      outputTokens: 0,
    });

    ask();
  });
}

console.log('Super Agent v0.1 (type "exit", Esc, or Ctrl+C to quit)\n');

async function main() {
  await connectMCP();
  const simCount = registerSimulatedTools();
  console.log(
    `  已注册 ${simCount} 个模拟 MCP 工具（Notion/Browser/Supabase）`,
  );

  const allCount = registry.getAll().length;
  const activeTools = registry.getActiveTools();
  const estimate = registry.countTokenEstimate();

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
    console.log(`  - ${tool.name}（${flags}）`);
  }

  ask();
}

main();
