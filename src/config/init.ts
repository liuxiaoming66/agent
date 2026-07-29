import { createInterface } from "node:readline";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { CONFIG_FILE } from "./loader.js";

export async function runInit() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => {
      console.log(q);
      rl.question("  > ", resolve);
    });

  console.log("\n  Super Agent 初始化向导\n");

  if (fs.existsSync(CONFIG_FILE)) {
    const overwrite = await ask(`  ${CONFIG_FILE} 已存在，覆盖? (y/N): `);
    if (overwrite.toLowerCase() !== "y") {
      console.log("  已取消\n");
      rl.close();
      return;
    }
  }

  // ── 模型选择 ──────────────────────────
  console.log("  选择模型:\n");
  console.log("    1. qwen3.7-flash   (推荐，均衡)");
  console.log("    2. kimi-k2.7-code  (快速，便宜)");
  console.log("    3. glm-5.2    (最强，贵)\n");
  const modelChoice = (await ask("  模型 [1]: ")) || "1";
  const models: Record<string, string> = {
    "1": "qwen3.7-flash",
    "2": "kimi-k2.7-code",
    "3": "glm-5.2",
  };
  const modelName = models[modelChoice] || "qwen-plus-latest";

  // ── API Key ──────────────────────────
  const apiKey = await ask(
    "\n  DashScope API Key (留空则从环境变量 DASHSCOPE_API_KEY 读取): ",
  );

  // ── 钉钉 Channel ──────────────────────────
  const enableDingTalk =
    (await ask("\n  启用钉钉 Channel? (y/N): ")).toLowerCase() === "y";
  let dingtalkClientId = "";
  let dingtalkClientSecret = "";
  let dingtalkCardTemplateId = "";
  if (enableDingTalk) {
    dingtalkClientId = await ask("  钉钉 Client ID (即 AppKey): ");
    dingtalkClientSecret = await ask("  钉钉 Client Secret (即 AppSecret): ");
    dingtalkCardTemplateId = await ask(
      "  AI 流式卡片模板 ID (可选，留空回退普通消息): ",
    );
  }

  // ── Sub-Agent ──────────────────────────
  const concurrentStr = await ask("\n  子 Agent 最大并发数 [3]: ");
  const maxConcurrent = parseInt(concurrentStr) || 3;

  // ── 生成配置 ──────────────────────────
  const config = {
    version: "1.0",
    model: {
      provider: "dashscope",
      name: modelName,
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: apiKey || "${DASHSCOPE_API_KEY}",
    },
    plugins: [{ name: "supabase", enabled: false, config: {} }],
    channels: {
      dingtalk: {
        enabled: enableDingTalk,
        clientId: enableDingTalk ? dingtalkClientId : "${DINGTALK_CLIENT_ID}",
        clientSecret: enableDingTalk
          ? dingtalkClientSecret
          : "${DINGTALK_CLIENT_SECRET}",
        port: 9200,
        cardTemplateId: dingtalkCardTemplateId,
      },
    },
    agents: {
      maxSpawnDepth: 1,
      maxConcurrent,
      defaultTimeout: 60000,
    },
    security: {
      defaultRole: "developer",
      auditLog: true,
      bashTimestamp: true,
    },
    memory: { dataDir: "." },
    rag: { enabled: true, docsDir: "docs" },
    cron: { enabled: true, dataDir: "." },
    session: { id: "default" },
    usage: { trackingFile: ".usage/today.jsonl" },
  };

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
  console.log(`\n  ✓ ${CONFIG_FILE} 已生成`);

  // 生成/追加 .env（不覆盖已有内容，只补充缺失的键）
  const envLines: string[] = [];
  if (apiKey) {
    envLines.push(`DASHSCOPE_API_KEY=${apiKey}`);
  }
  if (enableDingTalk && dingtalkClientId) {
    envLines.push(`DINGTALK_CLIENT_ID=${dingtalkClientId}`);
    envLines.push(`DINGTALK_CLIENT_SECRET=${dingtalkClientSecret}`);
    if (dingtalkCardTemplateId) {
      envLines.push(`DINGTALK_CARD_TEMPLATE_ID=${dingtalkCardTemplateId}`);
    }
  }
  if (envLines.length > 0) {
    const existing = fs.existsSync(".env")
      ? fs.readFileSync(".env", "utf-8")
      : "";
    const existingKeys = new Set(
      existing
        .split(/\r?\n/)
        .map((line) => line.split("=")[0].trim())
        .filter(Boolean),
    );
    const newLines = envLines.filter(
      (line) => !existingKeys.has(line.split("=")[0]),
    );
    if (newLines.length > 0) {
      const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
      fs.appendFileSync(".env", prefix + newLines.join("\n") + "\n");
      console.log(
        existing ? "  ✓ .env 已追加新配置（保留原有内容）" : "  ✓ .env 已生成",
      );
    } else {
      console.log("  ✓ .env 已包含所需配置，未修改");
    }
  }

  console.log("\n  启动 Agent: pnpm start\n");
  rl.close();
}

// 直接运行本文件时启动向导（pnpm run init）
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runInit();
}
