import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openState, type RunSummary } from "../src/state";
import type { InboxItem, SourceConfig, Workflow } from "../src/workflow";

test("queues cursors atomically and saves one result under an exclusive run lease", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hafi-state-test-"));
  const state = openState(dataDir);
  const otherState = openState(dataDir);
  const source: SourceConfig = { provider: "gmail", account: "primary" };
  const workflow: Workflow = {
    version: 1,
    id: "reply-review",
    sources: [source],
    schedule: { every_minutes: 5 },
    filter: { bot: "jev", question: "Needs my personal reply?", match_at_or_above: 0.7 },
    actions: [{ type: "save_reply_draft", composer: "codex", max_words: 120 }],
  };
  const ref = {
    provider: "gmail" as const,
    account: "primary",
    messageId: "message-1",
    conversationId: "thread-1",
    receivedAt: 10,
  };
  const item: InboxItem = {
    ref,
    title: "Question",
    sender: "Pat",
    text: "Can you help?",
    isOwn: false,
    ownerReplied: false,
    context: [],
  };
  const summary: RunSummary = {
    startedAt: 20,
    finishedAt: 21,
    queued: 1,
    processed: 1,
    matched: 1,
    drafted: 1,
    skipped: 0,
    failed: 0,
  };

  try {
    const result = await state.withRunLease(workflow.id, async () => {
      expect(await otherState.withRunLease(workflow.id, async () => "unexpected")).toBeNull();
      expect(state.queueAndAdvance(workflow, "rev-1", source, { refs: [ref], nextCursor: "cursor-1" })).toBe(1);
      expect(state.queueAndAdvance(workflow, "rev-1", source, { refs: [ref], nextCursor: "cursor-2" })).toBe(0);
      expect(state.getCursor(workflow.id, source)).toBe("cursor-2");
      const work = state.dueWork(workflow.id);
      expect(work).toHaveLength(1);
      expect(work[0]?.filter).toEqual(workflow.filter);
      expect(work[0]?.action).toEqual(workflow.actions[0]);

      state.saveDraftResult(work, item, { probability: 0.91, modelVersion: "jev-1.13.0" }, {
        text: "Sure, I can help.",
        unresolvedFacts: [],
      });
      state.saveDraftResult(work, item, { probability: 0.91, modelVersion: "jev-1.13.0" }, {
        text: "Sure, I can help.",
        unresolvedFacts: [],
      });
      state.recordRun(workflow.id, summary);
      return state.results(workflow.id);
    });

    expect(result).toHaveLength(1);
    expect(state.status(workflow.id)).toMatchObject({
      queued: 0,
      retry: 0,
      completed: 1,
      skipped: 0,
      lastSuccess: summary.finishedAt,
    });
  } finally {
    otherState.close();
    state.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("summary separates current work from lifetime outcomes and handles empty state", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hafi-summary-test-"));
  const state = openState(dataDir);
  const source: SourceConfig = { provider: "gmail", account: "primary" };
  const workflow: Workflow = {
    version: 1,
    id: "reply-review",
    sources: [source],
    schedule: { every_minutes: 5 },
    filter: { bot: "jev", question: "Needs my personal reply?", match_at_or_above: 0.7 },
    actions: [{ type: "save_reply_draft", composer: "codex", max_words: 120 }],
  };

  try {
    expect(state.summary(workflow.id)).toMatchObject({
      latestRun: null,
      lastSuccess: null,
      current: { queued: 0, retry: 0, retryByError: [] },
      lifetime: { workItems: 0, completed: 0, skipped: 0, skippedByReason: [], drafts: 0 },
      recentOutcomes: [],
    });

    const refs = ["done", "skipped", "retry", "queued"].map((messageId, receivedAt) => ({
      provider: "gmail" as const,
      account: "primary",
      messageId,
      conversationId: `thread-${messageId}`,
      receivedAt,
    }));
    const item: InboxItem = {
      ref: refs[0]!, title: "Question", sender: "Pat", text: "Can you help?",
      isOwn: false, ownerReplied: false, context: [],
    };
    const goodRun: RunSummary = {
      startedAt: 20, finishedAt: 21, queued: 1, processed: 1, matched: 1,
      drafted: 1, skipped: 0, failed: 0,
    };
    const failedRun: RunSummary = {
      startedAt: 30, finishedAt: 31, queued: 0, processed: 0, matched: 0,
      drafted: 0, skipped: 0, failed: 1, errorCode: "SOURCE_UNAVAILABLE",
    };

    await state.withRunLease(workflow.id, async () => {
      state.queueAndAdvance(workflow, "rev-1", source, { refs, nextCursor: "cursor-1" });
      const work = state.dueWork(workflow.id);
      const byMessage = (messageId: string) => work.filter(({ ref }) => ref.messageId === messageId);
      state.saveDraftResult(byMessage("done"), item, { probability: 0.91, modelVersion: "jev-1" }, {
        text: "Sure, I can help.", unresolvedFacts: [],
      });
      state.skipWork(byMessage("skipped"), "below-threshold");
      state.retryWork(byMessage("retry"), "CODEX_TIMEOUT");
      state.recordRun(workflow.id, goodRun);
      state.recordRun(workflow.id, failedRun);
    });

    const summary = state.summary(workflow.id);
    expect(summary.latestRun).toMatchObject({ ...failedRun, successful: false });
    expect(summary.lastSuccess).toBe(goodRun.finishedAt);
    expect(summary.current).toEqual({
      queued: 1,
      retry: 1,
      retryByError: [{ errorCode: "CODEX_TIMEOUT", count: 1 }],
    });
    expect(summary.lifetime).toEqual({
      workItems: 4,
      completed: 1,
      skipped: 1,
      skippedByReason: [{ reason: "below-threshold", count: 1 }],
      drafts: 1,
    });
    expect(summary.recentOutcomes).toHaveLength(4);
    expect(summary.recentOutcomes.map(({ messageId, status }) => [messageId, status])).toEqual(expect.arrayContaining([
      ["done", "done"], ["skipped", "skipped"], ["retry", "retry"], ["queued", "queued"],
    ]));
    expect(summary.recentOutcomes.every(({ conversationId, updatedAt }) => conversationId.startsWith("thread-") && updatedAt > 0)).toBe(true);
  } finally {
    state.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
