import "dotenv/config";
import { stepCountIs, streamText, type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createMockModel } from "./mock-model";
import { createInterface, emitKeypressEvents } from "node:readline";
import { calculatorTool, weatherTool } from "./tools/utility-tools";
import { agentLoop } from "./agent-loop";

const tools = { get_weather: weatherTool, calculator: calculatorTool };

const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
需要查询信息时，主动使用工具，不要编造数据。
回答要简洁直接。`;

const qwen = createOpenAI({
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey: process.env.DASHSCOPE_API_KEY,
});

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

    await agentLoop(model, tools, messages, SYSTEM);

    ask();
  });
}

console.log(
  'Super Agent v0.1 (type "exit", Esc, or Ctrl+C to quit)\n',
);
ask();
