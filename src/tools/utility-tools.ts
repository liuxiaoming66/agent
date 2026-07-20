import { execSync } from "node:child_process";
import type { ToolDefinition } from "../tool-registry";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { join, resolve, relative, sep } from "node:path";

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

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description: "读取指定路径的文件内容",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 500, // 演示用，生产环境通常 50000+
  execute: async ({ path }: { path: string }) => {
    return readFileSync(resolve(path), "utf-8");
  },
};

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description: "写入内容到指定文件",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      content: { type: "string", description: "要写入的内容" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  isConcurrencySafe: false, // 写操作不能并行
  isReadOnly: false,
  execute: async ({ path, content }: { path: string; content: string }) => {
    writeFileSync(resolve(path), content, "utf-8");
    return `已写入 ${content.length} 字符到 ${path}`;
  },
};

export const listDirectoryTool: ToolDefinition = {
  name: "list_directory",
  description: "列出指定目录下的文件和子目录",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "目录路径，默认为当前目录" },
    },
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ path = "." }: { path?: string }) => {
    const resolved = resolve(path);
    return readdirSync(resolved)
      .map((name) => {
        const stat = statSync(join(resolved, name));
        return `${stat.isDirectory() ? "[DIR]" : "[FILE]"} ${name}`;
      })
      .join("\n");
  },
};
export const editFileTool: ToolDefinition = {
  name: "edit_file",
  description:
    "精确替换文件中的指定内容。用 old_string 定位要替换的文本，用 new_string 替换它。不是全量覆写——只改你指定的部分",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      old_string: {
        type: "string",
        description: "要被替换的原始文本（必须精确匹配）",
      },
      new_string: { type: "string", description: "替换后的新文本" },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({ path, old_string, new_string }) => {
    const resolved = resolve(path);
    if (!existsSync(resolved)) return `文件不存在: ${path}`;

    const content = readFileSync(resolved, "utf-8");
    const count = content.split(old_string).length - 1;

    if (count === 0) {
      return `未找到匹配内容。请检查 old_string 是否与文件中的文本完全一致（包括空格和换行）`;
    }
    if (count > 1) {
      return `找到 ${count} 处匹配，请提供更多上下文让 old_string 唯一`;
    }

    const updated = content.replace(old_string, new_string);
    writeFileSync(resolved, updated, "utf-8");
    return `已替换 ${path} 中的内容（${old_string.length} → ${new_string.length} 字符）`;
  },
};

export const globTool: ToolDefinition = {
  name: "glob",
  description:
    '按模式搜索文件。支持 * 和 ** 通配符，如 "src/**/*.ts" 匹配 src 下所有 TypeScript 文件',
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: '搜索模式，如 "**/*.ts"、"src/*.json"',
      },
      path: { type: "string", description: "搜索起始目录，默认当前目录" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({
    pattern,
    path = ".",
  }: {
    pattern: string;
    path?: string;
  }) => {
    const SKIP_DIRS = new Set(["node_modules", ".git"]);
    const MAX_RESULTS = 100;
    const root = resolve(path);
    const results: string[] = [];

    // 将 glob 模式转为正则：
    // **/ 或 /** 匹配零或多层目录，* 匹配单层内任意字符（不含路径分隔符），? 匹配单字符
    const S = "[/\\\\]"; // 路径分隔符字符类
    let regexStr = "";
    let i = 0;
    while (i < pattern.length) {
      if (pattern[i] === "*" && pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          regexStr += `(?:.+${S})?`; // **/ → 零或多层目录
          i += 3;
        } else {
          regexStr += ".*"; // 末尾 ** → 匹配一切
          i += 2;
        }
      } else if (pattern[i] === "*") {
        regexStr += `[^/\\\\]*`;
        i++;
      } else if (pattern[i] === "?") {
        regexStr += `[^/\\\\]`;
        i++;
      } else if (pattern[i] === "/") {
        regexStr += S;
        i++;
      } else {
        regexStr += pattern[i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
        i++;
      }
    }
    const regex = new RegExp(`^${regexStr}$`);

    function walk(dir: string): void {
      if (results.length >= MAX_RESULTS) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (results.length >= MAX_RESULTS) return;
        const fullPath = join(dir, name);
        let stat;
        try {
          stat = statSync(fullPath);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          if (SKIP_DIRS.has(name)) continue;
          walk(fullPath);
        } else {
          const rel = relative(root, fullPath).split(sep).join("/");
          if (regex.test(rel)) {
            results.push(rel);
          }
        }
      }
    }

    walk(root);

    if (results.length === 0) return "未找到匹配的文件";
    const suffix =
      results.length >= MAX_RESULTS
        ? `\n...（已达上限 ${MAX_RESULTS} 条）`
        : "";
    return results.join("\n") + suffix;
  },
};

export const grepTool: ToolDefinition = {
  name: "grep",
  description: "在文件中搜索匹配指定模式的内容。返回匹配的行号和内容",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "搜索模式（正则表达式）" },
      path: {
        type: "string",
        description: "搜索路径（文件或目录），默认当前目录",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({
    pattern,
    path = ".",
  }: {
    pattern: string;
    path?: string;
  }) => {
    const SKIP_DIRS = new Set(["node_modules", ".git"]);
    const MAX_MATCHES = 50;
    const resolved = resolve(path);
    const matches: string[] = [];

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "i");
    } catch {
      return `无效的正则表达式: ${pattern}`;
    }

    // 简单判断是否为二进制文件（含 NULL 字节）
    function isBinary(buf: Buffer): boolean {
      const len = Math.min(buf.length, 8192);
      for (let i = 0; i < len; i++) {
        if (buf[i] === 0) return true;
      }
      return false;
    }

    function searchFile(filePath: string): void {
      if (matches.length >= MAX_MATCHES) return;
      let buf: Buffer;
      try {
        buf = readFileSync(filePath);
      } catch {
        return;
      }
      if (isBinary(buf)) return;

      const lines = buf.toString("utf-8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= MAX_MATCHES) return;
        if (regex.test(lines[i])) {
          const rel = relative(process.cwd(), filePath).split(sep).join("/");
          matches.push(`${rel}:${i + 1}: ${lines[i].trimEnd()}`);
        }
      }
    }

    function walk(dir: string): void {
      if (matches.length >= MAX_MATCHES) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (matches.length >= MAX_MATCHES) return;
        const fullPath = join(dir, name);
        let stat;
        try {
          stat = statSync(fullPath);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          if (SKIP_DIRS.has(name)) continue;
          walk(fullPath);
        } else {
          searchFile(fullPath);
        }
      }
    }

    // 支持传入单个文件或目录
    const stat = statSync(resolved);
    if (stat.isFile()) {
      searchFile(resolved);
    } else {
      walk(resolved);
    }

    if (matches.length === 0) return "未找到匹配内容";
    const suffix =
      matches.length >= MAX_MATCHES
        ? `\n...（已达上限 ${MAX_MATCHES} 条）`
        : "";
    return matches.join("\n") + suffix;
  },
};

export const bashTool: ToolDefinition = {
  name: "bash",
  description:
    "执行 shell 命令并返回输出。适合运行脚本、检查环境、执行构建等操作",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的 shell 命令" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  maxResultChars: 3000,
  execute: async ({ command }) => {
    // 先检测环境是否支持 child_process
    try {
      execSync("echo test", { stdio: "ignore" });
    } catch {
      return `[bash 不可用] 当前环境不支持 shell 命令。本地终端运行可使用。`;
    }

    try {
      const output = execSync(command, {
        encoding: "utf-8",
        timeout: 10000, // 10 秒超时
        maxBuffer: 1024 * 1024,
      });
      return output || "(命令执行成功，无输出)";
    } catch (err: any) {
      return `命令执行失败 (exit ${err.status || 1}):\n${err.stderr || err.message}`;
    }
  },
};

export const allTools: ToolDefinition[] = [
  weatherTool,
  calculatorTool,
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  editFileTool,
  globTool,
  grepTool,
  bashTool
];
