export interface IncomingMessage {
  channelId: string;
  senderId: string;
  senderName: string;
  text: string;
  raw?: unknown;
}

export interface OutgoingMessage {
  channelId: string;
  recipientId: string;
  text: string;
}

/** 流式输出句柄：在一条消息内逐步更新内容 */
export interface StreamHandle {
  /** 追加/更新当前累计文本 */
  update(accumulatedText: string): Promise<void>;
  /** 结束流式输出，发送最终内容 */
  finish(finalText: string): Promise<void>;
}

export interface ChannelDefinition {
  name: string;
  description: string;

  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  send(message: OutgoingMessage): Promise<void>;

  /** 可选：启动流式输出，返回句柄；不支持则回退到 send */
  startStream?(message: OutgoingMessage): Promise<StreamHandle | null>;

  onMessage?: (handler: (msg: IncomingMessage) => void) => void;
}