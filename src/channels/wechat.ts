import { Hono } from "hono";
import { serve } from "@hono/node-server";
import crypto from "node:crypto";
import type {
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
} from "./types.js";

export interface WeChatConfig {
  /** 企业 ID */
  corpId: string;
  /** 应用 Secret */
  corpSecret: string;
  /** 应用 AgentId */
  agentId: string;
  /** 回调验证 Token */
  callbackToken: string;
  /** 回调 EncodingAESKey */
  encodingAESKey: string;
  port: number;
}

export class WeChatChannel implements ChannelDefinition {
  name = "wechat";
  description = "企业微信应用消息通道（回调模式）";

  private config: WeChatConfig;
  private messageHandler?: (msg: IncomingMessage) => void;
  private httpServer?: ReturnType<typeof serve>;
  private accessToken = "";
  private tokenExpiry = 0;

  constructor(config?: Partial<WeChatConfig>) {
    this.config = {
      corpId: config?.corpId || process.env.WECOM_CORP_ID || "",
      corpSecret: config?.corpSecret || process.env.WECOM_CORP_SECRET || "",
      agentId: config?.agentId || process.env.WECOM_AGENT_ID || "",
      callbackToken:
        config?.callbackToken || process.env.WECOM_CALLBACK_TOKEN || "",
      encodingAESKey:
        config?.encodingAESKey || process.env.WECOM_ENCODING_AES_KEY || "",
      port: config?.port || Number(process.env.WECOM_PORT) || 9300,
    };
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    const app = new Hono();

    app.get("/health", (c) => c.json({ ok: true, channel: "wechat" }));

    // 状态面板
    app.get("/", (c) => {
      const configured = !!(this.config.corpId && this.config.corpSecret);
      const status = configured ? "🟢 已配置" : "🟡 未配置";
      return c.html(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>WeCom Channel</title>
<style>body{font-family:system-ui;max-width:600px;margin:60px auto;padding:0 20px;background:#0f172a;color:#e2e8f0}
h1{font-size:1.4rem}.status{padding:12px 16px;border-radius:8px;background:#1e293b;margin:16px 0}
form{margin-top:24px}input,button{padding:8px 12px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:#e2e8f0}
button{cursor:pointer;background:#6366f1;border-color:#6366f1}</style></head>
<body><h1>💬 企业微信通道状态</h1>
<div class="status">状态: ${status}<br/>回调端口: ${this.config.port}</div>
<h3>模拟消息（测试用）</h3>
<form method="POST" action="/webhook/wechat">
<input name="text" placeholder="输入消息..." style="width:70%"/>
<button type="submit">发送</button>
</form></body></html>`);
    });

    // 企业微信回调验证（GET 请求，用于 URL 验证）
    app.get("/webhook/wechat", (c) => {
      const { msg_signature, timestamp, nonce, echostr } = c.req.query();
      // 简化验证：生产环境应做 AES 解密验证
      if (echostr) {
        return c.text(echostr);
      }
      return c.text("ok");
    });

    // 企业微信消息回调（POST）
    app.post("/webhook/wechat", async (c) => {
      const contentType = c.req.header("content-type") || "";

      // 模拟测试（JSON body）
      if (contentType.includes("application/json")) {
        const body = await c.req.json<any>();
        if (body.text && this.messageHandler) {
          this.messageHandler({
            channelId: "test-chat",
            senderId: "test-user",
            senderName: "模拟用户",
            text: body.text,
          });
        }
        return c.json({ ok: true });
      }

      // 企业微信标准 XML 回调
      const rawBody = await c.req.text();
      const parsed = this.parseXmlMessage(rawBody);

      if (parsed && parsed.MsgType === "text" && parsed.Content) {
        const text = parsed.Content.trim();
        if (text && this.messageHandler) {
          this.messageHandler({
            channelId: parsed.FromUserName || "default",
            senderId: parsed.FromUserName || "unknown",
            senderName: parsed.FromUserName || "unknown",
            text,
            raw: parsed,
          });
        }
      }

      return c.text("success");
    });

    this.httpServer = serve({ fetch: app.fetch, port: this.config.port });
    console.log(
      `    [wechat] 回调服务 → http://localhost:${this.config.port}/webhook/wechat`,
    );

    if (!this.config.corpId || !this.config.corpSecret) {
      console.log("    企业微信未配置 corpId/corpSecret，仅启动回调服务");
    }
  }

  async stop(): Promise<void> {
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = undefined;
    }
    console.log("    [wechat] 已停止");
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (!this.config.corpId || !this.config.corpSecret) {
      console.log("    [wechat] 未配置企业微信，跳过发送");
      return;
    }

    const token = await this.getAccessToken();

    const res = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          touser: message.recipientId,
          msgtype: "text",
          agentid: Number(this.config.agentId),
          text: { content: message.text },
        }),
      },
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error(`    [wechat] 发送失败: ${res.status} ${errText}`);
    }
  }

  /** 获取/刷新 access_token */
  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const url =
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken` +
      `?corpid=${this.config.corpId}&corpsecret=${this.config.corpSecret}`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`企业微信 token 获取失败: ${res.status}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
      errcode: number;
      errmsg: string;
    };

    if (data.errcode !== 0) {
      throw new Error(`企业微信 token 错误: ${data.errmsg}`);
    }

    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
    return this.accessToken;
  }

  /** 简易 XML 解析（企业微信回调为 XML 格式） */
  private parseXmlMessage(
    xml: string,
  ): Record<string, string> | null {
    try {
      const result: Record<string, string> = {};
      const regex = /<(\w+)><!\[CDATA\[(.*?)\]\]><\/\1>|<(\w+)>(.*?)<\/\3>/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(xml)) !== null) {
        const key = match[1] || match[3];
        const value = match[2] ?? match[4] ?? "";
        result[key] = value;
      }
      return Object.keys(result).length > 0 ? result : null;
    } catch {
      return null;
    }
  }
}
