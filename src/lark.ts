import { randomUUID } from "node:crypto";
import * as lark from "@larksuiteoapi/node-sdk";
import { readSecret, writeSecret } from "./state";
import type { InboxItem, InboxSource, MessageRef } from "./workflow";

const secretPrefix = "hafi:lark:";
const larkApiDomain = "https://open.larksuite.com";
const larkAccountsDomain = "https://accounts.larksuite.com";

type LarkCredentials = {
  appId: string;
  appSecret: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  openId: string;
};
type LarkCursor = { version: 1; activationAt: number; lastSuccessAt: number; chatBaselines: Record<string, number> };
type LarkMessage = {
  message_id?: string;
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
  msg_type?: string;
  create_time?: string;
  chat_id?: string;
  sender?: { id?: string; sender_name?: string };
  body?: { content?: string };
};
type LarkChat = { chat_id?: string; name?: string; chat_mode?: string };

function secretName(account: string): string {
  return `${secretPrefix}${encodeURIComponent(account)}`;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before connecting Lark.`);
  return value;
}

function newClient(appId: string, appSecret: string): lark.Client {
  return new lark.Client({
    appId,
    appSecret,
    domain: larkApiDomain,
    oauthBaseUrl: larkAccountsDomain,
  });
}

function openUrl(url: string): void {
  try {
    const command = process.platform === "darwin" ? ["open", url]
      : process.platform === "win32" ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url];
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }).unref();
  } catch {
    console.error(`Open this URL to authorize your Lark account:\n${url}`);
  }
}

async function authorizationCode(redirectUri: string): Promise<string> {
  const callback = new URL(redirectUri);
  if (callback.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname) || !callback.port) {
    throw new Error("HAFI_LARK_REDIRECT_URI must be a registered http://localhost or loopback URL with an explicit port.");
  }
  const state = randomUUID();
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = Bun.serve({
    hostname: callback.hostname === "localhost" ? "127.0.0.1" : callback.hostname.replace(/^\[|\]$/g, ""),
    port: Number(callback.port),
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== callback.pathname) return new Response("Not found", { status: 404 });
      if (url.searchParams.get("state") !== state) {
        rejectCode(new Error("Lark authorization returned an invalid state."));
        return new Response("Authorization state did not match. You can close this tab.", { status: 400 });
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error || !code) {
        rejectCode(new Error(`Lark authorization failed${error ? `: ${error}` : "."}`));
        return new Response("Authorization failed. You can close this tab.", { status: 400 });
      }
      resolveCode(code);
      return new Response("Authorization received. Return to Hafi in your terminal to confirm the connection.");
    },
  });
  const authUrl = new URL(`${larkAccountsDomain}/open-apis/authen/v1/index`);
  authUrl.searchParams.set("app_id", requiredEnv("HAFI_LARK_APP_ID"));
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  console.error("Opening your browser to authorize your Lark account.");
  openUrl(authUrl.toString());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      codePromise,
      new Promise<string>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Lark authorization timed out after five minutes.")), 5 * 60_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    server.stop(true);
  }
}

function assertLarkResponse(response: { code?: number; msg?: string }, operation: string): void {
  if (response.code !== undefined && response.code !== 0) {
    throw new Error(`Lark ${operation} failed (${response.code}): ${response.msg ?? "unknown provider error"}`);
  }
}

function parseCursor(value: string): LarkCursor {
  let cursor: unknown;
  try { cursor = JSON.parse(value); } catch { throw new Error("The Lark cursor is invalid; reconnect the account."); }
  if (!cursor || typeof cursor !== "object" || (cursor as LarkCursor).version !== 1 ||
      typeof (cursor as LarkCursor).activationAt !== "number" ||
      typeof (cursor as LarkCursor).lastSuccessAt !== "number" ||
      !(cursor as LarkCursor).chatBaselines || typeof (cursor as LarkCursor).chatBaselines !== "object") {
    throw new Error("The Lark cursor is invalid; reconnect the account.");
  }
  return cursor as LarkCursor;
}

function timestampMs(value: string | undefined): number {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return 0;
  return timestamp < 1_000_000_000_000 ? timestamp * 1_000 : timestamp;
}

function messageText(message: LarkMessage): string {
  const content = message.body?.content ?? "";
  try {
    const value: unknown = JSON.parse(content);
    const parts: string[] = [];
    const visit = (item: unknown): void => {
      if (Array.isArray(item)) item.forEach(visit);
      else if (item && typeof item === "object") {
        const object = item as Record<string, unknown>;
        if (typeof object.text === "string") parts.push(object.text);
        for (const [key, child] of Object.entries(object)) if (key !== "text" && (key === "title" || key === "content" || Array.isArray(child))) visit(child);
      }
    };
    visit(value);
    return parts.join("\n").trim().slice(0, 8_000) || content.slice(0, 8_000);
  } catch {
    return content.slice(0, 8_000);
  }
}

async function listChats(client: lark.Client, accessToken: string): Promise<LarkChat[]> {
  const chats: LarkChat[] = [];
  let pageToken: string | undefined;
  do {
    const response = await client.im.chat.list({
      params: { page_size: 100, page_token: pageToken, sort_type: "ByActiveTimeDesc", types: "p2p,group" },
    }, lark.withUserAccessToken(accessToken));
    assertLarkResponse(response, "user chat discovery");
    chats.push(...(response.data?.items ?? []));
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return chats.filter((chat) => chat.chat_id);
}

async function listChatMessages(
  client: lark.Client,
  accessToken: string,
  chatId: string,
  startAtMs: number,
  endAtMs: number,
): Promise<LarkMessage[]> {
  const messages: LarkMessage[] = [];
  let pageToken: string | undefined;
  do {
    const response = await client.im.message.list({
      params: {
        container_id_type: "chat",
        container_id: chatId,
        start_time: String(Math.max(0, Math.floor(startAtMs / 1_000) - 1)),
        end_time: String(Math.floor(endAtMs / 1_000)),
        sort_type: "ByCreateTimeAsc",
        page_size: 50,
        page_token: pageToken,
        with_sender_name: true,
      },
    }, lark.withUserAccessToken(accessToken));
    assertLarkResponse(response, "message history read");
    messages.push(...((response.data?.items ?? []) as LarkMessage[]));
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return messages;
}

async function getCredentials(account: string): Promise<{ client: lark.Client; credentials: LarkCredentials }> {
  const raw = await readSecret(secretName(account));
  if (!raw) throw new Error(`Lark account '${account}' is not connected; run hafi connect lark.`);
  let credentials: LarkCredentials;
  try { credentials = JSON.parse(raw) as LarkCredentials; }
  catch { throw new Error(`Stored Lark credentials for '${account}' are invalid; reconnect the account.`); }
  if (!credentials.appId || !credentials.appSecret || !credentials.refreshToken || !credentials.openId) throw new Error(`Stored Lark credentials for '${account}' are incomplete; reconnect the account.`);
  const client = newClient(credentials.appId, credentials.appSecret);
  if (credentials.expiresAt <= Date.now() + 60_000) {
    const refreshed = await client.accessToken.refresh({ refreshToken: credentials.refreshToken });
    if (!refreshed.accessToken || !refreshed.refreshToken) throw new Error("Lark token refresh failed; reconnect the account.");
    credentials = {
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: Date.now() + (refreshed.expiresIn ?? 7_200) * 1_000,
      openId: credentials.openId,
    };
    await writeSecret(secretName(account), JSON.stringify(credentials));
  }
  return { client, credentials };
}

/** Complete Lark user OAuth and store its refresh credentials in the OS secret store. */
export async function connectLark(account: string): Promise<{ provider: "lark"; account: string; connected: true }> {
  const appId = requiredEnv("HAFI_LARK_APP_ID");
  const appSecret = requiredEnv("HAFI_LARK_APP_SECRET");
  const redirectUri = requiredEnv("HAFI_LARK_REDIRECT_URI");
  const code = await authorizationCode(redirectUri);
  const client = new lark.Client({ appId, appSecret, domain: larkApiDomain, oauthBaseUrl: larkAccountsDomain });
  const tokens = await client.accessToken.retrieveByAuthorizationCode({ code, redirectUri });
  if (!tokens.accessToken || !tokens.refreshToken) throw new Error("Lark did not return user refresh credentials; check the OAuth app configuration and reconnect.");
  const profile = await client.authen.v1.userInfo.get({}, lark.withUserAccessToken(tokens.accessToken));
  assertLarkResponse(profile, "authorized user lookup");
  const openId = profile.data?.open_id;
  if (!openId) throw new Error("Lark did not return the authorized user's open_id; enable user identity read access in the Lark app and reconnect.");
  await writeSecret(secretName(account), JSON.stringify({
    appId,
    appSecret,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: Date.now() + (tokens.expiresIn ?? 7_200) * 1_000,
    openId,
  } satisfies LarkCredentials));
  return { provider: "lark", account, connected: true };
}

/** Create a user-token Lark source that reads direct and group chats visible to the authorized user. */
export async function createLarkSource(account: string): Promise<InboxSource> {
  const { client, credentials: initialCredentials } = await getCredentials(account);
  let credentials = initialCredentials;
  const chatNames = new Map<string, string>();
  const chatModes = new Map<string, "p2p" | "group" | "topic">();
  const currentAccessToken = async (): Promise<string> => {
    if (credentials.expiresAt <= Date.now() + 60_000) {
      const refreshed = await client.accessToken.refresh({ refreshToken: credentials.refreshToken });
      if (!refreshed.accessToken || !refreshed.refreshToken) throw new Error("Lark token refresh failed; reconnect the account.");
      credentials = {
        appId: credentials.appId,
        appSecret: credentials.appSecret,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: Date.now() + (refreshed.expiresIn ?? 7_200) * 1_000,
        openId: credentials.openId,
      };
      await writeSecret(secretName(account), JSON.stringify(credentials));
    }
    return credentials.accessToken;
  };
  return {
    async fetchNew(cursorValue) {
      const accessToken = await currentAccessToken();
      const now = Date.now();
      const chats = await listChats(client, accessToken);
      chatNames.clear();
      chatModes.clear();
      for (const chat of chats) {
        if (!chat.chat_id) continue;
        if (chat.name) chatNames.set(chat.chat_id, chat.name);
        chatModes.set(chat.chat_id, chat.chat_mode === "p2p" ? "p2p" : chat.chat_mode === "topic" ? "topic" : "group");
      }
      const cursor = cursorValue === null ? null : parseCursor(cursorValue);
      const chatBaselines: Record<string, number> = {};
      if (cursor === null) {
        for (const chat of chats) if (chat.chat_id) chatBaselines[chat.chat_id] = now;
        return { refs: [], nextCursor: JSON.stringify({ version: 1, activationAt: now, lastSuccessAt: now, chatBaselines } satisfies LarkCursor) };
      }
      const refs: MessageRef[] = [];
      for (const chat of chats) {
        const chatId = chat.chat_id;
        if (!chatId) continue;
        const lastSeenAt = cursor.chatBaselines[chatId] ?? cursor.lastSuccessAt;
        const startAt = Math.max(cursor.activationAt, lastSeenAt - 120_000);
        const messages = await listChatMessages(client, accessToken, chatId, startAt, now);
        chatBaselines[chatId] = now;
        for (const message of messages) {
          const receivedAt = timestampMs(message.create_time);
          if (!message.message_id || receivedAt <= cursor.activationAt || message.sender?.id === credentials.openId) continue;
          refs.push({ provider: "lark", account, messageId: message.message_id, conversationId: chatId, receivedAt, chatMode: chatModes.get(chatId) });
        }
      }
      return { refs, nextCursor: JSON.stringify({ version: 1, activationAt: cursor.activationAt, lastSuccessAt: now, chatBaselines } satisfies LarkCursor) };
    },
    async load(ref) {
      if (ref.provider !== "lark" || ref.account !== account) throw new Error("Lark source received a reference for another provider or account.");
      const accessToken = await currentAccessToken();
      const chatId = ref.conversationId;
      const now = Date.now();
      const messages = await listChatMessages(client, accessToken, chatId, ref.receivedAt - 1_000, now);
      const target = messages.find((message) => message.message_id === ref.messageId);
      if (!target) throw new Error(`Lark message ${ref.messageId} is no longer available.`);
      const targetAt = timestampMs(target.create_time) || ref.receivedAt;
      const ordered = messages.sort((a, b) => timestampMs(a.create_time) - timestampMs(b.create_time));
      const contextMessages = ordered.slice(-12);
      const context = contextMessages.map((message) => ({
        sender: message.sender?.sender_name ?? (message.sender?.id === credentials.openId ? "You" : "Lark user"),
        text: messageText(message).slice(0, 1_500),
        receivedAt: timestampMs(message.create_time),
        isOwn: message.sender?.id === credentials.openId,
      }));
      const isDirectChat = (ref.chatMode ?? chatModes.get(chatId)) === "p2p";
      return {
        ref,
        title: chatNames.get(chatId) ?? "Lark conversation",
        sender: target.sender?.sender_name ?? "Lark user",
        text: messageText(target),
        url: `https://www.larksuite.com/client/messenger/${chatId}`,
        isOwn: target.sender?.id === credentials.openId,
        ownerReplied: ordered.some((message) => timestampMs(message.create_time) > targetAt && message.sender?.id === credentials.openId && (isDirectChat ||
          message.parent_id === ref.messageId || message.root_id === ref.messageId ||
          (target.thread_id !== undefined && message.thread_id === target.thread_id) ||
          (target.root_id !== undefined && message.root_id === target.root_id)
        )),
        context,
      };
    },
  };
}
