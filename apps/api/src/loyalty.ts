import type { Db } from "./db";
import { InsufficientPointsError, LoyaltyUnavailableError } from "./errors";
import type { CircuitBreaker } from "./resilience";

/**
 * Klient programu lojalnościowego. Kontrakt jest mały, bo Voucherify ma być
 * jedynym źródłem prawdy o saldzie: my tylko mapujemy e-mail na kartę.
 */
export interface LoyaltyProvider {
  readonly name: "voucherify" | "memory";
  /** Tworzy kartę lojalnościową i zwraca jej identyfikator (kod karty). */
  createMember(email: string): Promise<{ memberId: string }>;
  /** Saldo punktów karty (1 punkt = 1 grosz). */
  getBalance(memberId: string): Promise<number>;
  /** Dodaje (delta > 0) albo odejmuje (delta < 0) punkty; zwraca nowe saldo. */
  adjustPoints(memberId: string, delta: number, reason: string): Promise<number>;
}

export class LoyaltyProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly insufficient = false,
  ) {
    super(message);
    this.name = "LoyaltyProviderError";
  }
}

interface VoucherifyMember {
  code?: string;
  loyalty_card?: { balance?: number };
}

interface LoyaltyAccountRow {
  email: string;
  member_id: string;
}

/**
 * Voucherify, legacy loyalty API (`/v1/loyalties/...`).
 *
 * - karta: `POST /v1/loyalties/{campaignId}/members` z `customer.source_id = e-mail`,
 * - saldo: `GET /v1/loyalties/members/{memberId}` → `loyalty_card.balance`,
 * - korekta: `POST /v1/loyalties/members/{memberId}/balance` z `{ points: delta }`.
 */
export class VoucherifyLoyaltyProvider implements LoyaltyProvider {
  readonly name = "voucherify" as const;

  constructor(
    private readonly options: {
      appId: string;
      appToken: string;
      campaignId: string;
      apiUrl: string;
      timeoutMs: number;
      maxRetries: number;
      breaker: CircuitBreaker;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  async createMember(email: string): Promise<{ memberId: string }> {
    try {
      const body = await this.request<VoucherifyMember>(
        "POST",
        `/v1/loyalties/${encodeURIComponent(this.options.campaignId)}/members`,
        { customer: { source_id: email, email } },
      );
      if (body.code) return { memberId: body.code };
    } catch (error) {
      // Karta już istnieje (np. DB po migracji nie ma mapowania) — znajdź ją po kliencie.
      if (error instanceof LoyaltyProviderError && error.status === 400) {
        const existing = await this.findMember(email);
        if (existing) return existing;
      }
      throw error;
    }
    const existing = await this.findMember(email);
    if (existing) return existing;
    throw new LoyaltyProviderError("Voucherify nie zwrócił kodu karty lojalnościowej.", false);
  }

  async getBalance(memberId: string): Promise<number> {
    const body = await this.request<VoucherifyMember>(
      "GET",
      `/v1/loyalties/members/${encodeURIComponent(memberId)}`,
    );
    const balance = body.loyalty_card?.balance;
    if (typeof balance !== "number") {
      throw new LoyaltyProviderError("Voucherify nie zwrócił salda karty.", false);
    }
    return Math.trunc(balance);
  }

  async adjustPoints(memberId: string, delta: number, reason: string): Promise<number> {
    const body = await this.request<{ balance?: number }>(
      "POST",
      `/v1/loyalties/members/${encodeURIComponent(memberId)}/balance`,
      { points: delta, reason },
    );
    if (typeof body.balance === "number") return Math.trunc(body.balance);
    return this.getBalance(memberId);
  }

  /** Lista członków kampanii filtrowana po kliencie — ratunek, gdy zgubimy mapowanie. */
  private async findMember(email: string): Promise<{ memberId: string } | null> {
    const body = await this.request<{ data?: VoucherifyMember[]; vouchers?: VoucherifyMember[] }>(
      "GET",
      `/v1/loyalties/${encodeURIComponent(this.options.campaignId)}/members?customer=${encodeURIComponent(email)}&limit=1`,
    );
    const first = body.data?.[0] ?? body.vouchers?.[0];
    return first?.code ? { memberId: first.code } : null;
  }

  private async request<T>(method: "GET" | "POST", path: string, payload?: unknown): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      try {
        return await this.options.breaker.fire(() => this.fetchOnce<T>(method, path, payload));
      } catch (error) {
        lastError = error;
        if (error instanceof LoyaltyProviderError && !error.retryable) throw error;
        if (attempt === this.options.maxRetries) break;
        await (this.options.sleep ?? sleep)(200 * (attempt + 1));
      }
    }
    throw lastError;
  }

  private async fetchOnce<T>(method: "GET" | "POST", path: string, payload?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.options.apiUrl}${path}`, {
        method,
        headers: {
          "X-App-Id": this.options.appId,
          "X-App-Token": this.options.appToken,
          accept: "application/json",
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      const timeout =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new LoyaltyProviderError(
        timeout ? `Voucherify: timeout po ${this.options.timeoutMs} ms` : `Voucherify: ${String(error)}`,
        true,
      );
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      const text = await response.text().catch(() => "");
      // 400 na korekcie salda = brak punktów (Voucherify nie ma osobnego kodu).
      const insufficient = response.status === 400 && method === "POST" && path.endsWith("/balance");
      throw new LoyaltyProviderError(
        `Voucherify ${response.status}: ${text.slice(0, 200)}`,
        retryable,
        response.status,
        insufficient,
      );
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new LoyaltyProviderError("Voucherify zwrócił niepoprawny JSON.", true);
    }
  }
}

/** Lokalny dostawca dla dev/testów: saldo w pamięci procesu. */
export class MemoryLoyaltyProvider implements LoyaltyProvider {
  readonly name = "memory" as const;
  private readonly balances = new Map<string, number>();

  async createMember(email: string): Promise<{ memberId: string }> {
    if (!this.balances.has(email)) this.balances.set(email, 0);
    return { memberId: email };
  }

  async getBalance(memberId: string): Promise<number> {
    return this.balances.get(memberId) ?? 0;
  }

  async adjustPoints(memberId: string, delta: number, _reason: string): Promise<number> {
    const next = (this.balances.get(memberId) ?? 0) + delta;
    if (next < 0) throw new LoyaltyProviderError("Za mało punktów.", false, 400, true);
    this.balances.set(memberId, next);
    return next;
  }
}

/**
 * Warstwa między API a Voucherify: mapowanie e-mail → karta, bonus powitalny
 * (1000 punktów) i operacje na saldzie. Saldo czytamy zawsze z Voucherify —
 * baza trzyma wyłącznie `member_id`, żeby nie zgubić karty.
 */
export class LoyaltyService {
  private readonly pending = new Map<string, Promise<{ email: string; memberId: string }>>();

  constructor(
    private readonly db: Db,
    private readonly provider: LoyaltyProvider,
    private readonly welcomePoints: number,
    private readonly clock: () => number,
  ) {}

  get providerName(): string {
    return this.provider.name;
  }

  /** Konto istnieje? Jeśli nie, zakłada kartę i przyznaje punkty powitalne. */
  async ensureAccount(email: string): Promise<{ email: string; memberId: string }> {
    const normalized = email.trim().toLowerCase();
    const existing = this.findAccount(normalized);
    if (existing) return existing;

    const inFlight = this.pending.get(normalized);
    if (inFlight) return inFlight;

    const created = this.createAccount(normalized).finally(() => this.pending.delete(normalized));
    this.pending.set(normalized, created);
    return created;
  }

  async getBalance(email: string): Promise<number> {
    const account = await this.ensureAccount(email);
    try {
      return await this.provider.getBalance(account.memberId);
    } catch (error) {
      throw asUnavailable(error);
    }
  }

  /** Odejmuje punkty; przy braku salda rzuca 409 INSUFFICIENT_POINTS. */
  async spendPoints(email: string, points: number): Promise<number> {
    const account = await this.ensureAccount(email);
    try {
      return await this.provider.adjustPoints(account.memberId, -points, "checkout");
    } catch (error) {
      if (error instanceof LoyaltyProviderError && error.insufficient) throw new InsufficientPointsError();
      throw asUnavailable(error);
    }
  }

  /** Nalicza punkty za zakup (10 za każdy pełny złoty zapłacony kartą). */
  async awardPoints(email: string, points: number): Promise<number> {
    if (points <= 0) return 0;
    const account = await this.ensureAccount(email);
    try {
      return await this.provider.adjustPoints(account.memberId, points, "purchase");
    } catch (error) {
      throw asUnavailable(error);
    }
  }

  private async createAccount(email: string): Promise<{ email: string; memberId: string }> {
    let memberId: string;
    try {
      memberId = (await this.provider.createMember(email)).memberId;
      if (this.welcomePoints > 0) {
        await this.provider.adjustPoints(memberId, this.welcomePoints, "welcome");
      }
    } catch (error) {
      throw asUnavailable(error);
    }

    const nowIso = new Date(this.clock()).toISOString();
    this.db
      .prepare(
        `INSERT INTO loyalty_accounts (email, member_id, welcomed_at, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (email) DO NOTHING`,
      )
      .run(email, memberId, nowIso, nowIso);

    // Wyścig dwóch pierwszych requestów: wygrywa ten, kto pierwszy zapisał mapowanie.
    return this.findAccount(email) ?? { email, memberId };
  }

  private findAccount(email: string): { email: string; memberId: string } | null {
    const row = this.db
      .prepare("SELECT email, member_id FROM loyalty_accounts WHERE email = ?")
      .get(email) as unknown as LoyaltyAccountRow | undefined;
    return row ? { email: row.email, memberId: row.member_id } : null;
  }
}

function asUnavailable(error: unknown): Error {
  if (error instanceof InsufficientPointsError) return error;
  return new LoyaltyUnavailableError(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
