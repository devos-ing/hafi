import { randomUUID } from "node:crypto";
import { CodeChallengeMethod } from "google-auth-library";
import { google } from "googleapis";
import { readSecret, writeSecret } from "./state";
import type { InboxItem, InboxSource, MessageRef } from "./workflow";

const gmailReadonly = "https://www.googleapis.com/auth/gmail.readonly";
const secretPrefix = "hafi:gmail:";

type GmailCredentials = { refreshToken: string; email: string; clientId: string; clientSecret: string };
type GmailCursor = { version: 1; historyId: string; lastSuccessAt: number };
type GmailMessage = {
  id?: string | null;
  threadId?: string | null;
  internalDate?: string | null;
  labelIds?: string[] | null;
  payload?: GmailPart | null;
};
type GmailPart = {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: GmailPart[] | null;
  headers?: Array<{ name?: string | null; value?: string | null }> | null;
};

function secretName(account: string): string {
  return `${secretPrefix}${encodeURIComponent(account)}`;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before connecting Gmail.`);
  return value;
}

function openUrl(url: string): void {
  try {
    const command = process.platform === "darwin" ? ["open", url]
      : process.platform === "win32" ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url];
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }).unref();
  } catch {
    console.error(`Open this URL to authorize read-only Gmail access:\n${url}`);
  }
}

async function getAuthorizationCode(clientId: string, clientSecret: string): Promise<InstanceType<typeof google.auth.OAuth2>> {
  const state = randomUUID();
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/oauth2callback") return new Response("Not found", { status: 404 });
      if (url.searchParams.get("state") !== state) {
        rejectCode(new Error("Gmail authorization returned an invalid state."));
        return new Response("Authorization state did not match. You can close this tab.", { status: 400 });
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error || !code) {
        rejectCode(new Error(`Gmail authorization failed${error ? `: ${error}` : "."}`));
        return new Response("Authorization failed. You can close this tab.", { status: 400 });
      }
      resolveCode(code);
      return new Response("Gmail connected. You can close this tab.");
    },
  });
  const redirectUri = `http://127.0.0.1:${server.port}/oauth2callback`;
  const oauth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const pkce = await oauth.generateCodeVerifierAsync();
  const url = oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [gmailReadonly],
    state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
  });
  console.error("Opening your browser to authorize read-only Gmail access.");
  openUrl(url);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([
      codePromise,
      new Promise<string>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Gmail authorization timed out after five minutes.")), 5 * 60_000);
      }),
    ]);
    const { tokens } = await oauth.getToken({ code, codeVerifier: pkce.codeVerifier });
    oauth.setCredentials(tokens);
    return oauth;
  } finally {
    if (timer) clearTimeout(timer);
    server.stop(true);
  }
}

function parseCursor(value: string): GmailCursor {
  let cursor: unknown;
  try { cursor = JSON.parse(value); } catch { throw new Error("The Gmail cursor is invalid; reconnect the account."); }
  if (!cursor || typeof cursor !== "object" || (cursor as GmailCursor).version !== 1 ||
      typeof (cursor as GmailCursor).historyId !== "string" || typeof (cursor as GmailCursor).lastSuccessAt !== "number") {
    throw new Error("The Gmail cursor is invalid; reconnect the account.");
  }
  return cursor as GmailCursor;
}

function gmailHeaders(message: GmailMessage): Record<string, string> {
  return Object.fromEntries((message.payload?.headers ?? []).map((header) => [
    (header.name ?? "").toLowerCase(), header.value ?? "",
  ]));
}

function messageRef(account: string, message: GmailMessage): MessageRef | null {
  if (!message.id || !message.threadId || !message.labelIds?.includes("INBOX") || message.labelIds.includes("SENT") || message.labelIds.includes("DRAFT")) return null;
  const dateHeader = gmailHeaders(message).date;
  const receivedAt = Number(message.internalDate) || Date.parse(dateHeader ?? "") || Date.now();
  return { provider: "gmail", account, messageId: message.id, conversationId: message.threadId, receivedAt };
}

async function fetchMessageRefs(gmail: ReturnType<typeof google.gmail>, account: string, ids: Map<string, string>): Promise<MessageRef[]> {
  const refs: MessageRef[] = [];
  for (const [id, threadId] of ids) {
    const response = await gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "Date"] });
    const ref = messageRef(account, { ...response.data, id, threadId: response.data.threadId ?? threadId });
    if (ref) refs.push(ref);
  }
  return refs;
}

function collectAdded(history: Array<{ messagesAdded?: Array<{ message?: { id?: string | null; threadId?: string | null } | null }> | null }> | null | undefined): Map<string, string> {
  const messages = new Map<string, string>();
  for (const item of history ?? []) for (const added of item.messagesAdded ?? []) {
    const id = added.message?.id;
    const threadId = added.message?.threadId;
    if (id && threadId) messages.set(id, threadId);
  }
  return messages;
}

function messageText(message: GmailMessage): string {
  const parts = message.payload ? flattenParts(message.payload) : [];
  const plain = parts.find((part) => part.type === "text/plain")?.text;
  const html = parts.find((part) => part.type === "text/html")?.text;
  return (plain ?? (html ? html.replace(/<\/(p|div|li|br|h[1-6])\s*>/gi, "\n").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") : "")).trim().slice(0, 8_000);
}

function flattenParts(part: GmailPart): Array<{ type: string; text: string }> {
  const own = part.body?.data ? [{ type: part.mimeType ?? "", text: Buffer.from(part.body.data, "base64url").toString("utf8") }] : [];
  return [...own, ...(part.parts ?? []).flatMap(flattenParts)];
}

function senderIsOwner(from: string, email: string): boolean {
  const addresses = [...from.matchAll(/<([^>]+)>/g)].map((match) => match[1]);
  if (!addresses.length) addresses.push(from.trim());
  return addresses.some((address) => address.toLowerCase() === email.toLowerCase());
}

function isGmailOwner(message: GmailMessage, email: string): boolean {
  return message.labelIds?.includes("SENT") === true || senderIsOwner(gmailHeaders(message).from ?? "", email);
}

function asInboxItem(account: string, email: string, ref: MessageRef, messages: GmailMessage[]): InboxItem {
  const ordered = messages.slice().sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));
  const target = ordered.find((message) => message.id === ref.messageId);
  if (!target) throw new Error(`Gmail message ${ref.messageId} is no longer available.`);
  const context = ordered.slice(-12).map((message) => {
    const headers = gmailHeaders(message);
    const isOwn = isGmailOwner(message, email);
    return {
      sender: headers.from || (isOwn ? email : "Unknown sender"),
      text: messageText(message).slice(0, 1_500),
      receivedAt: Number(message.internalDate) || Date.now(),
      isOwn,
    };
  });
  const headers = gmailHeaders(target);
  const isOwn = isGmailOwner(target, email);
  return {
    ref,
    title: headers.subject || "(no subject)",
    sender: headers.from || "Unknown sender",
    text: messageText(target),
    url: `https://mail.google.com/mail/u/0/#all/${ref.conversationId}`,
    isOwn,
    ownerReplied: ordered.some((message) => Number(message.internalDate ?? 0) > ref.receivedAt && isGmailOwner(message, email)),
    context,
  };
}

/** Complete read-only Gmail OAuth for an account alias and store its refresh token in the OS secret store. */
export async function connectGmail(account: string): Promise<{ provider: "gmail"; account: string; connected: true }> {
  const clientId = requiredEnv("HAFI_GMAIL_CLIENT_ID");
  const clientSecret = requiredEnv("HAFI_GMAIL_CLIENT_SECRET");
  const oauth = await getAuthorizationCode(clientId, clientSecret);
  const gmail = google.gmail({ version: "v1", auth: oauth });
  const profile = (await gmail.users.getProfile({ userId: "me" })).data;
  if (!profile.emailAddress) throw new Error("Gmail did not return the authorized account address.");
  const refreshToken = oauth.credentials.refresh_token;
  if (!refreshToken) throw new Error("Gmail did not return a refresh token. Revoke Hafi's access and connect again.");
  await writeSecret(secretName(account), JSON.stringify({ refreshToken, email: profile.emailAddress, clientId, clientSecret } satisfies GmailCredentials));
  return { provider: "gmail", account, connected: true };
}

/** Create a read-only Gmail source that baselines history and reads bounded thread context. */
export async function createGmailSource(account: string): Promise<InboxSource> {
  const raw = await readSecret(secretName(account));
  if (!raw) throw new Error(`Gmail account '${account}' is not connected; run hafi connect gmail.`);
  const credentials = JSON.parse(raw) as GmailCredentials;
  if (!credentials.refreshToken || !credentials.email || !credentials.clientId || !credentials.clientSecret) throw new Error(`Stored Gmail credentials for '${account}' are invalid; reconnect the account.`);
  const oauth = new google.auth.OAuth2(credentials.clientId, credentials.clientSecret);
  oauth.setCredentials({ refresh_token: credentials.refreshToken });
  let pendingSecretWrite = Promise.resolve();
  oauth.on("tokens", (tokens) => {
    if (tokens.refresh_token) {
      const refreshToken = tokens.refresh_token;
      pendingSecretWrite = pendingSecretWrite.then(() => writeSecret(secretName(account), JSON.stringify({ ...credentials, refreshToken } satisfies GmailCredentials)));
    }
  });
  const gmail = google.gmail({ version: "v1", auth: oauth });
  return {
    async fetchNew(cursor) {
      try {
      if (cursor === null) {
        const profile = (await gmail.users.getProfile({ userId: "me" })).data;
        if (!profile.historyId) throw new Error("Gmail returned no history ID for the initial baseline.");
        return { refs: [], nextCursor: JSON.stringify({ version: 1, historyId: profile.historyId, lastSuccessAt: Date.now() } satisfies GmailCursor) };
      }
      const previous = parseCursor(cursor);
      const ids = new Map<string, string>();
      let historyId = previous.historyId;
      try {
        let pageToken: string | undefined;
        do {
          const response = await gmail.users.history.list({ userId: "me", startHistoryId: previous.historyId, historyTypes: ["messageAdded"], maxResults: 500, pageToken });
          const data = response.data;
          for (const [id, threadId] of collectAdded(data.history)) ids.set(id, threadId);
          historyId = data.historyId ?? historyId;
          pageToken = data.nextPageToken ?? undefined;
        } while (pageToken);
      } catch (error) {
        const status = (error as { code?: number; status?: number }).code ?? (error as { status?: number }).status;
        if (status !== 404) throw error;
        const profile = (await gmail.users.getProfile({ userId: "me" })).data;
        if (!profile.historyId) throw new Error("Gmail returned no history ID after its history cursor expired.");
        historyId = profile.historyId;
        let pageToken: string | undefined;
        do {
          const response = await gmail.users.messages.list({
            userId: "me",
            maxResults: 500,
            pageToken,
            q: `after:${Math.floor((previous.lastSuccessAt - 120_000) / 1_000)}`,
          });
          for (const message of response.data.messages ?? []) if (message.id && message.threadId) ids.set(message.id, message.threadId);
          pageToken = response.data.nextPageToken ?? undefined;
        } while (pageToken);
      }
      const refs = await fetchMessageRefs(gmail, account, ids);
      return { refs, nextCursor: JSON.stringify({ version: 1, historyId, lastSuccessAt: Date.now() } satisfies GmailCursor) };
      } finally {
        await pendingSecretWrite;
      }
    },
    async load(ref) {
      try {
      if (ref.provider !== "gmail" || ref.account !== account) throw new Error("Gmail source received a reference for another provider or account.");
      const response = await gmail.users.threads.get({ userId: "me", id: ref.conversationId, format: "full" });
      return asInboxItem(account, credentials.email, ref, (response.data.messages ?? []) as GmailMessage[]);
      } finally {
        await pendingSecretWrite;
      }
    },
  };
}
