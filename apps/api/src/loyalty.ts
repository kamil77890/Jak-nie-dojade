import type { LoyaltyOpsSnapshot } from "@pas/shared";
import type { Db } from "./db";
import { InsufficientPointsError, LoyaltyUnavailableError } from "./errors";
import {
  type BudgetPriority,
  type CallBudget,
  type CircuitBreaker,
  CircuitOpenError,
} from "./resilience";

/**
 * Priorytet wywołania Voucherify (patrz `CallBudget`):
 * - `read` — odczyt salda dla `GET /api/loyalty`; pierwszy odpada, gdy budżet się kończy,
 * - `checkout` — sprawdzenie i pobranie punktów przy zakupie (oraz założenie karty),
 * - `critical` — zwrot punktów i naliczenie po zakupie; ma rezerwę tylko dla siebie.
 */
export type LoyaltyPriority = BudgetPriority;

/**
 * Klient programu lojalnościowego. Kontrakt jest mały, bo Voucherify ma być
 * jedynym źródłem prawdy o saldzie: my tylko mapujemy e-mail na kartę.
 */
export interface LoyaltyProvider {
  readonly name: "voucherify" | "memory";
  /**
   * Tworzy kartę lojalnościową (albo odnajduje istniejącą) i zwraca jej kod.
   * `hasHistory` = karta już kiedyś dostała punkty, więc bonus powitalny był przyznany.
   */
  createMember(email: string, priority?: LoyaltyPriority): Promise<{ memberId: string; hasHistory?: boolean }>;
  /** Saldo punktów karty (1 punkt = 1 grosz). */
  getBalance(memberId: string, priority?: LoyaltyPriority): Promise<number>;
  /** Dodaje (delta > 0) albo odejmuje (delta < 0) punkty; zwraca nowe saldo. */
  adjustPoints(memberId: string, delta: number, reason: string, priority?: LoyaltyPriority): Promise<number>;
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

/**
 * Nie wołamy Voucherify, bo i tak by odmówił: wyczerpany nasz budżet wywołań
 * (`budget`) albo Voucherify odpowiedział 429 i kazał czekać (`voucherify`).
 * Żądanie na pewno nie zmieniło salda.
 */
export class LoyaltyThrottledError extends LoyaltyProviderError {
  constructor(
    message: string,
    public readonly retryAfterSeconds: number,
    public readonly source: "budget" | "voucherify",
  ) {
    super(message, false, 429);
    this.name = "LoyaltyThrottledError";
  }
}

interface VoucherifyMember {
  code?: string;
  /** `points` = suma punktów w historii karty, `balance` = bieżące saldo. */
  loyalty_card?: { points?: number; balance?: number };
}

type FetchOutcome<T> = { kind: "ok"; body: T } | { kind: "rate_limited"; retryAfterMs: number };

/** Voucherify bez Retry-After: czekamy minutę (limit jest godzinowy, częstsze próby nic nie dadzą). */
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;
const MAX_RATE_LIMIT_WAIT_MS = 60 * 60_000;

/**
 * Voucherify, legacy loyalty API (`/v1/loyalties/...`).
 *
 * - karta: `POST /v1/loyalties/{campaignId}/members` z `customer.source_id = e-mail`,
 * - saldo: `GET /v1/loyalties/members/{memberId}` → `loyalty_card.balance`,
 * - korekta: `POST /v1/loyalties/members/{memberId}/balance` z `{ points: delta }`.
 *
 * Sandbox przyjmuje najwyżej 100 wywołań na godzinę, więc każde wyjście do sieci
 * (także ponowienie) przechodzi przez `CallBudget`. 429 nie jest ponawiane od razu:
 * blokuje budżet na czas z `Retry-After` i nie liczy się jako awaria bezpiecznika.
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
      /** Budżet wywołań w oknie godzinowym; bez niego (testy jednostkowe) brak limitu. */
      budget?: CallBudget;
      clock?: () => number;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  async createMember(
    email: string,
    priority: LoyaltyPriority = "checkout",
  ): Promise<{ memberId: string; hasHistory: boolean }> {
    try {
      // Ponowienie po timeoucie jest bezpieczne: drugie założenie tej samej karty
      // kończy się 400, a findMember odnajdzie kartę (bez historii → bonus należny).
      const body = await this.request<VoucherifyMember>(
        "POST",
        `/v1/loyalties/${encodeURIComponent(this.options.campaignId)}/members`,
        { customer: { source_id: email, email } },
        priority,
        true,
      );
      if (body.code) return { memberId: body.code, hasHistory: hasHistory(body) };
    } catch (error) {
      // Karta już istnieje (np. DB po migracji nie ma mapowania) — znajdź ją po kliencie.
      if (error instanceof LoyaltyProviderError && error.status === 400) {
        const existing = await this.findMember(email, priority);
        if (existing) return existing;
      }
      throw error;
    }
    const existing = await this.findMember(email, priority);
    if (existing) return existing;
    throw new LoyaltyProviderError("Voucherify nie zwrócił kodu karty lojalnościowej.", false);
  }

  async getBalance(memberId: string, priority: LoyaltyPriority = "read"): Promise<number> {
    const body = await this.request<VoucherifyMember>(
      "GET",
      `/v1/loyalties/members/${encodeURIComponent(memberId)}`,
      undefined,
      priority,
      true,
    );
    const balance = body.loyalty_card?.balance;
    if (typeof balance !== "number") {
      throw new LoyaltyProviderError("Voucherify nie zwrócił salda karty.", false);
    }
    return Math.trunc(balance);
  }

  async adjustPoints(
    memberId: string,
    delta: number,
    reason: string,
    priority: LoyaltyPriority = "checkout",
  ): Promise<number> {
    // Korekta salda nie jest idempotentna: ponowienie po timeoucie mogłoby pobrać
    // punkty dwa razy. Nie ponawiamy jej automatycznie — decyduje wywołujący
    // (checkout odpowiada 503, job naliczenia wraca z backoffem i znacznikiem w bazie).
    const body = await this.request<{ balance?: number }>(
      "POST",
      `/v1/loyalties/members/${encodeURIComponent(memberId)}/balance`,
      { points: delta, reason },
      priority,
      false,
    );
    if (typeof body.balance === "number") return Math.trunc(body.balance);
    return this.getBalance(memberId, priority);
  }

  /** Lista członków kampanii filtrowana po kliencie — ratunek, gdy zgubimy mapowanie. */
  private async findMember(
    email: string,
    priority: LoyaltyPriority,
  ): Promise<{ memberId: string; hasHistory: boolean } | null> {
    const body = await this.request<{ data?: VoucherifyMember[]; vouchers?: VoucherifyMember[] }>(
      "GET",
      `/v1/loyalties/${encodeURIComponent(this.options.campaignId)}/members?customer=${encodeURIComponent(email)}&limit=1`,
      undefined,
      priority,
      true,
    );
    const first = body.data?.[0] ?? body.vouchers?.[0];
    return first?.code ? { memberId: first.code, hasHistory: hasHistory(first) } : null;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    payload: unknown,
    priority: LoyaltyPriority,
    retryable: boolean,
  ): Promise<T> {
    const { budget } = this.options;
    const maxRetries = retryable ? this.options.maxRetries : 0;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      // Budżet sprawdzamy przed bezpiecznikiem: odmowa z budżetu nie jest awarią Voucherify.
      const decision = budget?.check(priority);
      if (decision && !decision.allowed) {
        throw new LoyaltyThrottledError(
          `Budżet wywołań Voucherify wyczerpany (priorytet ${priority}).`,
          decision.retryAfterSeconds,
          "budget",
        );
      }

      let outcome: FetchOutcome<T>;
      try {
        outcome = await this.options.breaker.fire(() => {
          // Liczymy tylko wywołania, które naprawdę wychodzą (otwarty bezpiecznik nic nie kosztuje).
          budget?.record();
          return this.fetchOnce<T>(method, path, payload);
        });
      } catch (error) {
        lastError = error;
        // Otwarty bezpiecznik: ponawianie co 200 ms nic nie da, odpowiadamy od razu.
        if (error instanceof CircuitOpenError) throw error;
        if (!(error instanceof LoyaltyProviderError) || !error.retryable) throw error;
        if (attempt === maxRetries) break;
        await (this.options.sleep ?? sleep)(200 * (attempt + 1));
        continue;
      }

      if (outcome.kind === "rate_limited") {
        // 429 = Voucherify działa, tylko każe czekać. Nie ponawiamy (każda próba to
        // kolejne wywołanie z limitu), blokujemy budżet na czas z Retry-After.
        budget?.blockFor(outcome.retryAfterMs);
        throw new LoyaltyThrottledError(
          "Voucherify 429: limit wywołań API.",
          Math.max(1, Math.ceil(outcome.retryAfterMs / 1000)),
          "voucherify",
        );
      }
      return outcome.body;
    }
    throw lastError;
  }

  private async fetchOnce<T>(method: "GET" | "POST", path: string, payload?: unknown): Promise<FetchOutcome<T>> {
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

    if (response.status === 429) {
      await response.body?.cancel().catch(() => undefined);
      const now = (this.options.clock ?? Date.now)();
      return { kind: "rate_limited", retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after"), now) };
    }

    if (!response.ok) {
      const retryable = response.status >= 500;
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
      return { kind: "ok", body: (await response.json()) as T };
    } catch {
      throw new LoyaltyProviderError("Voucherify zwrócił niepoprawny JSON.", true);
    }
  }
}

/** Retry-After w sekundach albo jako data HTTP; brak/śmieci → minuta, najwyżej godzina. */
export function parseRetryAfterMs(header: string | null, now: number): number {
  const raw = header?.trim();
  let ms = DEFAULT_RATE_LIMIT_WAIT_MS;
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      ms = seconds * 1000;
    } else {
      const date = Date.parse(raw);
      if (Number.isFinite(date)) ms = date - now;
    }
  }
  return Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(1_000, ms));
}

function hasHistory(member: VoucherifyMember): boolean {
  const card = member.loyalty_card;
  return (card?.points ?? 0) > 0 || (card?.balance ?? 0) > 0;
}

/** Lokalny dostawca dla dev/testów: saldo w pamięci procesu, bez limitu wywołań. */
export class MemoryLoyaltyProvider implements LoyaltyProvider {
  readonly name = "memory" as const;
  private readonly balances = new Map<string, number>();
  private readonly credited = new Set<string>();

  async createMember(email: string): Promise<{ memberId: string; hasHistory: boolean }> {
    if (!this.balances.has(email)) this.balances.set(email, 0);
    return { memberId: email, hasHistory: this.credited.has(email) };
  }

  async getBalance(memberId: string): Promise<number> {
    return this.balances.get(memberId) ?? 0;
  }

  async adjustPoints(memberId: string, delta: number, _reason: string): Promise<number> {
    const next = (this.balances.get(memberId) ?? 0) + delta;
    if (next < 0) throw new LoyaltyProviderError("Za mało punktów.", false, 400, true);
    this.balances.set(memberId, next);
    if (delta > 0) this.credited.add(memberId);
    return next;
  }
}

/** 0 = bonus przyznany (albo nienależny), 1 = należny, 2 = próba z niepewnym wynikiem. */
type WelcomeState = 0 | 1 | 2;

interface LoyaltyAccount {
  email: string;
  memberId: string;
  welcomePending: WelcomeState;
}

interface LoyaltyAccountRow {
  email: string;
  member_id: string;
  welcome_pending: number;
}

interface CacheEntry {
  points: number;
  at: number;
}

export interface LoyaltyServiceOptions {
  /** Jak długo odczyt salda z Voucherify jest „świeży” (0 = bez cache). */
  cacheTtlMs?: number;
  /** Do jakiego wieku stary odczyt może zastąpić 503 przy samym wyświetlaniu salda. */
  staleTtlMs?: number;
  /** Górna granica wpisów — cache nie może zjeść pamięci przy zalewie różnych e-maili. */
  maxCacheEntries?: number;
}

/**
 * Warstwa między API a Voucherify: mapowanie e-mail → karta, bonus powitalny
 * (1000 punktów) i operacje na saldzie. Baza trzyma wyłącznie `member_id`.
 *
 * Oszczędzanie limitu Voucherify (Sandbox: 100 wywołań/h):
 * - odczyt salda NIE zakłada karty: e-mail bez mapowania ma z definicji bonus powitalny,
 *   kartę i bonus zakładamy leniwie przy pierwszym zapisie (pobranie albo naliczenie punktów),
 * - krótki cache salda w pamięci procesu. To tylko optymalizacja odczytu — źródłem prawdy
 *   pozostaje Voucherify, a saldo może zmienić się poza nami (np. korekta marketingu
 *   w panelu), stąd krótki TTL. Każda nasza korekta zwraca nowe saldo i od razu
 *   nadpisuje wpis; nieudana korekta (wynik nieznany) usuwa go.
 */
export class LoyaltyService {
  private readonly pending = new Map<string, Promise<LoyaltyAccount>>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs: number;
  private readonly staleTtlMs: number;
  private readonly maxCacheEntries: number;
  private hits = 0;
  private misses = 0;
  private staleServed = 0;

  constructor(
    private readonly db: Db,
    private readonly provider: LoyaltyProvider,
    private readonly welcomePoints: number,
    private readonly clock: () => number,
    options: LoyaltyServiceOptions = {},
  ) {
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 0);
    this.staleTtlMs = Math.max(this.cacheTtlMs, options.staleTtlMs ?? 0);
    this.maxCacheEntries = Math.max(1, options.maxCacheEntries ?? 10_000);
  }

  get providerName(): "voucherify" | "memory" {
    return this.provider.name;
  }

  /**
   * Saldo do wyświetlenia (`GET /api/loyalty`). Najniższy priorytet budżetu; gdy
   * Voucherify jest niedostępny albo budżet się skończył, oddaje niedawny odczyt
   * z cache (do `staleTtlMs`), a bez niego rzuca 503 LOYALTY_UNAVAILABLE.
   */
  async readBalance(email: string): Promise<number> {
    return this.balanceFor(email, "read", true);
  }

  /**
   * Saldo przed pobraniem punktów w checkoucie. Świeży cache wystarczy: to tylko
   * wstępne sprawdzenie, bo samo pobranie jest atomowe w Voucherify (brak punktów →
   * 400 → 409 INSUFFICIENT_POINTS, bez częściowych zapisów). Zawyżony cache kończy
   * się więc tą samą odmową, tylko o jedno wywołanie później; zaniżony (ktoś dodał
   * punkty poza nami w ciągu TTL) — odmową, którą klient ponowi po TTL.
   * Bez starego cache: przy błędzie checkout ma dostać 503, nie stare dane.
   */
  async getBalance(email: string): Promise<number> {
    return this.balanceFor(email, "checkout", false);
  }

  /** Odejmuje punkty; przy braku salda rzuca 409 INSUFFICIENT_POINTS. */
  async spendPoints(email: string, points: number): Promise<number> {
    const account = await this.ensureAccount(email, "checkout");
    try {
      const balance = await this.provider.adjustPoints(account.memberId, -points, "checkout", "checkout");
      this.remember(account.email, balance);
      return balance;
    } catch (error) {
      this.forget(account.email);
      if (error instanceof LoyaltyProviderError && error.insufficient) throw new InsufficientPointsError();
      throw asUnavailable(error);
    }
  }

  /**
   * Nalicza punkty: za zakup (worker) albo jako zwrot pobranych punktów (checkout).
   * Priorytet krytyczny — ma w budżecie rezerwę, której nie ruszą odczyty ani checkout.
   */
  async awardPoints(email: string, points: number): Promise<number> {
    if (points <= 0) return 0;
    const account = await this.ensureAccount(email, "critical");
    try {
      const balance = await this.provider.adjustPoints(account.memberId, points, "purchase", "critical");
      this.remember(account.email, balance);
      return balance;
    } catch (error) {
      this.forget(account.email);
      throw asUnavailable(error);
    }
  }

  /**
   * Konto do zapisu: zakłada kartę i przyznaje punkty powitalne, jeśli trzeba.
   * Wołane tylko przed korektą salda — sam odczyt nigdy nie zakłada karty.
   */
  async ensureAccount(email: string, priority: LoyaltyPriority = "checkout"): Promise<LoyaltyAccount> {
    const normalized = normalizeEmail(email);
    const existing = this.findAccount(normalized);
    if (existing && existing.welcomePending === 0) return existing;

    const inFlight = this.pending.get(normalized);
    if (inFlight) return inFlight;

    const opened = this.openAccount(normalized, priority).finally(() => this.pending.delete(normalized));
    this.pending.set(normalized, opened);
    return opened;
  }

  snapshot(): LoyaltyOpsSnapshot["cache"] {
    return {
      entries: this.cache.size,
      ttlSeconds: Math.round(this.cacheTtlMs / 1000),
      hits: this.hits,
      misses: this.misses,
      staleServed: this.staleServed,
    };
  }

  private async balanceFor(email: string, priority: LoyaltyPriority, allowStale: boolean): Promise<number> {
    const normalized = normalizeEmail(email);
    const account = this.findAccount(normalized);
    // Kto jeszcze nic nie kupił (brak karty albo bonus wciąż należny), ma z definicji
    // bonus powitalny — bez wywołania Voucherify i bez zakładania karty.
    if (!account || account.welcomePending === 1) return this.welcomePoints;

    const display = (raw: number) =>
      // Niepewna próba bonusu: dopóki karta ma 0, bonus wciąż się klientowi należy.
      account.welcomePending === 2 && raw === 0 ? this.welcomePoints : raw;

    const fresh = this.cached(normalized, this.cacheTtlMs);
    if (fresh !== null) {
      this.hits += 1;
      return display(fresh);
    }
    this.misses += 1;

    try {
      const raw = await this.provider.getBalance(account.memberId, priority);
      this.remember(normalized, raw);
      return display(raw);
    } catch (error) {
      if (allowStale) {
        const stale = this.cached(normalized, this.staleTtlMs);
        if (stale !== null) {
          this.staleServed += 1;
          return display(stale);
        }
      }
      throw asUnavailable(error);
    }
  }

  private async openAccount(email: string, priority: LoyaltyPriority): Promise<LoyaltyAccount> {
    if (!this.findAccount(email)) {
      let member: { memberId: string; hasHistory?: boolean };
      try {
        member = await this.provider.createMember(email, priority);
      } catch (error) {
        throw asUnavailable(error);
      }

      // Karta, która już ma historię punktów (np. baza straciła mapowanie), dostała
      // bonus przy założeniu — Voucherify jest źródłem prawdy, nie dublujemy go.
      const owed = this.welcomePoints > 0 && !member.hasHistory;
      const nowIso = new Date(this.clock()).toISOString();
      // Wyścig dwóch instancji: wygrywa ten, kto pierwszy zapisał mapowanie.
      this.db
        .prepare(
          `INSERT INTO loyalty_accounts (email, member_id, welcomed_at, created_at, welcome_pending)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (email) DO NOTHING`,
        )
        .run(email, member.memberId, nowIso, nowIso, owed ? 1 : 0);
    }

    const account = this.findAccount(email);
    if (!account) throw new LoyaltyUnavailableError(new Error("Brak mapowania konta po zapisie."));
    if (account.welcomePending !== 0) await this.grantWelcome(account, priority);
    return { ...account, welcomePending: 0 };
  }

  /**
   * Bonus powitalny dokładnie raz: najpierw „zajmujemy” go w bazie (UPDATE … WHERE
   * welcome_pending = stan), dopiero potem korygujemy saldo. Druga instancja albo
   * równoległy request nie przyzna go drugi raz. Po błędzie przywracamy stan:
   * 1, gdy korekta na pewno nie doszła (429, budżet, bezpiecznik, 4xx), albo 2, gdy
   * wynik jest niepewny (timeout, 5xx) — wtedy następna próba najpierw sprawdza saldo
   * (przed bonusem karta ma 0, bo każdy zapis najpierw kończy bonus).
   */
  private async grantWelcome(account: LoyaltyAccount, priority: LoyaltyPriority): Promise<void> {
    const claimed = this.db
      .prepare("UPDATE loyalty_accounts SET welcome_pending = 0 WHERE email = ? AND welcome_pending = ?")
      .run(account.email, account.welcomePending);
    if (Number(claimed.changes) === 0) return;

    let restore: WelcomeState = account.welcomePending;
    try {
      if (account.welcomePending === 2) {
        // Świeży odczyt z cache jest późniejszy niż nieudana próba (błąd czyści cache),
        // więc wystarczy — checkout właśnie przeczytał saldo przy wstępnym sprawdzeniu.
        let current = this.cached(account.email, this.cacheTtlMs);
        if (current === null) {
          current = await this.provider.getBalance(account.memberId, priority);
          this.remember(account.email, current);
        }
        if (current > 0) {
          this.markWelcomed(account.email);
          return;
        }
        restore = 1;
      }
      const balance = await this.provider.adjustPoints(account.memberId, this.welcomePoints, "welcome", priority);
      this.remember(account.email, balance);
      this.markWelcomed(account.email);
    } catch (error) {
      this.forget(account.email);
      const state: WelcomeState = isDefinitelyNotApplied(error) ? restore : 2;
      this.db
        .prepare("UPDATE loyalty_accounts SET welcome_pending = ? WHERE email = ? AND welcome_pending = 0")
        .run(state, account.email);
      throw asUnavailable(error);
    }
  }

  private markWelcomed(email: string): void {
    this.db
      .prepare("UPDATE loyalty_accounts SET welcomed_at = ? WHERE email = ?")
      .run(new Date(this.clock()).toISOString(), email);
  }

  private cached(email: string, maxAgeMs: number): number | null {
    if (maxAgeMs <= 0) return null;
    const entry = this.cache.get(email);
    if (!entry) return null;
    return this.clock() - entry.at < maxAgeMs ? entry.points : null;
  }

  private remember(email: string, points: number): void {
    if (this.staleTtlMs <= 0) return;
    // delete + set przesuwa wpis na koniec — najstarsze wpisy są na początku mapy.
    this.cache.delete(email);
    this.cache.set(email, { points, at: this.clock() });
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private forget(email: string): void {
    this.cache.delete(email);
  }

  private findAccount(email: string): LoyaltyAccount | null {
    const row = this.db
      .prepare("SELECT email, member_id, welcome_pending FROM loyalty_accounts WHERE email = ?")
      .get(email) as unknown as LoyaltyAccountRow | undefined;
    if (!row) return null;
    const pending = Number(row.welcome_pending);
    return {
      email: row.email,
      memberId: row.member_id,
      welcomePending: pending === 1 || pending === 2 ? pending : 0,
    };
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Odmowa, po której wiadomo, że saldo w Voucherify się nie zmieniło. */
function isDefinitelyNotApplied(error: unknown): boolean {
  if (error instanceof LoyaltyThrottledError || error instanceof CircuitOpenError) return true;
  return (
    error instanceof LoyaltyProviderError &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500
  );
}

function asUnavailable(error: unknown): Error {
  if (error instanceof InsufficientPointsError || error instanceof LoyaltyUnavailableError) return error;
  if (error instanceof LoyaltyThrottledError) return new LoyaltyUnavailableError(error, error.retryAfterSeconds);
  return new LoyaltyUnavailableError(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
