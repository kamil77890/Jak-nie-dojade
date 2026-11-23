import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateReservationResponse, LoyaltyResponse } from "@pas/shared";
import {
  checkoutCompletedEvent,
  createTestContext,
  newIdempotencyKey,
  reservationPayload,
  sendWebhook,
  stripeDown,
  type TestContext,
} from "./helpers";
import { stubVoucherify, voucherifyConfig } from "./loyalty-helpers";

/**
 * III.X1: awaria Voucherify (unieważniony klucz → 401, 5xx, timeout) przy naliczeniu
 * punktów albo zaległym zwrocie: mail idzie od razu i raz, job czeka na Voucherify
 * z rosnącym odstępem (do minuty) bez zużywania prób, a po przywróceniu punkty dochodzą.
 */

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
  vi.unstubAllGlobals();
});

async function reserve(email = "anna@example.com"): Promise<string> {
  const created = await ctx.app.inject({ method: "POST", url: "/api/reservations", payload: reservationPayload({ email }) });
  expect(created.statusCode).toBe(201);
  return created.json<CreateReservationResponse>().reservationId;
}

function checkout(reservationId: string, points?: number) {
  return ctx.app.inject({
    method: "POST",
    url: `/api/reservations/${reservationId}/checkout`,
    headers: { "idempotency-key": newIdempotencyKey() },
    ...(points === undefined ? {} : { payload: { points } }),
  });
}

async function buyWithCard(reservationId: string): Promise<void> {
  expect((await checkout(reservationId)).statusCode).toBe(200);
  const session = ctx.payments.sessions.at(-1)!;
  const response = await sendWebhook(
    ctx,
    checkoutCompletedEvent(ctx, { sessionId: session.result.id, reservationId, amount: session.input.amount }),
  );
  expect(response.statusCode).toBe(200);
}

function onlyJob() {
  const jobs = ctx.services.jobs.list(5);
  expect(jobs).toHaveLength(1);
  return jobs[0]!;
}

describe("III.X1 — Voucherify leży, a punkty nie przepadają", () => {
  it("unieważniony klucz (401): bilet i mail od razu, naliczenie czeka bez DLQ, po przywróceniu punkty w ≤ 2 min", async () => {
    const voucherify = stubVoucherify();
    voucherify.state.down = true;
    voucherify.state.status = 401;
    ctx = await createTestContext({
      overrides: { loyalty: voucherifyConfig(), worker: { maxAttempts: 2 } },
    });
    const reservationId = await reserve();
    await buyWithCard(reservationId);
    const status = await ctx.app.inject({ method: "GET", url: `/api/reservations/${reservationId}` });
    expect(status.json()).toMatchObject({ status: "paid", pointsEarned: 890 });

    // 40 prób przez ponad 20 minut awarii: ani razu DLQ, mail tylko raz, odstęp rośnie do minuty.
    const delays: number[] = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      expect(await ctx.services.worker.runOnce()).toBe(true);
      const job = onlyJob();
      expect(job.state).toBe("retry");
      expect(job.totalTried).toBe(0);
      const delay = Date.parse(job.visibleAt) - ctx.now();
      delays.push(delay);
      ctx.advance(delay);
    }
    expect(ctx.mailer.calls).toHaveLength(1);
    expect(delays[0]).toBe(5_000);
    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index]!).toBeGreaterThanOrEqual(delays[index - 1]!);
    }
    expect(Math.max(...delays)).toBe(60_000);
    expect(ctx.services.jobs.stats()).toMatchObject({ dlq: 0 });

    // Klucz przywrócony: najpóźniej w następnej próbie (≤ 60 s) punkty są na karcie.
    voucherify.state.down = false;
    const restoredAt = ctx.now();
    for (let guard = 0; guard < 5 && ctx.services.jobs.stats().done === 0; guard += 1) {
      const job = onlyJob();
      ctx.advance(Math.max(0, Date.parse(job.visibleAt) - ctx.now()));
      await ctx.services.worker.runOnce();
    }
    expect(ctx.services.jobs.stats()).toMatchObject({ done: 1, dlq: 0 });
    expect(ctx.now() - restoredAt).toBeLessThanOrEqual(120_000);
    expect(voucherify.balances.get("CARD-anna@example.com")).toBe(1000 + 890);
    expect(ctx.mailer.calls).toHaveLength(1);

    const loyalty = await ctx.app.inject({ method: "GET", url: "/api/loyalty?email=anna%40example.com" });
    expect(loyalty.json<LoyaltyResponse>().points).toBe(1890);
  });

  it("awaria Voucherify nie blokuje maila następnego klienta i nie powoduje drugiego maila", async () => {
    const voucherify = stubVoucherify();
    voucherify.state.down = true;
    ctx = await createTestContext({ overrides: { loyalty: voucherifyConfig() } });
    await buyWithCard(await reserve("a@example.com"));
    expect(await ctx.services.worker.runOnce()).toBe(true);
    expect(ctx.mailer.calls.map((call) => call.message.to)).toEqual(["a@example.com"]);

    const second = await ctx.app.inject({
      method: "POST",
      url: "/api/reservations",
      payload: reservationPayload({ email: "b@example.com", seatId: "5-2" }),
    });
    await buyWithCard(second.json<CreateReservationResponse>().reservationId);
    expect(await ctx.services.worker.runOnce()).toBe(true);
    expect(ctx.mailer.calls.map((call) => call.message.to)).toEqual(["a@example.com", "b@example.com"]);
  });

  it("po horyzoncie (WORKER_LOYALTY_RETRY_HORIZON_HOURS) job wraca do zwykłych prób i trafia do DLQ", async () => {
    const voucherify = stubVoucherify();
    voucherify.state.down = true;
    ctx = await createTestContext({
      overrides: {
        loyalty: voucherifyConfig(),
        worker: { maxAttempts: 2, loyaltyRetryHorizonMs: 10 * 60_000 },
      },
    });
    await buyWithCard(await reserve());

    let guard = 0;
    while (ctx.services.jobs.stats().dlq === 0 && guard < 100) {
      guard += 1;
      await ctx.services.worker.runOnce();
      const job = onlyJob();
      if (job.state === "retry") ctx.advance(Math.max(0, Date.parse(job.visibleAt) - ctx.now()));
    }
    expect(ctx.services.jobs.stats()).toMatchObject({ dlq: 1 });
    const job = onlyJob();
    expect(Date.parse(job.visibleAt) - Date.parse(job.createdAt)).toBeGreaterThanOrEqual(10 * 60_000);
    expect(ctx.mailer.calls).toHaveLength(1);

    // Ręczne „Ponów” w /lab po przywróceniu: punkty dochodzą, mail nie idzie drugi raz.
    voucherify.state.down = false;
    ctx.advance(30_000); // bezpiecznik Voucherify po serii błędów wraca do próby po 30 s
    expect(ctx.services.jobs.retry(job.id)).toBe(true);
    expect(await ctx.services.worker.runOnce()).toBe(true);
    expect(voucherify.balances.get("CARD-anna@example.com")).toBe(1890);
    expect(ctx.mailer.calls).toHaveLength(1);
  });

  it("zaległy zwrot punktów (refund-points) czeka na Voucherify zamiast DLQ po kilku szybkich próbach", async () => {
    const voucherify = stubVoucherify();
    ctx = await createTestContext({ overrides: { loyalty: voucherifyConfig(), worker: { maxAttempts: 2 } } });
    const reservationId = await reserve();

    // Punkty zeszły, Stripe odmówił sesji, a zwrot od razu się nie udał (Voucherify padł).
    ctx.payments.failWith = stripeDown();
    const original = voucherify.fetchMock.getMockImplementation()!;
    let spent = false;
    voucherify.fetchMock.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      if (init?.method === "POST" && String(input).endsWith("/balance") && !spent) {
        const body = JSON.parse(String(init.body)) as { points: number };
        if (body.points < 0) {
          spent = true;
          voucherify.state.down = true;
        }
      }
      return response;
    });
    expect((await checkout(reservationId, 1000)).statusCode).toBe(503);
    expect(voucherify.balances.get("CARD-anna@example.com")).toBe(0);
    const job = onlyJob();
    expect(job.task).toBe("refund-points");

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await ctx.services.worker.runOnce();
      const current = onlyJob();
      expect(current.state).toBe("retry");
      ctx.advance(Math.max(0, Date.parse(current.visibleAt) - ctx.now()));
    }
    voucherify.state.down = false;
    ctx.advance(60_000);
    await ctx.services.worker.runOnce();
    expect(ctx.services.jobs.stats()).toMatchObject({ done: 1, dlq: 0 });
    expect(voucherify.balances.get("CARD-anna@example.com")).toBe(1000);
  });
});
