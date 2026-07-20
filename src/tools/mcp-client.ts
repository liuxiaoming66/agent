import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class MCPClient {
  private client: Client;
  private transport: StdioClientTransport;

  constructor(
    command: string,
    args: string[],
    env?: Record<string, string>,
  ) {
    this.transport = new StdioClientTransport({
      command,
      args,
      env: { ...process.env, ...env } as Record<string, string>,
    });

    this.client = new Client({
      name: "super-agent",
      version: "0.5.0",
    });
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  async listTools(): Promise<MCPTool[]> {
    const result = await this.client.listTools();
    return (result.tools || []).map((t) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text?: string }>;
    const texts = (content || [])
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!);
    return texts.join("\n") || "(无返回内容)";
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
