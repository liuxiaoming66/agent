import type { ModelMessage } from "ai";
import type {
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
  StreamHandle,
} from "./types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { agentLoop, type BudgetState } from "../agent/loop.js";
import type { UsageTracker } from "../usage/tracker.js";

interface GatewayOptions {
  model: any;
  registry: ToolRegistry;
  buildSystem: () => string;
  tracker?: UsageTracker;
}

export class ChannelGateway {
  private channels = new Map<string, ChannelDefinition>();
  private sessions = new Map<string, ModelMessage[]>();
  private budgets = new Map<string, BudgetState>();
  private options: GatewayOptions;

  constructor(options: GatewayOptions) {
    this.options = options;
  }

  register(channel: ChannelDefinition): void {
    this.channels.set(channel.name, channel);

    channel.onMessage?.((msg: IncomingMessage) => {
      this.handleIncoming(channel.name, msg);
    });
  }

  /** 停止并移除指定通道（供 Plugin 卸载时调用） */
  async unregister(name: string): Promise<boolean> {
    const channel = this.channels.get(name);
    if (!channel) return false;
    await channel.stop();
    this.channels.delete(name);
    console.log(`  [gateway] ✗ ${name} 已移除`);
    return true;
  }

  async startAll(): Promise<void> {
    for (const [name, ch] of this.channels) {
      try {
        await ch.start();
        console.log(`  [gateway] ✓ ${name} 已启动`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [gateway] ✗ ${name} 启动失败: ${msg}`);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const [, ch] of this.channels) {
      await ch.stop();
    }
  }

  private async handleIncoming(
    channelName: string,
    msg: IncomingMessage,
  ): Promise<void> {
    const sessionKey = `${channelName}:${msg.senderId}`;
    console.log(`\n  [${channelName}] ${msg.senderName}: ${msg.text}`);

    if (!this.sessions.has(sessionKey)) {
      this.sessions.set(sessionKey, []);
    }
    const messages = this.sessions.get(sessionKey)!;

    const userMsg: ModelMessage = { role: "user", content: msg.text };
    messages.push(userMsg);

    const system = this.options.buildSystem();

    if (!this.budgets.has(sessionKey)) {
      this.budgets.set(sessionKey, {
        used: 0,
        limit: 10000,
        inputTokens: 0,
        outputTokens: 0,
      });
    }
    const budget = this.budgets.get(sessionKey)!;

    // 尝试启动流式输出（通道支持则用卡片逐步更新，否则回退到一次性发送）
    const channel = this.channels.get(channelName);
    let stream: StreamHandle | null = null;
    if (channel?.startStream) {
      stream = await channel.startStream({
        channelId: msg.channelId,
        recipientId: msg.senderId,
        text: "",
      });
    }

    // 节流控制：每 300ms 最多刷新一次卡片
    let lastFlush = 0;
    let pendingText = "";
    const FLUSH_INTERVAL = 300;

    await agentLoop(
      this.options.model,
      this.options.registry,
      messages,
      system,
      budget,
      this.options.tracker,
      stream
        ? {
            onTextDelta: (_delta, accumulated) => {
              pendingText = accumulated;
              const now = Date.now();
              if (now - lastFlush >= FLUSH_INTERVAL) {
                lastFlush = now;
                stream!.update(pendingText).catch(() => {});
              }
            },
          }
        : undefined,
    );

    // 从 messages 里取最后一条 assistant 消息作为回复
    const lastMsg = messages[messages.length - 1];
    let replyText = "";
    if (lastMsg && lastMsg.role === "assistant") {
      const content = lastMsg.content;
      if (typeof content === "string") {
        replyText = content;
      } else if (Array.isArray(content)) {
        replyText = content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("");
      }
    }

    if (replyText) {
      if (stream) {
        // 流式通道：发送最终内容并结束，失败则回退普通发送
        try {
          await stream.finish(replyText);
        } catch {
          if (channel) {
            await channel.send({
              channelId: msg.channelId,
              recipientId: msg.senderId,
              text: replyText,
            });
          }
        }
      } else if (channel) {
        // 普通通道：一次性发送
        await channel.send({
          channelId: msg.channelId,
          recipientId: msg.senderId,
          text: replyText,
        });
      }
      console.log(
        `  [${channelName}] → ${replyText.slice(0, 80)}${replyText.length > 80 ? "..." : ""}`,
      );
    }
  }

  list(): Array<{ name: string; description: string }> {
    return Array.from(this.channels.values()).map((ch) => ({
      name: ch.name,
      description: ch.description,
    }));
  }
}
