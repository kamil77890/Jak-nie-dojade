import { vi } from "vitest";
import { type LoyaltyPriority, MemoryLoyaltyProvider } from "../src/loyalty";
import type { TestContext } from "./helpers";

/** Wiersz mapowania e-mail → karta, jak po pierwszym zapisie punktów. */
export function seedAccount(ctx: TestContext, email: string, memberId: string, welcomePending = 0): void {
  const nowIso = new Date(ctx.now()).toISOString();
  ctx.services.db
    .prepare(
      `INSERT INTO loyalty_accounts (email, member_id, welcomed_at, created_at, welcome_pending)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(email, memberId, nowIso, nowIso, welcomePending);
}

export function accountRow(
  ctx: TestContext,
  email: string,
): { member_id: string; welcome_pending: number } | undefined {
  return ctx.services.db
    .prepare("SELECT member_id, welcome_pending FROM loyalty_accounts WHERE email = ?")
    .get(email) as unknown as { member_id: string; welcome_pending: number } | undefined;
}

type ProviderCall =
  | { op: "createMember"; email: string; priority?: LoyaltyPriority }
  | { op: "findMember"; email: string; priority?: LoyaltyPriority }
  | { op: "getBalance"; memberId: string; priority?: LoyaltyPriority }
  | { op: "adjustPoints"; memberId: string; delta: number; reason: string; priority?: LoyaltyPriority };

/**
 * Dostawca pamięciowy, który liczy wywołania — każde to jedno wywołanie Voucherify
 * z limitu 100/h. `failNext` wymusza błąd wybranej operacji (raz).
 */
export class CountingLoyaltyProvider extends MemoryLoyaltyProvider {
  calls: ProviderCall[] = [];
  failNext: Partial<Record<ProviderCall["op"], Error>> = {};
  /** Korekta dochodzi do salda, ale odpowiedź ginie (timeout) — wynik niepewny. */
  failAfterApply: Error | null = null;

  count(op: ProviderCall["op"]): number {
    return this.calls.filter((call) => call.op === op).length;
  }

  override async createMember(email: string, priority?: LoyaltyPriority) {
    this.calls.push({ op: "createMember", email, priority });
    this.throwIfFailing("createMember");
    return super.createMember(email);
  }

  override async findMember(email: string, priority?: LoyaltyPriority) {
    this.calls.push({ op: "findMember", email, priority });
    this.throwIfFailing("findMember");
    return super.findMember(email);
  }

  /** Karta założona poza sklepem (panel Voucherify, kasa) — bez wywołań na liście. */
  seedCard(email: string, balance: number): void {
    this.balances.set(email, balance);
    if (balance > 0) this.credited.add(email);
  }

  /** Korekta „w panelu” — poza naszym procesem, nie liczy się do wywołań. */
  panelAdjust(email: string, delta: number): void {
    this.balances.set(email, (this.balances.get(email) ?? 0) + delta);
  }

  override async getBalance(memberId: string, priority?: LoyaltyPriority) {
    this.calls.push({ op: "getBalance", memberId, priority });
    this.throwIfFailing("getBalance");
    return super.getBalance(memberId);
  }

  override async adjustPoints(memberId: string, delta: number, reason: string, priority?: LoyaltyPriority) {
    this.calls.push({ op: "adjustPoints", memberId, delta, reason, priority });
    this.throwIfFailing("adjustPoints");
    const balance = await super.adjustPoints(memberId, delta, reason);
    if (this.failAfterApply) {
      const error = this.failAfterApply;
      this.failAfterApply = null;
      throw error;
    }
    return balance;
  }

  private throwIfFailing(op: ProviderCall["op"]): void {
    const error = this.failNext[op];
    if (error) {
      delete this.failNext[op];
      throw error;
    }
  }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * Atrapa HTTP Voucherify (legacy loyalty API) podpięta pod globalny fetch.
 * Pozwala przetestować prawdziwego `VoucherifyLoyaltyProvider` z budżetem w aplikacji.
 */
export function stubVoucherify() {
  const balances = new Map<string, number>();
  const state: { rateLimitedFor: string | null; down: boolean; status?: number; allowNegative: boolean } = {
    rateLimitedFor: null,
    down: false,
    allowNegative: false,
  };
  const calls: Array<{ method: string; path: string }> = [];

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname });
    if (state.rateLimitedFor !== null) {
      return jsonResponse({ code: 429, message: "Too many requests" }, 429, { "retry-after": state.rateLimitedFor });
    }
    if (state.down) return jsonResponse({ message: "internal db shard-7 timeout (secret)" }, state.status ?? 503);

    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const balanceMatch = /^\/v1\/loyalties\/members\/([^/]+)\/balance$/.exec(url.pathname);
    if (method === "POST" && balanceMatch) {
      const card = decodeURIComponent(balanceMatch[1]!);
      const next = (balances.get(card) ?? 0) + Number(body.points);
      if (next < 0 && !state.allowNegative) return jsonResponse({ code: 400, message: "Not enough points" }, 400);
      balances.set(card, next);
      return jsonResponse({ points: body.points, balance: next });
    }
    const memberMatch = /^\/v1\/loyalties\/members\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && memberMatch) {
      const card = decodeURIComponent(memberMatch[1]!);
      return jsonResponse({ code: card, loyalty_card: { balance: balances.get(card) ?? 0 } });
    }
    if (method === "GET" && /^\/v1\/loyalties\/[^/]+\/members$/.test(url.pathname)) {
      const card = `CARD-${url.searchParams.get("customer") ?? ""}`;
      const balance = balances.get(card);
      return jsonResponse({
        data: balance === undefined ? [] : [{ code: card, loyalty_card: { balance, points: Math.max(0, balance) } }],
      });
    }
    if (method === "POST" && /^\/v1\/loyalties\/[^/]+\/members$/.test(url.pathname)) {
      const customer = body.customer as { source_id: string };
      const card = `CARD-${customer.source_id}`;
      if (balances.has(card)) return jsonResponse({ code: 400, key: "duplicate_found" }, 400);
      balances.set(card, 0);
      return jsonResponse({ code: card });
    }
    return jsonResponse({ code: 404 }, 404);
  });

  vi.stubGlobal("fetch", fetchMock);
  return { balances, state, calls, fetchMock };
}

/** Konfiguracja aplikacji z prawdziwym dostawcą Voucherify (fetch podmieniony atrapą). */
export function voucherifyConfig(overrides: Record<string, unknown> = {}) {
  return {
    provider: "voucherify" as const,
    appId: "app_test",
    appToken: "token_test",
    campaignId: "camp_test",
    apiUrl: "https://voucherify.test",
    maxRetries: 0,
    ...overrides,
  };
}
