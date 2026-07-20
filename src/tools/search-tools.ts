import type { ToolDefinition } from "./registry.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";

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
