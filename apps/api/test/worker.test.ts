import { afterEach, describe, expect, it } from "vitest";
import type { CreateReservationResponse } from "@pas/shared";
import {
  createTestContext,
  permanentMailError,
  reservationPayload,
  transientMailError,
  type TestContext,
} from "./helpers";

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
});

async function buySeat(): Promise<{ reservationId: string; code: string }> {
  const created = await ctx.app.inject({
    method: "POST",
    url: "/api/reservations",
    payload: reservationPayload(),
  });
  const { reservationId } = created.json<CreateReservationResponse>();
  const purchase = await ctx.app.inject({
    method: "POST",
    url: `/api/reservations/${reservationId}/purchase`,
  });
  return { reservationId, code: purchase.json<{ code: string }>().code };
}

describe("worker — praca w tle (E06)", () => {
  it("wysyła e-mail z kodem i potwierdza job po pracy", async () => {
    ctx = await createTestContext();
    const { reservationId, code } = await buySeat();

    expect(await ctx.services.worker.runOnce()).toBe(true);

    expect(ctx.mailer.calls).toHaveLength(1);
    expect(ctx.mailer.calls[0]?.message.to).toBe("anna@example.com");
    expect(ctx.mailer.calls[0]?.message.text).toContain(code);
    expect(ctx.mailer.calls[0]?.message.text).toContain("Wagon 5, miejsce 1");

    const jobs = ctx.services.jobs.list(10);
    expect(jobs[0]?.state).toBe("done");
    expect(jobs[0]?.totalTried).toBe(1);
    expect(ctx.services.jobs.stats()).toMatchObject({ ready: 0, done: 1, dlq: 0 });
    expect(jobs[0]?.input).toEqual({ reservationId });
    expect(ctx.mailer.calls[0]?.key).toBe(jobs[0]?.id);
  });

  it("nie bierze tego samego joba dwa razy po ack", async () => {
    ctx = await createTestContext();
    await buySeat();

    expect(await ctx.services.worker.runOnce()).toBe(true);
    expect(await ctx.services.worker.runOnce()).toBe(false);
    expect(ctx.mailer.calls).toHaveLength(1);
  });

  it("po błędzie przejściowym zostawia job w kolejce i próbuje z backoffem", async () => {
    ctx = await createTestContext();
    ctx.mailer.failWith = transientMailError();
    await buySeat();

    expect(await ctx.services.worker.runOnce()).toBe(true);
    let jobs = ctx.services.jobs.list(10);
    expect(jobs[0]?.state).toBe("retry");
    expect(jobs[0]?.totalTried).toBe(1);
    expect(ctx.services.jobs.stats().dlq).toBe(0);

    ctx.mailer.failWith = null;
    ctx.advance(2_000);
    expect(await ctx.services.worker.runOnce()).toBe(true);

    jobs = ctx.services.jobs.list(10);
    expect(jobs[0]?.state).toBe("done");
    expect(jobs[0]?.totalTried).toBe(2);
    // Pierwsze podejście miało dwa retry E04, drugie — jedno. Każde z tym samym kluczem.
    expect(ctx.mailer.calls).toHaveLength(3);
    expect(new Set(ctx.mailer.calls.map((call) => call.key)).size).toBe(1);
  });

  it("po limicie prób odkłada zatruty job do DLQ", async () => {
    ctx = await createTestContext({ overrides: { worker: { enabled: false, maxAttempts: 3 } } });
    ctx.mailer.failWith = transientMailError();
    await buySeat();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await ctx.services.worker.runOnce()).toBe(true);
      ctx.advance(120_000);
    }

    expect(ctx.services.jobs.stats()).toMatchObject({ dlq: 1, done: 0, retry: 0 });
    const job = ctx.services.jobs.list(10)[0];
    expect(job?.state).toBe("dlq");
    expect(job?.lastError).toContain("Dostawca padł");
  });

  it("błąd trwały trafia do DLQ od razu, bez pięciu prób", async () => {
    ctx = await createTestContext();
    ctx.mailer.failWith = permanentMailError();
    await buySeat();

    expect(await ctx.services.worker.runOnce()).toBe(true);
    expect(ctx.services.jobs.stats()).toMatchObject({ dlq: 1, retry: 0 });
    expect(ctx.services.jobs.list(10)[0]?.totalTried).toBe(1);
  });

  it("job z DLQ można przywrócić do kolejki", async () => {
    ctx = await createTestContext();
    ctx.mailer.failWith = permanentMailError();
    await buySeat();
    await ctx.services.worker.runOnce();

    const job = ctx.services.jobs.list(10)[0]!;
    expect(ctx.services.jobs.retry(job.id)).toBe(true);
    expect(ctx.services.jobs.stats().ready).toBe(1);
    expect(ctx.services.jobs.list(10)[0]?.totalTried).toBe(0);

    ctx.mailer.failWith = null;
    expect(await ctx.services.worker.runOnce()).toBe(true);
    expect(ctx.services.jobs.stats().done).toBe(1);
  });
});
