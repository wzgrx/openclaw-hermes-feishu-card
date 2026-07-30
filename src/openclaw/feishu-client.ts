import * as Lark from "@larksuiteoapi/node-sdk";

import type { CardJson } from "../core/types.js";
import type { FeishuCredentials } from "./credentials.js";

interface CardKitResponse {
  code?: number;
  msg?: string;
  data?: {
    card_id?: string;
    message_id?: string;
    chat_id?: string;
  };
  card_id?: string;
}

function assertSuccess(response: CardKitResponse, operation: string): void {
  if (response.code !== undefined && response.code !== 0) {
    throw new Error(
      `${operation} failed (${response.code}): ${response.msg ?? "unknown error"}`,
    );
  }
}

export class FeishuCardClient {
  private readonly client: Lark.Client;

  constructor(credentials: FeishuCredentials) {
    this.client = new Lark.Client({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain:
        credentials.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu,
    });
  }

  async create(params: {
    card: CardJson;
    conversationId: string;
    replyToId?: string;
    replyInThread?: boolean;
  }): Promise<{ cardId: string; messageId?: string }> {
    const created = (await this.client.cardkit.v1.card.create({
      data: {
        type: "card_json",
        data: JSON.stringify(params.card),
      },
    })) as CardKitResponse;
    assertSuccess(created, "cardkit.card.create");
    const cardId = created.data?.card_id ?? created.card_id;
    if (!cardId) {
      throw new Error("cardkit.card.create returned no card_id");
    }

    const content = JSON.stringify({
      type: "card",
      data: { card_id: cardId },
    });
    let sent: CardKitResponse;
    if (params.replyToId) {
      sent = (await this.client.im.message.reply({
        path: { message_id: params.replyToId },
        data: {
          msg_type: "interactive",
          content,
          reply_in_thread: params.replyInThread ?? false,
        },
      })) as CardKitResponse;
    } else {
      sent = (await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: params.conversationId,
          msg_type: "interactive",
          content,
        },
      })) as CardKitResponse;
    }
    assertSuccess(sent, "im.message.send");
    const messageId = sent.data?.message_id;
    return {
      cardId,
      ...(messageId ? { messageId } : {}),
    };
  }

  async update(params: {
    cardId: string;
    card: CardJson;
    sequence: number;
  }): Promise<void> {
    const response = (await this.client.cardkit.v1.card.update({
      path: { card_id: params.cardId },
      data: {
        card: {
          type: "card_json",
          data: JSON.stringify(params.card),
        },
        sequence: params.sequence,
      },
    })) as CardKitResponse;
    assertSuccess(response, "cardkit.card.update");
  }

  async setStreamingMode(params: {
    cardId: string;
    enabled: boolean;
    sequence: number;
  }): Promise<void> {
    const response = (await this.client.cardkit.v1.card.settings({
      path: { card_id: params.cardId },
      data: {
        settings: JSON.stringify({ streaming_mode: params.enabled }),
        sequence: params.sequence,
      },
    })) as CardKitResponse;
    assertSuccess(response, "cardkit.card.settings");
  }
}
