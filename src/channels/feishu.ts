import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type {
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
} from "./types.js";

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  port: number;
}

export class FeishuChannel implements ChannelDefinition {
  name = "feishu";
  description = "飞书 Bot 消息通道（长连接模式）";

  private config: FeishuConfig;
  private messageHandler?: (msg: IncomingMessage) => void;
  private httpServer?: ReturnType<typeof serve>;
  private wsClient?: any;
  private larkClient?: any;

  constructor(config?: Partial<FeishuConfig>) {
    this.config = {
      appId: config?.appId || process.env.FEISHU_APP_ID || "",
      appSecret: config?.appSecret || process.env.FEISHU_APP_SECRET || "",
      port: config?.port || Number(process.env.FEISHU_DASHBOARD_PORT) || 9100,
    };
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    await this.startDashboard();

    if (!this.config.appId || !this.config.appSecret) {
      console.log("    飞书未配置，仅启动 Dashboard");
      return;
    }

    // @ts-expect-error 飞书 SDK 按需安装，未安装时不会走到此分支
    const lark = await import("@larksuiteoapi/node-sdk");

    this.larkClient = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    const dispatcher = new lark.EventDispatcher({});

    dispatcher.register({
      "im.message.receive_v1": (data: any) => {
        if (data.message.message_type !== "text") return;
        const content = JSON.parse(data.message.content);
        let text = content.text || "";
        if (data.message.mentions) {
          for (const m of data.message.mentions) {
            text = text.replace(m.key, "").trim();
          }
        }
        if (text && this.messageHandler) {
          this.messageHandler({
            channelId: data.message.chat_id,
            senderId: data.sender.sender_id?.open_id || "unknown",
            senderName: data.sender.sender_id?.open_id || "unknown",
            text,
            raw: data,
          });
        }
      },
    });

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    console.log("    飞书长连接已建立（无需 ngrok）");
  }

  async stop(): Promise<void> {
    if (this.wsClient) {
      // WSClient 没有显式 close，置空即可
      this.wsClient = undefined;
    }
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = undefined;
    }
    console.log("    [feishu] 已停止");
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (!this.larkClient) {
      console.log(`    [feishu] 未配置飞书，跳过发送`);
      return;
    }
    await this.larkClient.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: message.channelId,
        msg_type: "text",
        content: JSON.stringify({ text: message.text }),
      },
    });
  }

  /** 状态面板 + webhook 模拟测试 */
  private async startDashboard(): Promise<void> {
    const app = new Hono();

    app.get("/", (c) => {
      const status = this.larkClient ? "🟢 已连接" : "🟡 未配置";
      return c.html(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Feishu Channel</title>
<style>body{font-family:system-ui;max-width:600px;margin:60px auto;padding:0 20px;background:#0f172a;color:#e2e8f0}
h1{font-size:1.4rem} .status{padding:12px 16px;border-radius:8px;background:#1e293b;margin:16px 0}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:0.85rem;background:#334155}
form{margin-top:24px} input,button{padding:8px 12px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:#e2e8f0}
button{cursor:pointer;background:#6366f1;border-color:#6366f1}</style></head>
<body><h1>🐦 飞书通道状态</h1>
<div class="status">状态: ${status}<br/>Dashboard 端口: ${this.config.port}</div>
<h3>模拟消息（测试用）</h3>
<form method="POST" action="/webhook/feishu">
<input name="text" placeholder="输入消息..." style="width:70%"/>
<button type="submit">发送</button>
</form></body></html>`);
    });

    // 模拟 webhook：方便本地测试消息收发
    app.post("/webhook/feishu", async (c) => {
      const body = await c.req.parseBody();
      const text = (body.text as string) || "";
      if (text && this.messageHandler) {
        this.messageHandler({
          channelId: "test-chat",
          senderId: "test-user",
          senderName: "模拟用户",
          text,
        });
      }
      return c.redirect("/");
    });

    app.get("/health", (c) => c.json({ ok: true, channel: "feishu" }));

    this.httpServer = serve({ fetch: app.fetch, port: this.config.port });
    console.log(`    [feishu] Dashboard → http://localhost:${this.config.port}`);
  }
}
 