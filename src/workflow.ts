import { z } from "zod";

const sourceSchema = z.object({
  provider: z.enum(["gmail", "lark"]),
  account: z.string().min(1),
}).strict();

const filterSchema = z.object({
  bot: z.literal("jev"),
  question: z.string().min(1),
  match_at_or_above: z.number().min(0).max(1),
}).strict();

const actionSchema = z.object({
  type: z.literal("save_reply_draft"),
  composer: z.literal("codex"),
  max_words: z.number().int().min(1).max(500),
}).strict();

export const workflowSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  sources: z.array(sourceSchema).min(1),
  schedule: z.object({ every_minutes: z.union([
    z.literal(1), z.literal(2), z.literal(5), z.literal(10),
    z.literal(15), z.literal(30), z.literal(60),
  ]) }).strict(),
  filter: filterSchema,
  actions: z.tuple([actionSchema]),
}).strict().superRefine((workflow, ctx) => {
  const keys = workflow.sources.map((source) => `${source.provider}:${source.account}`);
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({ code: "custom", message: "Duplicate source account", path: ["sources"] });
  }
});

export type Workflow = z.infer<typeof workflowSchema>;
export type SourceConfig = Workflow["sources"][number];
export type FilterConfig = Workflow["filter"];
export type ActionConfig = Workflow["actions"][number];
export type Provider = SourceConfig["provider"];

export type MessageRef = {
  provider: Provider;
  account: string;
  messageId: string;
  conversationId: string;
  receivedAt: number;
  chatMode?: "p2p" | "group" | "topic";
};

export type InboxItem = {
  ref: MessageRef;
  title: string;
  sender: string;
  text: string;
  url?: string;
  isOwn: boolean;
  ownerReplied: boolean;
  context: Array<{ sender: string; text: string; receivedAt: number; isOwn: boolean }>;
};

export type FetchNewResult = { refs: MessageRef[]; nextCursor: string };

export interface InboxSource {
  /** Establish a baseline on null; otherwise fetch every page before returning the next cursor. */
  fetchNew(cursor: string | null): Promise<FetchNewResult>;
  /** Load one message with bounded conversation context and owner-reply state. */
  load(ref: MessageRef): Promise<InboxItem>;
}

/** Parse a local YAML workflow and reject unsupported fields or actions. */
export async function loadWorkflow(path: string): Promise<Workflow> {
  const raw = Bun.YAML.parse(await Bun.file(path).text());
  return workflowSchema.parse(raw);
}

/** Write a starter workflow for the selected connected accounts. */
export async function initWorkflow(path: string, sources: SourceConfig[]): Promise<void> {
  const file = Bun.file(path);
  if (await file.exists()) throw new Error(`Workflow already exists: ${path}`);
  if (!sources.length) throw new Error("Select at least one source");
  const sourceYaml = sources.map(({ provider, account }) => `  - provider: ${provider}\n    account: ${JSON.stringify(account)}`).join("\n");
  const yaml = `version: 1\nid: reply-review\nsources:\n${sourceYaml}\nschedule:\n  every_minutes: 5\nfilter:\n  bot: jev\n  question: "Does this new message need a personal reply from me?"\n  match_at_or_above: 0.7\nactions:\n  - type: save_reply_draft\n    composer: codex\n    max_words: 120\n`;
  await Bun.write(path, yaml);
}
