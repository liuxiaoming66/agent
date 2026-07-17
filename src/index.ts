import "dotenv/config";
import { stepCountIs, streamText, type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createMockModel } from "./mock-model";
import { createInterface } from "node:readline";
import { calculatorTool, weatherTool } from "./tools/utility-tools";

const tools = { get_weather: weatherTool, calculator: calculatorTool };

const qwen = createOpenAI({
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey: process.env.DASHSCOPE_API_KEY,
});

const model = process.env.DASHSCOPE_API_KEY
  ? qwen.chat("qwen-plus-latest")
  : createMockModel();

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

const messages: ModelMessage[] = [];

function ask() {
  rl.question("\nYou: ", async (input) => {
    const trimmed = input.trim();
    if (!trimmed || trimmed === "exit") {
      console.log("Bye!");
      rl.close();
      return;
    }

    messages.push({ role: "user", content: trimmed });

    const result = streamText({
      model,
      system: `你是 Super Agent，一个专注于软件开发的 AI 助手。
你说话简洁直接，喜欢用代码示例来解释问题。
如果用户的问题不够清晰，你会反问而不是瞎猜。`,
      messages,
      tools,
      stopWhen: stepCountIs(5),
    });

    process.stdout.write("Assistant: ");
    let fullResponse = "";
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          process.stdout.write(part.text);
          fullResponse += part.text;
          break;
        case "tool-call":
          console.log(
            `\n  [调用工具: ${part.toolName}(${JSON.stringify(part.input)})]`,
          );
          break;
        case "tool-result":
          console.log(`  [工具返回: ${JSON.stringify(part.output)}]`);
          break;
      }
    }
    console.log(); // 换行

    messages.push({ role: "assistant", content: fullResponse });

    ask();
  });
}

console.log('Super Agent v0.1 (type "exit" to quit)\n');
ask();
