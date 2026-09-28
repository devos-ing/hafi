import { createHash } from "node:crypto";
import { createGmailSource } from "./gmail";
import { createLarkSource } from "./lark";
import { evaluateWithJev } from "./jev";
import { executeAction } from "./actions";
import { openState, type RunSummary, type WorkItem } from "./state";
import { loadWorkflow, type InboxSource, type MessageRef, type SourceConfig } from "./workflow";

const sourceKey = (source: SourceConfig) => `${source.provider}:${source.account}`;

/** Construct the adapter selected by one workflow source. */
async function createSource(source: SourceConfig): Promise<InboxSource> {
  return source.provider === "gmail"
    ? createGmailSource(source.account)
    : createLarkSource(source.account);
}

/** Keep only the newest new message in each conversation for a dry run. */
function latestRefs(refs: MessageRef[]): MessageRef[] {
  const latest = new Map<string, MessageRef>();
  for (const ref of refs) {
    const key = JSON.stringify([ref.provider, ref.account, ref.conversationId]);
    if ((latest.get(key)?.receivedAt ?? -1) < ref.receivedAt) latest.set(key, ref);
  }
  return [...latest.values()];
}

/** Group queued refs under the same source, conversation, and workflow revision. */
function workGroups(work: WorkItem[]): WorkItem[][] {
  const groups = new Map<string, WorkItem[]>();
  for (const row of work) {
    const key = JSON.stringify([row.revision, row.ref.provider, row.ref.account, row.ref.conversationId]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Read new messages, run the selected workflow action, and save a local result. */
export async function runOnce(path: string, options: { dryRun?: boolean } = {}): Promise<Record<string, unknown>> {
  const workflow = await loadWorkflow(path);
  const revision = createHash("sha256").update(JSON.stringify(workflow)).digest("hex");
  const state = openState();
  const sources = new Map<string, InboxSource>();
  const getSource = async (config: SourceConfig) => {
    const key = sourceKey(config);
    let source = sources.get(key);
    if (!source) {
      source = await createSource(config);
      sources.set(key, source);
    }
    return source;
  };

  try {
    if (options.dryRun) {
      const previews: Array<{ provider: string; account: string; messageId: string; probability: number; needsReply: boolean }> = [];
      for (const config of workflow.sources) {
        const source = await getSource(config);
        const batch = await source.fetchNew(state.getCursor(workflow.id, config));
        for (const ref of latestRefs(batch.refs)) {
          const item = await source.load(ref);
          if (item.isOwn || item.ownerReplied) continue;
          const decision = await evaluateWithJev(item, workflow.filter);
          previews.push({ provider: ref.provider, account: ref.account, messageId: ref.messageId, probability: decision.probability, needsReply: decision.probability >= workflow.filter.match_at_or_above });
        }
      }
      return { ok: true, workflow: workflow.id, dryRun: true, previews, cursorAdvanced: false, draftsSaved: 0 };
    }

    const result = await state.withRunLease(workflow.id, async () => {
      const summary: RunSummary = { startedAt: Date.now(), finishedAt: 0, queued: 0, processed: 0, matched: 0, drafted: 0, skipped: 0, failed: 0 };
      try {
        for (const config of workflow.sources) {
          try {
            const source = await getSource(config);
            const batch = await source.fetchNew(state.getCursor(workflow.id, config));
            summary.queued += state.queueAndAdvance(workflow, revision, config, batch);
          } catch {
            summary.failed++;
            summary.errorCode = "SOURCE_FAILED";
          }
        }
        for (const group of workGroups(state.dueWork(workflow.id))) {
          const latest = group.reduce((a, b) => a.ref.receivedAt >= b.ref.receivedAt ? a : b);
          summary.processed += group.length;
          let stage = "SOURCE_FAILED";
          try {
            const source = await getSource(latest.ref);
            const item = await source.load(latest.ref);
            if (item.isOwn || item.ownerReplied) {
              state.skipWork(group, item.isOwn ? "own-message" : "owner-replied");
              summary.skipped += group.length;
              continue;
            }
            stage = "JEV_FAILED";
            const decision = await evaluateWithJev(item, latest.filter);
            if (decision.probability < latest.filter.match_at_or_above) {
              state.skipWork(group, "below-threshold");
              summary.skipped += group.length;
              continue;
            }
            summary.matched++;
            stage = "ACTION_FAILED";
            const draft = await executeAction(item, latest.action);
            state.saveDraftResult(group, item, decision, draft);
            summary.drafted++;
          } catch {
            state.retryWork(group, stage);
            summary.failed += group.length;
            summary.errorCode = stage;
          }
        }
      } finally {
        summary.finishedAt = Date.now();
        state.recordRun(workflow.id, summary);
      }
      return { ok: summary.failed === 0, workflow: workflow.id, ...summary };
    });
    return result ?? { ok: false, workflow: workflow.id, busy: true, code: "RUN_BUSY" };
  } finally {
    state.close();
  }
}
