import { Database } from "bun:sqlite";
import { closeSync, chmodSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ActionConfig,
  FetchNewResult,
  FilterConfig,
  InboxItem,
  MessageRef,
  SourceConfig,
  Workflow,
} from "./workflow";

const SECRET_SERVICE = "hafi";
const LEASE_MS = 30_000;
const LEASE_RENEW_MS = 10_000;
const RESULT_LIMIT = 100;

export type WorkStatus = "queued" | "retry" | "done" | "skipped";

/** A queued message keeps the workflow revision and decisions that were active when it arrived. */
export type WorkItem = {
  id: number;
  workflowId: string;
  revision: string;
  ref: MessageRef;
  filter: FilterConfig;
  action: ActionConfig;
  attempts: number;
  status: WorkStatus;
  lastErrorCode: string | null;
};

/** The Jev decision persisted alongside a completed draft. */
export type Decision = { probability: number; modelVersion: string };

/** The locally saved draft returned by the selected composer. */
export type Draft = { text: string; unresolvedFacts: string[] };

/** Counts and timestamps for one completed workflow run. */
export type RunSummary = {
  startedAt: number;
  finishedAt: number;
  queued: number;
  processed: number;
  matched: number;
  drafted: number;
  skipped: number;
  failed: number;
  errorCode?: string;
};

/** A local review result includes the source message and the decision used to create its draft. */
export type DraftResultRecord = {
  id: number;
  workflowId: string;
  revision: string;
  refs: MessageRef[];
  item: InboxItem;
  decision: Decision;
  draft: Draft;
  createdAt: number;
};

/** The counters and most recent run shown by `hafi status`. */
export type WorkflowStatus = {
  workflowId: string;
  queued: number;
  retry: number;
  completed: number;
  skipped: number;
  lastRun: RunSummary | null;
  lastSuccess: number | null;
  lastErrorCode: string | null;
};

/** The state contract used by the workflow runner and read-only CLI commands. */
export interface State {
  /** Read the last committed cursor for one workflow and connected account. */
  getCursor(workflowId: string, source: SourceConfig): string | null;
  /** Queue new message IDs and advance their account cursor in one transaction. */
  queueAndAdvance(workflow: Workflow, revision: string, source: SourceConfig, batch: FetchNewResult): number;
  /** Return retryable work for one workflow, oldest first. */
  dueWork(workflowId: string): WorkItem[];
  /** Save one conversation draft and complete all included message IDs atomically. */
  saveDraftResult(work: readonly WorkItem[], item: InboxItem, decision: Decision, draft: Draft): void;
  /** Mark all IDs in one conversation group skipped atomically. */
  skipWork(work: readonly WorkItem[], reason: string): void;
  /** Keep a conversation group retryable and record a safe error code. */
  retryWork(work: readonly WorkItem[], errorCode: string): void;
  /** Return workflow counts, recent run health, and the latest safe error code. */
  status(workflowId: string): WorkflowStatus;
  /** Return the most recent local drafts for review. */
  results(workflowId: string): DraftResultRecord[];
  /** Record one run summary without storing provider message bodies or secrets. */
  recordRun(workflowId: string, summary: RunSummary): void;
  /** Run the callback under a renewed per-workflow lease, or return null when another process owns it. */
  withRunLease<T>(workflowId: string, fn: () => Promise<T>): Promise<T | null>;
  /** Close the SQLite connection. */
  close(): void;
}

type Lease = { owner: string; fence: number };

/** Open the private SQLite database used for cursors, work, results, and run leases. */
export function openState(dataDir = join(homedir(), ".local", "share", "hafi")): State {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const dbPath = join(dataDir, "state.sqlite");
  const fd = openSync(dbPath, "a", 0o600);
  closeSync(fd);
  chmodSync(dbPath, 0o600);

  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS cursors (
      workflow_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      account TEXT NOT NULL,
      cursor TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workflow_id, provider, account)
    );
    CREATE TABLE IF NOT EXISTS work_items (
      id INTEGER PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      account TEXT NOT NULL,
      message_id TEXT NOT NULL,
      ref_json TEXT NOT NULL,
      revision TEXT NOT NULL,
      filter_json TEXT NOT NULL,
      action_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'retry', 'done', 'skipped')),
      attempts INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      skip_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (workflow_id, provider, account, message_id)
    );
    CREATE INDEX IF NOT EXISTS work_due ON work_items(workflow_id, status, created_at, id);
    CREATE TABLE IF NOT EXISTS draft_results (
      id INTEGER PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      revision TEXT NOT NULL,
      refs_json TEXT NOT NULL,
      item_json TEXT NOT NULL,
      decision_json TEXT NOT NULL,
      draft_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS draft_result_work (
      work_id INTEGER PRIMARY KEY REFERENCES work_items(id),
      result_id INTEGER NOT NULL REFERENCES draft_results(id)
    );
    CREATE INDEX IF NOT EXISTS draft_results_recent ON draft_results(workflow_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS run_history (
      id INTEGER PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL,
      successful INTEGER NOT NULL,
      error_code TEXT,
      summary_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS run_history_recent ON run_history(workflow_id, finished_at DESC);
    CREATE TABLE IF NOT EXISTS run_leases (
      workflow_id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      fence INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);

  const activeLeases = new Map<string, Lease>();

  function assertLease(workflowId: string): void {
    const lease = activeLeases.get(workflowId);
    if (!lease) throw new Error(`Workflow ${workflowId} has no active run lease`);
    const row = db.query<{ owner: string; fence: number; expires_at: number }, [string]>(
      "SELECT owner, fence, expires_at FROM run_leases WHERE workflow_id = ?",
    ).get(workflowId);
    if (!row || row.owner !== lease.owner || row.fence !== lease.fence || row.expires_at <= Date.now()) {
      throw new Error(`Run lease lost for workflow ${workflowId}`);
    }
  }

  function toWorkItem(row: {
    id: number;
    workflow_id: string;
    revision: string;
    ref_json: string;
    filter_json: string;
    action_json: string;
    attempts: number;
    status: WorkStatus;
    error_code: string | null;
  }): WorkItem {
    return {
      id: row.id,
      workflowId: row.workflow_id,
      revision: row.revision,
      ref: JSON.parse(row.ref_json) as MessageRef,
      filter: JSON.parse(row.filter_json) as FilterConfig,
      action: JSON.parse(row.action_json) as ActionConfig,
      attempts: row.attempts,
      status: row.status,
      lastErrorCode: row.error_code,
    };
  }

  const queueBatch = db.transaction((workflow: Workflow, revision: string, source: SourceConfig, batch: FetchNewResult) => {
    assertLease(workflow.id);
    const now = Date.now();
    const insert = db.query(`
      INSERT OR IGNORE INTO work_items (
        workflow_id, provider, account, message_id, ref_json, revision,
        filter_json, action_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
    `);
    let queued = 0;
    for (const ref of batch.refs) {
      if (ref.provider !== source.provider || ref.account !== source.account || !ref.messageId) {
        throw new Error("Fetched message does not match its configured source");
      }
      const result = insert.run(
        workflow.id,
        source.provider,
        source.account,
        ref.messageId,
        JSON.stringify(ref),
        revision,
        JSON.stringify(workflow.filter),
        JSON.stringify(workflow.actions[0]),
        now,
        now,
      );
      queued += Number(result.changes);
    }
    db.query(`
      INSERT INTO cursors (workflow_id, provider, account, cursor, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (workflow_id, provider, account)
      DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at
    `).run(workflow.id, source.provider, source.account, batch.nextCursor, now);
    return queued;
  });

  const saveGroup = db.transaction((work: readonly WorkItem[], item: InboxItem, decision: Decision, draft: Draft) => {
    const workflowId = validateGroup(work);
    assertLease(workflowId);
    const ids = work.map(({ id }) => id);
    const rows = db.query<{ id: number; status: WorkStatus }, [string, ...number[]]>(
      `SELECT id, status FROM work_items WHERE workflow_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
    ).all(workflowId, ...ids);
    if (rows.length !== ids.length) throw new Error("Work group contains an unknown item");
    if (rows.every(({ status }) => status === "done")) return;
    if (rows.some(({ status }) => status !== "queued" && status !== "retry")) {
      throw new Error("Work group is no longer retryable");
    }
    const result = db.query(`
      INSERT INTO draft_results (workflow_id, revision, refs_json, item_json, decision_json, draft_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      workflowId,
      work[0]!.revision,
      JSON.stringify(work.map(({ ref }) => ref)),
      JSON.stringify(item),
      JSON.stringify(decision),
      JSON.stringify(draft),
      Date.now(),
    );
    const resultId = Number(result.lastInsertRowid);
    const link = db.query("INSERT INTO draft_result_work (work_id, result_id) VALUES (?, ?)");
    const finish = db.query(`UPDATE work_items SET status = 'done', error_code = NULL, updated_at = ? WHERE id = ? AND status IN ('queued', 'retry')`);
    for (const entry of work) {
      finish.run(Date.now(), entry.id);
      link.run(entry.id, resultId);
    }
  });

  const skipGroup = db.transaction((work: readonly WorkItem[], reason: string) => {
    const workflowId = validateGroup(work);
    assertLease(workflowId);
    const skip = db.query(`UPDATE work_items SET status = 'skipped', skip_reason = ?, error_code = NULL, updated_at = ? WHERE id = ? AND status IN ('queued', 'retry')`);
    const now = Date.now();
    for (const entry of work) skip.run(reason.slice(0, 500), now, entry.id);
  });

  const retryGroup = db.transaction((work: readonly WorkItem[], errorCode: string) => {
    const workflowId = validateGroup(work);
    assertLease(workflowId);
    const retry = db.query(`UPDATE work_items SET status = 'retry', attempts = attempts + 1, error_code = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'retry')`);
    const now = Date.now();
    const safeCode = errorCode.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80) || "UNKNOWN";
    for (const entry of work) retry.run(safeCode, now, entry.id);
  });

  const record = db.transaction((workflowId: string, summary: RunSummary) => {
    assertLease(workflowId);
    const errorCode = summary.errorCode?.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80) ?? null;
    db.query(`
      INSERT INTO run_history (workflow_id, started_at, finished_at, successful, error_code, summary_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(workflowId, summary.startedAt, summary.finishedAt, Number(summary.failed === 0 && !errorCode), errorCode, JSON.stringify(summary));
  });

  return {
    getCursor(workflowId, source) {
      const row = db.query<{ cursor: string }, [string, string, string]>(
        "SELECT cursor FROM cursors WHERE workflow_id = ? AND provider = ? AND account = ?",
      ).get(workflowId, source.provider, source.account);
      return row?.cursor ?? null;
    },
    queueAndAdvance(workflow, revision, source, batch) {
      return queueBatch(workflow, revision, source, batch);
    },
    dueWork(workflowId) {
      const rows = db.query<{
        id: number;
        workflow_id: string;
        revision: string;
        ref_json: string;
        filter_json: string;
        action_json: string;
        attempts: number;
        status: WorkStatus;
        error_code: string | null;
      }, [string]>(`
        SELECT id, workflow_id, revision, ref_json, filter_json, action_json, attempts, status, error_code
        FROM work_items WHERE workflow_id = ? AND status IN ('queued', 'retry') ORDER BY created_at, id
      `).all(workflowId);
      return rows.map(toWorkItem);
    },
    saveDraftResult(work, item, decision, draft) {
      saveGroup(work, item, decision, draft);
    },
    skipWork(work, reason) {
      skipGroup(work, reason);
    },
    retryWork(work, errorCode) {
      retryGroup(work, errorCode);
    },
    status(workflowId) {
      const counts = db.query<{ status: WorkStatus; count: number }, [string]>(
        "SELECT status, COUNT(*) AS count FROM work_items WHERE workflow_id = ? GROUP BY status",
      ).all(workflowId);
      const byStatus = new Map(counts.map((row) => [row.status, Number(row.count)]));
      const latest = db.query<{ summary_json: string; error_code: string | null; finished_at: number }, [string]>(
        "SELECT summary_json, error_code, finished_at FROM run_history WHERE workflow_id = ? ORDER BY finished_at DESC, id DESC LIMIT 1",
      ).get(workflowId);
      const success = db.query<{ finished_at: number }, [string]>(
        "SELECT MAX(finished_at) AS finished_at FROM run_history WHERE workflow_id = ? AND successful = 1",
      ).get(workflowId);
      const latestWorkError = db.query<{ error_code: string | null }, [string]>(
        "SELECT error_code FROM work_items WHERE workflow_id = ? AND error_code IS NOT NULL ORDER BY updated_at DESC, id DESC LIMIT 1",
      ).get(workflowId)?.error_code ?? null;
      return {
        workflowId,
        queued: byStatus.get("queued") ?? 0,
        retry: byStatus.get("retry") ?? 0,
        completed: byStatus.get("done") ?? 0,
        skipped: byStatus.get("skipped") ?? 0,
        lastRun: latest ? JSON.parse(latest.summary_json) as RunSummary : null,
        lastSuccess: success?.finished_at ?? null,
        lastErrorCode: latest?.error_code ?? latestWorkError,
      };
    },
    results(workflowId) {
      const rows = db.query<{
        id: number;
        workflow_id: string;
        revision: string;
        refs_json: string;
        item_json: string;
        decision_json: string;
        draft_json: string;
        created_at: number;
      }, [string]>(`
        SELECT id, workflow_id, revision, refs_json, item_json, decision_json, draft_json, created_at
        FROM draft_results WHERE workflow_id = ? ORDER BY created_at DESC, id DESC LIMIT ${RESULT_LIMIT}
      `).all(workflowId);
      return rows.map((row) => ({
        id: row.id,
        workflowId: row.workflow_id,
        revision: row.revision,
        refs: JSON.parse(row.refs_json) as MessageRef[],
        item: JSON.parse(row.item_json) as InboxItem,
        decision: JSON.parse(row.decision_json) as Decision,
        draft: JSON.parse(row.draft_json) as Draft,
        createdAt: row.created_at,
      }));
    },
    recordRun(workflowId, summary) {
      record(workflowId, summary);
    },
    async withRunLease<T>(workflowId: string, fn: () => Promise<T>): Promise<T | null> {
      const owner = crypto.randomUUID();
      const acquire = db.transaction(() => {
        const now = Date.now();
        const current = db.query<{ fence: number; expires_at: number }, [string]>(
          "SELECT fence, expires_at FROM run_leases WHERE workflow_id = ?",
        ).get(workflowId);
        if (current && current.expires_at > now) return null;
        const fence = (current?.fence ?? 0) + 1;
        db.query(`
          INSERT INTO run_leases (workflow_id, owner, fence, expires_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(workflow_id) DO UPDATE SET owner = excluded.owner, fence = excluded.fence, expires_at = excluded.expires_at
        `).run(workflowId, owner, fence, now + LEASE_MS);
        return { owner, fence };
      });
      const lease = acquire.immediate();
      if (!lease) return null;
      activeLeases.set(workflowId, lease);
      let lost = false;
      const timer = setInterval(() => {
        try {
          const result = db.query(`
            UPDATE run_leases SET expires_at = ? WHERE workflow_id = ? AND owner = ? AND fence = ? AND expires_at > ?
          `).run(Date.now() + LEASE_MS, workflowId, lease.owner, lease.fence, Date.now());
          if (!Number(result.changes)) lost = true;
        } catch {
          lost = true;
        }
      }, LEASE_RENEW_MS);
      try {
        const result = await fn();
        if (lost) throw new Error(`Run lease lost for workflow ${workflowId}`);
        assertLease(workflowId);
        return result;
      } finally {
        clearInterval(timer);
        activeLeases.delete(workflowId);
        db.query("DELETE FROM run_leases WHERE workflow_id = ? AND owner = ? AND fence = ?")
          .run(workflowId, lease.owner, lease.fence);
      }
    },
    close() {
      db.close();
    },
  } satisfies State;
}

/** Read a credential from Bun's operating-system credential store without exposing it in logs. */
export async function readSecret(name: string): Promise<string | null> {
  return Bun.secrets.get({ service: SECRET_SERVICE, name });
}

/** Store a credential in Bun's operating-system credential store without writing it to disk. */
export async function writeSecret(name: string, value: string): Promise<void> {
  if (!name || !value) throw new Error("Secret name and value are required");
  await Bun.secrets.set({ service: SECRET_SERVICE, name, value });
}

function validateGroup(work: readonly WorkItem[]): string {
  if (work.length === 0) throw new Error("Cannot update an empty work group");
  const workflowId = work[0]!.workflowId;
  const revision = work[0]!.revision;
  if (work.some((entry) => entry.workflowId !== workflowId || entry.revision !== revision)) {
    throw new Error("Work group must share one workflow revision");
  }
  return workflowId;
}
