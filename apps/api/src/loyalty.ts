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

/** Karta znaleziona albo założona w Voucherify. */
export interface MemberLookup {
  memberId: string;
  /** Karta już kiedyś dostała punkty, więc bonus powitalny był przyznany. */
  hasHistory: boolean;
  /** Saldo z tej samej odpowiedzi (jeśli dostawca je podał) — bez dodatkowego wywołania. */
  balance?: number;
}

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
  createMember(email: string, priority?: LoyaltyPriority): Promise<MemberLookup>;
  /**
   * Szuka istniejącej karty klienta (np. założonej w panelu albo w kasie) bez zakładania
   * nowej. Brak metody = dostawca nie umie szukać, traktujemy to jak „brak karty”.
   */
  findMember?(email: string, priority?: LoyaltyPriority): Promise<MemberLookup | null>;
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

  async createMember(email: string, priority: LoyaltyPriority = "checkout"): Promise<MemberLookup> {
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
      if (body.code) return toLookup(body.code, body);
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

  /**
   * Lista członków kampanii filtrowana po kliencie (`customer` = source_id = e-mail):
   * karta założona poza sklepem (panel, kasa) albo zgubione mapowanie. Odpowiedź niesie
   * `loyalty_card.balance`, więc saldo znamy bez drugiego wywołania.
   */
  async findMember(email: string, priority: LoyaltyPriority = "read"): Promise<MemberLookup | null> {
    const body = await this.request<{ data?: VoucherifyMember[]; vouchers?: VoucherifyMember[] }>(
      "GET",
      `/v1/loyalties/${encodeURIComponent(this.options.campaignId)}/members?customer=${encodeURIComponent(email)}&limit=1`,
      undefined,
      priority,
      true,
    );
    const first = body.data?.[0] ?? body.vouchers?.[0];
    return first?.code ? toLookup(first.code, first) : null;
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

function toLookup(code: string, member: VoucherifyMember): MemberLookup {
  const balance = member.loyalty_card?.balance;
  return {
    memberId: code,
    hasHistory: hasHistory(member),
    ...(typeof balance === "number" ? { balance: Math.trunc(balance) } : {}),
  };
}

/**
 * Lokalny dostawca dla dev/testów: saldo w pamięci procesu, bez limitu wywołań.
 * `allowNegative` udaje dostawcę, który NIE odrzuca salda poniżej zera — nasza logika
 * nie może na tym polegać (test wyścigu dwóch checkoutów na jednym saldzie).
 */
export class MemoryLoyaltyProvider implements LoyaltyProvider {
  readonly name = "memory" as const;
  protected readonly balances = new Map<string, number>();
  protected readonly credited = new Set<string>();

  constructor(private readonly options: { allowNegative?: boolean } = {}) {}

  async createMember(email: string): Promise<MemberLookup> {
    if (!this.balances.has(email)) this.balances.set(email, 0);
    return { memberId: email, hasHistory: this.credited.has(email) };
  }

  async findMember(email: string): Promise<MemberLookup | null> {
    const balance = this.balances.get(email);
    if (balance === undefined) return null;
    return { memberId: email, hasHistory: this.credited.has(email) || balance !== 0, balance };
  }

  async getBalance(memberId: string): Promise<number> {
    return this.balances.get(memberId) ?? 0;
  }

  async adjustPoints(memberId: string, delta: number, _reason: string): Promise<number> {
    const next = (this.balances.get(memberId) ?? 0) + delta;
    if (next < 0 && !this.options.allowNegative) {
      throw new LoyaltyProviderError("Za mało punktów.", false, 400, true);
    }
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
  /** Numer kolejny zapisu: wpis jest „świeży pod blokadą”, gdy powstał po jej wzięciu. */
  seq: number;
}

export interface LoyaltyServiceOptions {
  /** Jak długo odczyt salda z Voucherify jest „świeży” (0 = bez cache). */
  cacheTtlMs?: number;
  /** Do jakiego wieku stary odczyt może zastąpić 503 przy samym wyświetlaniu salda. */
  staleTtlMs?: number;
  /** Jak długo pamiętamy, że e-mail nie ma karty w Voucherify (0 = pytamy za każdym razem). */
  noCardTtlMs?: number;
  /** Górna granica wpisów — cache nie może zjeść pamięci przy zalewie różnych e-maili. */
  maxCacheEntries?: number;
}

/**
 * Blokada pobrań punktów jednego e-maila (`LoyaltyService.withSpendLock`).
 * `since` = numer ostatniego zapisu cache w chwili wzięcia blokady.
 */
export interface SpendLock {
  readonly email: string;
  readonly since: number;
}

/**
 * Pobranie zeszło poniżej zera, choć saldo sprawdziliśmy tuż przed nim pod blokadą:
 * dostawca przyjął ujemne saldo, a ktoś poza naszym procesem (panel, druga instancja)
 * wydał punkty w międzyczasie. Punkty trzeba oddać; dla klienta to 409 INSUFFICIENT_POINTS.
 */
export class OverdrawnError extends InsufficientPointsError {
  constructor(public readonly points: number) {
    super();
    this.name = "OverdrawnError";
  }
}

/**
 * Warstwa między API a Voucherify: mapowanie e-mail → karta, bonus powitalny
 * (1000 punktów) i operacje na saldzie. Baza trzyma wyłącznie `member_id`.
 *
 * Oszczędzanie limitu Voucherify (Sandbox: 100 wywołań/h):
 * - odczyt salda NIE zakłada karty. E-mail bez mapowania kosztuje jedno wyszukanie
 *   karty (mogła powstać w panelu albo w kasie); „brak karty” pamiętamy `noCardTtlMs`,
 *   a bez budżetu odczytów pokazujemy bonus powitalny bez pytania,
 * - kartę i bonus zakładamy leniwie przy pierwszym zapisie (pobranie albo naliczenie punktów),
 * - krótki cache salda w pamięci procesu. To tylko optymalizacja odczytu — źródłem prawdy
 *   pozostaje Voucherify, a saldo może zmienić się poza nami (np. korekta marketingu
 *   w panelu), stąd krótki TTL. Każda nasza korekta zwraca nowe saldo i od razu
 *   nadpisuje wpis; nieudana korekta (wynik nieznany) usuwa go. Checkout cache nie używa:
 *   decyduje świeży odczyt pod blokadą e-maila (`withSpendLock`).
 */
export class LoyaltyService {
  private readonly pending = new Map<string, Promise<LoyaltyAccount>>();
  private readonly cache = new Map<string, CacheEntry>();
  /** E-mail → kiedy Voucherify potwierdził, że karty nie ma. */
  private readonly noCard = new Map<string, number>();
  private readonly spendLocks = new Map<string, Promise<unknown>>();
  private readonly cacheTtlMs: number;
  private readonly staleTtlMs: number;
  private readonly noCardTtlMs: number;
  private readonly maxCacheEntries: number;
  private seq = 0;
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
    this.noCardTtlMs = Math.max(0, options.noCardTtlMs ?? 0);
    this.maxCacheEntries = Math.max(1, options.maxCacheEntries ?? 10_000);
  }

  get providerName(): "voucherify" | "memory" {
    return this.provider.name;
  }

  /**
   * Saldo do wyświetlenia (`GET /api/loyalty`). Najniższy priorytet budżetu; gdy
   * Voucherify jest niedostępny albo budżet się skończył, oddaje niedawny odczyt
   * z cache (do `staleTtlMs`), a bez niego rzuca 503 LOYALTY_UNAVAILABLE.
   *
   * E-mail bez mapowania: jedno wyszukanie karty w Voucherify. Jest karta (panel, kasa,
   * zgubione mapowanie) → zapisujemy mapowanie i pokazujemy jej saldo. Nie ma → bonus
   * powitalny. Brak budżetu odczytów albo awaria → też bonus powitalny, bez 503: tak
   * odpowiadaliśmy zawsze nowemu klientowi, a checkout i tak sprawdza prawdziwą kartę
   * przed pobraniem (najwyżej odmówi 409), więc nic nie zostanie wydane „na kredyt”.
   */
  async readBalance(email: string): Promise<number> {
    const normalized = normalizeEmail(email);
    if (!this.findAccount(normalized) && !(await this.adoptForRead(normalized))) {
      return this.welcomePoints;
    }
    return this.balanceFor(normalized);
  }

  /**
   * Blokada pobrań punktów jednego e-maila (w obrębie procesu): świeży odczyt salda
   * i pobranie idą jedno po drugim, więc dwa równoległe checkouty na jednym saldzie
   * nie przejdą oba — nawet gdy dostawca przyjmuje saldo ujemne. Zwroty i naliczenia
   * tylko dodają punkty, więc blokady nie potrzebują (najwyżej zwiększą saldo).
   */
  async withSpendLock<T>(email: string, fn: (lock: SpendLock) => Promise<T>): Promise<T> {
    const normalized = normalizeEmail(email);
    const previous = this.spendLocks.get(normalized) ?? Promise.resolve();
    const start = () => fn({ email: normalized, since: this.seq });
    const run = previous.then(start, start);
    const tail = run.catch(() => undefined);
    this.spendLocks.set(normalized, tail);
    void tail.then(() => {
      if (this.spendLocks.get(normalized) === tail) this.spendLocks.delete(normalized);
    });
    return run;
  }

  /**
   * Faza 1 checkoutu (pod blokadą, zanim ruszymy cokolwiek u Stripe'a): czy klient ma
   * `needed` punktów. Saldo karty czytamy świeżo z Voucherify — cache się nie liczy,
   * chyba że wpis powstał już pod tą blokadą. Nic nie zapisuje; rzuca 409 albo 503.
   *
   * E-mail bez karty ma z definicji bonus powitalny. Voucherify pytamy dopiero, gdy klient
   * chce więcej niż bonus (może mieć kartę z panelu z wyższym saldem). Gdy chce najwyżej
   * bonus, kartę i jej prawdziwe saldo sprawdzi faza 2 (`spendPoints`) przed pobraniem —
   * to samo wywołanie, które i tak zakłada kartę, więc bez dodatkowego kosztu.
   */
  async assertCanSpend(lock: SpendLock, needed: number): Promise<void> {
    if (needed <= 0) return;
    let account = this.findAccount(lock.email);
    if (!account) {
      if (needed <= this.welcomePoints) return;
      if (this.noCardFresh(lock.email)) throw new InsufficientPointsError();
      let found: MemberLookup | null;
      try {
        found = await this.findMember(lock.email, "checkout");
      } catch (error) {
        throw asUnavailable(error);
      }
      if (!found) {
        this.rememberNoCard(lock.email);
        throw new InsufficientPointsError();
      }
      account = this.adopt(lock.email, found);
    }
    if ((await this.spendableBalance(account, lock)) < needed) throw new InsufficientPointsError();
  }

  /**
   * Faza 2 checkoutu (pod tą samą blokadą, tuż przed sesją Stripe'a): zakłada kartę
   * i bonus, jeśli trzeba, jeszcze raz porównuje saldo z `points` i pobiera punkty.
   * Ponowne porównanie zwykle nic nie kosztuje — odczyt z fazy 1 albo wynik bonusu są
   * już „świeże pod blokadą”; wywołanie jest potrzebne tylko, gdy faza 1 nie pytała
   * Voucherify, a karta okazała się istniejąca (założona poza sklepem).
   * Zwraca nowe saldo; `OverdrawnError`, gdy mimo to zeszło poniżej zera.
   */
  async spendPoints(lock: SpendLock, points: number): Promise<number> {
    const account = await this.ensureAccount(lock.email, "checkout");
    if ((await this.spendableBalance(account, lock)) < points) throw new InsufficientPointsError();
    let balance: number;
    try {
      balance = await this.provider.adjustPoints(account.memberId, -points, "checkout", "checkout");
    } catch (error) {
      this.forget(account.email);
      if (error instanceof LoyaltyProviderError && error.insufficient) throw new InsufficientPointsError();
      throw asUnavailable(error);
    }
    this.remember(account.email, balance);
    if (balance < 0) throw new OverdrawnError(points);
    return balance;
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

  private async balanceFor(normalized: string): Promise<number> {
    const account = this.findAccount(normalized);
    // Bonus wciąż należny (karta bez historii): klient ma z definicji bonus powitalny.
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
      const raw = await this.provider.getBalance(account.memberId, "read");
      this.remember(normalized, raw);
      return display(raw);
    } catch (error) {
      const stale = this.cached(normalized, this.staleTtlMs);
      if (stale !== null) {
        this.staleServed += 1;
        return display(stale);
      }
      throw asUnavailable(error);
    }
  }

  /** Odczyt dla e-maila bez mapowania: true = karta istnieje i ma już mapowanie. */
  private async adoptForRead(email: string): Promise<boolean> {
    if (this.noCardFresh(email)) return false;
    let found: MemberLookup | null;
    try {
      found = await this.findMember(email, "read");
    } catch {
      // Brak budżetu odczytów, 429 albo awaria: jak dla nowego klienta (patrz readBalance).
      return false;
    }
    if (!found) {
      this.rememberNoCard(email);
      return false;
    }
    this.adopt(email, found);
    return true;
  }

  private async findMember(email: string, priority: LoyaltyPriority): Promise<MemberLookup | null> {
    if (!this.provider.findMember) return null;
    return this.provider.findMember(email, priority);
  }

  /**
   * Zapisuje mapowanie karty znalezionej albo założonej w Voucherify. Karta z historią
   * punktów dostała już bonus (Voucherify jest źródłem prawdy, nie dublujemy go); karta
   * bez historii ma bonus należny (`welcome_pending = 1`), przyzna go pierwszy zapis.
   * Wyścig dwóch instancji: wygrywa ten, kto pierwszy zapisał mapowanie.
   */
  private adopt(email: string, found: MemberLookup): LoyaltyAccount {
    const owed = this.welcomePoints > 0 && !found.hasHistory;
    const nowIso = new Date(this.clock()).toISOString();
    this.db
      .prepare(
        `INSERT INTO loyalty_accounts (email, member_id, welcomed_at, created_at, welcome_pending)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (email) DO NOTHING`,
      )
      .run(email, found.memberId, nowIso, nowIso, owed ? 1 : 0);
    this.noCard.delete(email);
    if (found.balance !== undefined) this.remember(email, found.balance);
    const account = this.findAccount(email);
    if (!account) throw new LoyaltyUnavailableError(new Error("Brak mapowania konta po zapisie."));
    return account;
  }

  /**
   * Saldo, które klient może wydać, bez cache sprzed blokady: wpis zapisany po jej
   * wzięciu (nasz odczyt, wynik bonusu, zwrot) jest aktualny, starszy — nie.
   */
  private async spendableBalance(account: LoyaltyAccount, lock: SpendLock): Promise<number> {
    let raw: number;
    const entry = this.cache.get(account.email);
    if (entry && entry.seq > lock.since) {
      raw = entry.points;
    } else {
      try {
        raw = await this.provider.getBalance(account.memberId, "checkout");
      } catch (error) {
        this.forget(account.email);
        throw asUnavailable(error);
      }
      this.remember(account.email, raw);
    }
    if (account.welcomePending === 1) return raw + this.welcomePoints;
    if (account.welcomePending === 2 && raw === 0) return this.welcomePoints;
    return raw;
  }

  private async openAccount(email: string, priority: LoyaltyPriority): Promise<LoyaltyAccount> {
    if (!this.findAccount(email)) {
      let member: MemberLookup;
      try {
        member = await this.provider.createMember(email, priority);
      } catch (error) {
        throw asUnavailable(error);
      }
      this.adopt(email, member);
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
        // więc wystarczy — checkout właśnie przeczytał saldo w fazie 1.
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
    // Wpis powstaje także przy wyłączonym cache odczytów: checkout potrzebuje wiedzieć,
    // czy saldo jest świeże pod blokadą (`seq`). Rozmiar mapy i tak jest ograniczony.
    this.seq += 1;
    // delete + set przesuwa wpis na koniec — najstarsze wpisy są na początku mapy.
    this.cache.delete(email);
    this.cache.set(email, { points, at: this.clock(), seq: this.seq });
    trimOldest(this.cache, this.maxCacheEntries);
  }

  private forget(email: string): void {
    this.cache.delete(email);
  }

  private noCardFresh(email: string): boolean {
    const at = this.noCard.get(email);
    return at !== undefined && this.clock() - at < this.noCardTtlMs;
  }

  private rememberNoCard(email: string): void {
    if (this.noCardTtlMs <= 0) return;
    this.noCard.delete(email);
    this.noCard.set(email, this.clock());
    trimOldest(this.noCard, this.maxCacheEntries);
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

/** Mapy jako LRU: najstarsze wpisy są na początku, nadmiar odcinamy. */
function trimOldest(map: Map<string, unknown>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
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
