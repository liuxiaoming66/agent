import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type {
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
  StreamHandle,
} from "./types.js";

export interface DingTalkConfig {
  /** ClientID（即 AppKey） */
  clientId: string;
  /** ClientSecret（即 AppSecret） */
  clientSecret: string;
  port: number;
  /** AI 流式卡片模板 ID（在钉钉开放平台 → 卡片模板中创建） */
  cardTemplateId: string;
}

export class DingTalkChannel implements ChannelDefinition {
  name = "dingtalk";
  description = "钉钉机器人消息通道（Stream 长连接模式）";

  private config: DingTalkConfig;
  private messageHandler?: (msg: IncomingMessage) => void;
  private httpServer?: ReturnType<typeof serve>;
  private streamClient?: any;
  private accessToken = "";
  private tokenExpiry = 0;
  /** 缓存 sessionWebhook，用于快速回复 */
  private sessionWebhooks = new Map<string, string>();
  /** 已处理的 messageId 集合，防止钉钉重投导致重复回复 */
  private processedIds = new Set<string>();
  /** 时间窗口去重：senderId:text → 上次处理时间戳（5s 内相同内容视为重投） */
  private recentMessages = new Map<string, number>();

  constructor(config?: Partial<DingTalkConfig>) {
    this.config = {
      clientId: config?.clientId || process.env.DINGTALK_CLIENT_ID || process.env.DINGTALK_APP_KEY || "",
      clientSecret: config?.clientSecret || process.env.DINGTALK_CLIENT_SECRET || process.env.DINGTALK_APP_SECRET || "",
      port: config?.port || Number(process.env.DINGTALK_PORT) || 9200,
      cardTemplateId: config?.cardTemplateId || process.env.DINGTALK_CARD_TEMPLATE_ID || "",
    };
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    await this.startDashboard();

    if (!this.config.clientId || !this.config.clientSecret) {
      console.log("    钉钉未配置 clientId/clientSecret，仅启动 Dashboard");
      return;
    }

    // 使用 dingtalk-stream SDK 建立长连接（无需公网 IP）
    const { DWClient, TOPIC_ROBOT } = await import("dingtalk-stream");

    this.streamClient = new DWClient({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
    });

    this.streamClient
      .registerCallbackListener(TOPIC_ROBOT, async (res: any) => {
        const messageId = res.headers?.messageId || "";

        // 一级去重：messageId 精确匹配（同一次投递）
        if (messageId && this.processedIds.has(messageId)) {
          return { status: "SUCCESS" };
        }

        // 解析消息内容
        let parsedData: any = null;
        try {
          parsedData = JSON.parse(res.data);
        } catch {}
        const text = (parsedData?.text?.content || "").trim();
        const senderId = parsedData?.senderStaffId || parsedData?.senderId || "unknown";

        // 二级去重：时间窗口内相同 sender+content 视为重投（兜底 messageId 变化的情况）
        const contentKey = `${senderId}:${text}`;
        const now = Date.now();
        const lastTime = this.recentMessages.get(contentKey);
        if (lastTime && now - lastTime < 5000) {
          return { status: "SUCCESS" };
        }
        this.recentMessages.set(contentKey, now);

        // 记录 messageId
        if (messageId) {
          this.processedIds.add(messageId);
          if (this.processedIds.size > 500) {
            const first = this.processedIds.values().next().value;
            if (first) this.processedIds.delete(first);
          }
        }
        // 清理过期的时间窗口记录
        if (this.recentMessages.size > 200) {
          for (const [key, time] of this.recentMessages) {
            if (now - time > 10000) this.recentMessages.delete(key);
          }
        }

        try {
          const senderName = parsedData?.senderNick || senderId;
          const conversationId = parsedData?.conversationId || "default";

          // 缓存 sessionWebhook（5 分钟有效，用于快速回复）
          if (parsedData?.sessionWebhook) {
            this.sessionWebhooks.set(conversationId, parsedData.sessionWebhook);
          }

          if (text && this.messageHandler) {
            this.messageHandler({
              channelId: conversationId,
              senderId,
              senderName,
              text,
              raw: parsedData,
            });
          }
        } catch (err) {
          console.error(
            `    [dingtalk] 消息解析失败: ${err instanceof Error ? err.message : err}`,
          );
        }

        return { status: "SUCCESS" };
      })
      .connect();

    console.log("    钉钉 Stream 长连接已建立（无需公网 IP）");
  }

  async stop(): Promise<void> {
    if (this.streamClient) {
      // dingtalk-stream 没有显式 disconnect，置空即可
      this.streamClient = undefined;
    }
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = undefined;
    }
    console.log("    [dingtalk] 已停止");
  }

  /** 流式输出：创建 AI 卡片并逐步更新内容 */
  async startStream(message: OutgoingMessage): Promise<StreamHandle | null> {
    if (!this.config.clientId || !this.config.clientSecret) return null;

    // 未配置卡片模板时回退到普通发送
    if (!this.config.cardTemplateId) {
      console.log("    [dingtalk] 未配置 DINGTALK_CARD_TEMPLATE_ID，回退普通消息");
      return null;
    }

    try {
      const token = await this.getAccessToken();
      const outTrackId = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const userId = message.recipientId;

      // 按官方文档格式：openSpaceId 使用小写 im_robot
      const openSpaceId = `dtv1.card//im_robot.${userId}`;

      // 创建并投放 AI 流式卡片（参照官方 createAndDeliver 接口）
      const res = await fetch(
        "https://api.dingtalk.com/v1.0/card/instances/createAndDeliver",
        {
          method: "POST",
          headers: {
            "x-acs-dingtalk-access-token": token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            userId,
            userIdType: 1,
            cardTemplateId: this.config.cardTemplateId,
            outTrackId,
            callbackType: "STREAM",
            cardData: {
              cardParamMap: { content: "思考中..." },
            },
            openSpaceId,
            imRobotOpenSpaceModel: {
              supportForward: true,
              lastMessageI18n: { ZH_CN: "AI 正在回复..." },
            },
            imRobotOpenDeliverModel: {
              spaceType: "IM_ROBOT",
              robotCode: this.config.clientId,
            },
          }),
        },
      );

      if (!res.ok) {
        const errText = await res.text();
        console.error(`    [dingtalk] 创建流式卡片失败: ${res.status} ${errText}`);
        return null;
      }

      console.log("    [dingtalk] 流式卡片已创建");

      // 返回 StreamHandle，通过 streamingupdate API 逐步更新卡片
      return {
        update: async (accumulatedText: string) => {
          // 中间更新失败不中断，静默忽略
          try {
            await this.updateStreamCard(token, outTrackId, accumulatedText, false);
          } catch { /* 忽略中间更新失败 */ }
        },
        finish: async (finalText: string) => {
          // 最终更新失败则抛出，触发 gateway 兜底发送普通消息
          await this.updateStreamCard(token, outTrackId, finalText, true);
        },
      };
    } catch (err) {
      console.error(
        `    [dingtalk] startStream 异常: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  /** 调用钉钉 streamingupdate API 更新卡片内容（失败时抛出异常） */
  private async updateStreamCard(
    token: string,
    outTrackId: string,
    content: string,
    isFinalize: boolean,
  ): Promise<void> {
    const res = await fetch(
      "https://api.dingtalk.com/v1.0/card/streaming",
      {
        method: "PUT",
        headers: {
          "x-acs-dingtalk-access-token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          outTrackId,
          guid: `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
          key: "content",
          content: isFinalize ? content : `${content}▌`,
          isFull: true,
          isFinalize,
        }),
      },
    );
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`卡片更新失败: ${res.status} ${errText}`);
    }
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (!this.config.clientId || !this.config.clientSecret) {
      console.log("    [dingtalk] 未配置钉钉，跳过发送");
      return;
    }

    // 优先用 sessionWebhook 快速回复（5 分钟内有效）
    const webhook = this.sessionWebhooks.get(message.channelId);
    if (webhook) {
      try {
        const res = await fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            msgtype: "text",
            text: { content: message.text },
          }),
        });
        // 无论返回什么状态码，webhook 调用过就不再走 OpenAPI，避免双发
        if (res.ok) {
          return;
        }
        console.log(`    [dingtalk] webhook 返回 ${res.status}，回退 OpenAPI`);
      } catch {
        console.log("    [dingtalk] webhook 网络异常，回退 OpenAPI");
      }
      this.sessionWebhooks.delete(message.channelId);
    }

    // 回退：通过 OpenAPI 发送单聊消息
    const token = await this.getAccessToken();
    const res = await fetch(
      "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend",
      {
        method: "POST",
        headers: {
          "x-acs-dingtalk-access-token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          robotCode: this.config.clientId,
          userIds: [message.recipientId],
          msgKey: "sampleText",
          msgParam: JSON.stringify({ content: message.text }),
        }),
      },
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error(`    [dingtalk] 发送失败: ${res.status} ${errText}`);
    }
  }

  /** Dashboard 状态面板 + 模拟测试 */
  private async startDashboard(): Promise<void> {
    const app = new Hono();

    app.get("/health", (c) => c.json({ ok: true, channel: "dingtalk" }));

    app.get("/", (c) => {
      const connected = !!this.streamClient;
      const status = connected ? "🟢 Stream 已连接" : "🟡 未连接";
      return c.html(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>DingTalk Channel</title>
<style>body{font-family:system-ui;max-width:600px;margin:60px auto;padding:0 20px;background:#0f172a;color:#e2e8f0}
h1{font-size:1.4rem}.status{padding:12px 16px;border-radius:8px;background:#1e293b;margin:16px 0}
form{margin-top:24px}input,button{padding:8px 12px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:#e2e8f0}
button{cursor:pointer;background:#6366f1;border-color:#6366f1}</style></head>
<body><h1>🤖 钉钉通道状态</h1>
<div class="status">状态: ${status}<br/>模式: Stream 长连接<br/>Dashboard 端口: ${this.config.port}</div>
<h3>模拟消息（测试用）</h3>
<form method="POST" action="/webhook/dingtalk">
<input name="text" placeholder="输入消息..." style="width:70%"/>
<button type="submit">发送</button>
</form></body></html>`);
    });

    // 模拟 webhook：本地测试消息收发
    app.post("/webhook/dingtalk", async (c) => {
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

    this.httpServer = serve({ fetch: app.fetch, port: this.config.port });
    console.log(`    [dingtalk] Dashboard → http://localhost:${this.config.port}`);
  }

  /** 获取/刷新 access_token（有效期 7200s，提前 5 分钟刷新） */
  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const res = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appKey: this.config.clientId,
        appSecret: this.config.clientSecret,
      }),
    });

    if (!res.ok) {
      throw new Error(`钉钉 token 获取失败: ${res.status}`);
    }

    const data = (await res.json()) as {
      accessToken: string;
      expireIn: number;
    };
    this.accessToken = data.accessToken;
    this.tokenExpiry = Date.now() + (data.expireIn - 300) * 1000;
    return this.accessToken;
  }
}
