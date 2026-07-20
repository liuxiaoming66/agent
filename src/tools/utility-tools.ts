import type { ToolDefinition } from "./registry.js";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { createServer, Server } from "node:http";

export const weatherTool: ToolDefinition = {
  name: "get_weather",
  description: "查询指定城市的天气信息",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string", description: '城市名称，如"北京"、"上海"' },
    },
    required: ["city"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ city }: { city: string }) => {
    const data: Record<string, string> = {
      北京: "晴，15-25°C，东南风 2 级",
      上海: "多云，18-22°C，西南风 3 级",
      深圳: "阵雨，22-28°C，南风 2 级",
    };
    return data[city] || `${city}：暂无数据`;
  },
};

export const calculatorTool: ToolDefinition = {
  name: "calculator",
  description: "计算数学表达式的结果。当用户提问涉及数学运算时使用",
  parameters: {
    type: "object",
    properties: {
      expression: { type: "string", description: '数学表达式，如 "2 + 3 * 4"' },
    },
    required: ["expression"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ expression }: { expression: string }) => {
    try {
      // 生产环境不要用 eval，这里纯粹为了演示
      const result = new Function(`return ${expression}`)();
      return `${expression} = ${result}`;
    } catch {
      return `无法计算: ${expression}`;
    }
  },
};

const MOCK_PAGES: Record<string, string> = {
  "https://esm.sh": `esm.sh - 一个免费的 ES module CDN...`,
  "https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling": `AI SDK Core - Tools and Tool Calling
工具是模型可以决定调用的函数。一个工具由三部分组成：
- description：告诉模型何时使用这个工具
- inputSchema：通过 Zod 或 JSON Schema 定义参数
- execute：实际在服务端运行的函数...`,
  // ... 更多预定义页面
};

export const fetchUrlTool: ToolDefinition = {
  name: "fetch_url",
  description: "抓取指定 URL 的网页内容并转换为纯文本（自动剥离 HTML 标签）",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "完整 URL，必须以 http:// 或 https:// 开头",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  isConcurrencySafe: true, // 只读、可并发——抓多个 URL 时直接并行
  isReadOnly: true,
  maxResultChars: 1500, // 网页通常很长，截断兜底
  execute: async ({ url }: { url: string }) => {
    for (const key of Object.keys(MOCK_PAGES)) {
      if (url.startsWith(key)) return MOCK_PAGES[key];
    }
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 SuperAgent" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return `请求失败：HTTP ${res.status}`;
      const html = await res.text();
      return (
        html
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim() || "页面无文本内容"
      );
    } catch (err: any) {
      return `抓取失败：${err.message}`;
    }
  },
};

let previewServer: Server | null = null;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".tsx": "application/javascript; charset=utf-8", // 让浏览器把 .tsx 当 JS 加载
  ".ts": "application/javascript; charset=utf-8",
  // ...
};

export const startPreviewTool: ToolDefinition = {
  name: "start_preview",
  description: "启动 app/ 目录的预览服务器。生成应用文件后必须立即调用此工具",
  parameters: {
    type: "object",
    properties: { port: { type: "number" } },
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({ port = 8080 }: { port?: number } = {}) => {
    if (previewServer) return `预览服务器已在运行 → http://localhost:${port}`;
    const root = resolve("app");
    if (!existsSync(root)) return "错误：app/ 目录不存在";

    previewServer = createServer((req, res) => {
      const urlPath = (req.url?.split("?")[0] || "/").replace(
        /\/$/,
        "/index.html",
      );
      const filePath = join(root, urlPath === "/" ? "/index.html" : urlPath);
      try {
        if (!filePath.startsWith(root)) {
          res.writeHead(403);
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Type":
            MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
          "Cache-Control": "no-cache",
        });
        res.end(readFileSync(filePath));
      } catch {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    return new Promise<string>((resolve) => {
      previewServer!.listen(port, () => {
        resolve(`✓ 预览服务器已启动 → http://localhost:${port}`);
      });
    });
  },
};
