import { randomUUID } from "node:crypto";
import type { JobState, JobView, QueueStats } from "@pas/shared";
import { type Db, transaction } from "./db";

export interface JobInput {
  [key: string]: unknown;
}

export interface JobRecord {
  id: string;
  task: string;
  input: JobInput;
  createdAt: string;
  visibleAt: number;
  totalTried: number;
  completedAt: string | null;
  hasError: boolean;
  lastError: string | null;
}

interface JobRow {
  id: string;
  task: string;
  input: string;
  created_at: string;
  visible_at: number;
  total_tried: number;
  completed_at: string | null;
  has_error: number;
  last_error: string | null;
}

export interface FailOptions {
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  permanent?: boolean;
}

export type FailResult = "retry" | "dlq";

/**
 * Kolejka leży w tej samej bazie co rezerwacje. Dzięki temu zakup i enqueue
 * joba są jedną transakcją — job nie zginie i nie zdubluje się przy zakupie.
 */
export class JobQueue {
  constructor(
    private readonly db: Db,
    private readonly clock: () => number,
  ) {}

  enqueue(
    task: string,
    input: JobInput,
    options: { now?: number; id?: string } = {},
  ): JobRecord {
    const now = options.now ?? this.clock();
    const id = options.id ?? randomUUID();
    const createdAt = new Date(now).toISOString();

    this.db
      .prepare(
        `INSERT INTO jobs (id, task, input, created_at, visible_at, total_tried, completed_at, has_error, last_error)
         VALUES (?, ?, ?, ?, ?, 0, NULL, 0, NULL)`,
      )
      .run(id, task, JSON.stringify(input), createdAt, now);

    return {
      id,
      task,
      input,
      createdAt,
      visibleAt: now,
      totalTried: 0,
      completedAt: null,
      hasError: false,
      lastError: null,
    };
  }

  /**
   * Claim: bierzemy najstarszy widoczny job i przesuwamy visibleAt w przyszłość.
   * Job nie znika — inny worker go nie weźmie, dopóki lease trwa.
   */
  claim(leaseMs: number): JobRecord | null {
    return transaction(this.db, () => {
      const now = this.clock();
      const row = this.db
        .prepare(
          `SELECT * FROM jobs
           WHERE completed_at IS NULL AND has_error = 0 AND visible_at <= ?
           ORDER BY visible_at ASC, created_at ASC
           LIMIT 1`,
        )
        .get(now) as unknown as JobRow | undefined;

      if (!row) return null;

      const nextVisibleAt = now + leaseMs;
      this.db
        .prepare("UPDATE jobs SET visible_at = ?, total_tried = total_tried + 1 WHERE id = ?")
        .run(nextVisibleAt, row.id);

      return this.mapRow({
        ...row,
        visible_at: nextVisibleAt,
        total_tried: row.total_tried + 1,
      });
    });
  }

  /** Ack ustawiamy dopiero PO wykonaniu pracy (at-least-once). */
  ack(jobId: string): void {
    const now = new Date(this.clock()).toISOString();
    this.db
      .prepare("UPDATE jobs SET completed_at = ?, last_error = NULL WHERE id = ?")
      .run(now, jobId);
  }

  /** Błąd przejściowy → backoff. Limit prób albo błąd trwały → DLQ. */
  fail(jobId: string, error: unknown, options: FailOptions): FailResult {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as unknown as
      | JobRow
      | undefined;
    if (!row) return "dlq";

    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
    const tried = Number(row.total_tried);
    const toDlq = options.permanent === true || tried >= options.maxAttempts;

    if (toDlq) {
      this.db
        .prepare("UPDATE jobs SET has_error = 1, last_error = ? WHERE id = ?")
        .run(message, jobId);
      return "dlq";
    }

    const delay = Math.min(
      options.maxBackoffMs,
      options.baseBackoffMs * 2 ** Math.max(0, tried - 1),
    );
    this.db
      .prepare("UPDATE jobs SET visible_at = ?, last_error = ? WHERE id = ?")
      .run(this.clock() + delay, message, jobId);
    return "retry";
  }

  stats(): QueueStats {
    const now = this.clock();
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN completed_at IS NULL AND has_error = 0 AND visible_at <= ? THEN 1 ELSE 0 END), 0) AS ready,
           COALESCE(SUM(CASE WHEN completed_at IS NULL AND has_error = 0 AND visible_at > ? THEN 1 ELSE 0 END), 0) AS retry,
           COALESCE(SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS done,
           COALESCE(SUM(CASE WHEN has_error = 1 THEN 1 ELSE 0 END), 0) AS dlq,
           COUNT(*) AS total
         FROM jobs`,
      )
      .get(now, now) as unknown as {
      ready: number;
      retry: number;
      done: number;
      dlq: number;
      total: number;
    };

    return {
      ready: Number(row.ready),
      retry: Number(row.retry),
      done: Number(row.done),
      dlq: Number(row.dlq),
      total: Number(row.total),
    };
  }

  list(limit = 30): JobView[] {
    const rows = this.db
      .prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?")
      .all(Math.max(1, Math.min(200, limit))) as unknown as JobRow[];

    return rows.map((row) => {
      const job = this.mapRow(row);
      return {
        id: job.id,
        task: job.task,
        input: job.input,
        createdAt: job.createdAt,
        visibleAt: new Date(job.visibleAt).toISOString(),
        totalTried: job.totalTried,
        completedAt: job.completedAt,
        hasError: job.hasError,
        lastError: job.lastError,
        state: this.stateOf(job),
      };
    });
  }

  retry(jobId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE jobs
         SET has_error = 0, total_tried = 0, visible_at = ?, last_error = NULL
         WHERE id = ? AND has_error = 1`,
      )
      .run(this.clock(), jobId);
    return Number(result.changes) > 0;
  }

  private stateOf(job: JobRecord): JobState {
    if (job.hasError) return "dlq";
    if (job.completedAt) return "done";
    return job.visibleAt <= this.clock() ? "ready" : "retry";
  }

  private mapRow(row: JobRow): JobRecord {
    let input: JobInput = {};
    try {
      const parsed: unknown = JSON.parse(row.input);
      if (parsed && typeof parsed === "object") input = parsed as JobInput;
    } catch {
      input = { raw: row.input };
    }

    return {
      id: row.id,
      task: row.task,
      input,
      createdAt: row.created_at,
      visibleAt: Number(row.visible_at),
      totalTried: Number(row.total_tried),
      completedAt: row.completed_at,
      hasError: Number(row.has_error) === 1,
      lastError: row.last_error,
    };
  }
}
