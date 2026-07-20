import type { ToolDefinition } from "./registry.js";
import { readFileTool, writeFileTool, listDirectoryTool, editFileTool } from "./file-tools.js";
import { globTool, grepTool } from "./search-tools.js";
import { bashTool } from "./shell-tools.js";
import { weatherTool, calculatorTool, fetchUrlTool, startPreviewTool } from "./utility-tools.js";

export const allTools: ToolDefinition[] = [
  weatherTool,
  calculatorTool,
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  editFileTool,
  globTool,
  grepTool,
  bashTool,
  fetchUrlTool,
  startPreviewTool,
];

// 重新导出各模块，方便外部按需引用
export { readFileTool, writeFileTool, listDirectoryTool, editFileTool } from "./file-tools.js";
export { globTool, grepTool } from "./search-tools.js";
export { bashTool } from "./shell-tools.js";
export { weatherTool, calculatorTool, fetchUrlTool, startPreviewTool } from "./utility-tools.js";
export { ToolRegistry, truncateResult } from "./registry.js";
export type { ToolDefinition } from "./registry.js";
export { MCPClient } from "./mcp-client.js";
