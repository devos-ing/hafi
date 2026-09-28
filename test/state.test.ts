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
