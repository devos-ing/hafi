import { describe, expect, test } from "bun:test";
import { workflowSchema } from "../src/workflow";

const valid = {
  version: 1,
  id: "reply-review",
  sources: [{ provider: "gmail", account: "personal" }],
  schedule: { every_minutes: 5 },
  filter: { bot: "jev", question: "Does this need me?", match_at_or_above: 0.7 },
  actions: [{ type: "save_reply_draft", composer: "codex", max_words: 120 }],
};

describe("workflow v1", () => {
  test("accepts the first reply workflow and rejects unsafe extensions", () => {
    expect(workflowSchema.safeParse(valid).success).toBe(true);
    expect(workflowSchema.safeParse({ ...valid, actions: [{ type: "shell", command: "echo hi" }] }).success).toBe(false);
    expect(workflowSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
    expect(workflowSchema.safeParse({ ...valid, sources: [valid.sources[0], valid.sources[0]] }).success).toBe(false);
    expect(workflowSchema.safeParse({ ...valid, schedule: { every_minutes: 7 } }).success).toBe(false);
  });
});
