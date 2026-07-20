import "dotenv/config";
import { stepCountIs, streamText, type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createMockModel } from "./mock-model";
import { createInterface, emitKeypressEvents } from "node:readline";
import { allTools, calculatorTool, weatherTool } from "./tools/utility-tools";
import { agentLoop } from "./agent-loop";
import { ToolRegistry } from "./tool-registry";
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

console.log(`已注册 ${registry.getAll().length} 个工具：`);
for (const tool of registry.getAll()) {
  const flags = [
    tool.isConcurrencySafe ? "可并发" : "串行",
    tool.isReadOnly ? "只读" : "读写",
  ].join(", ");
  console.log(`  - ${tool.name}（${flags}）`);
}

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
  ask();
}

main();
