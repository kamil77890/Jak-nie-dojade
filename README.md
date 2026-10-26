# PAS / S01 / Etap I — kasa biletowa

Kasa biletowa w wariancie **Pociąg**: rozkład jazdy, mapa wagonu, rezerwacja miejsca na 15 minut i bilet z kodem. Bez logowania i bez płatności online — dokładnie w zakresie Etapu I.

Projekt realizuje plan z `Plan_Etapu_I_Pociag.pdf` (karty A, B, C) i dokłada praktyki z lekcji **E04–E06**:

- **E04 — gdy zależność pada:** timeout, retry, circuit breaker, fallback i łagodna degradacja,
- **E05 — przeciążenie:** rate limiting, load shedding i bulkhead,
- **E06 — praca w tle:** kolejka, claim/ack, idempotencja, backoff i dead letter queue.

## Szybki start

Wymagania: **Node 24+** (używamy wbudowanego `node:sqlite`) i **pnpm 10+**.

```bash
pnpm install
pnpm dev
```

`pnpm dev` uruchamia trzy procesy:

| Proces | Adres | Rola |
| --- | --- | --- |
| Web | <http://localhost:5173> | React + Vite, ekrany A/B/C i `/lab` |
| API | <http://localhost:3001> | Fastify, SQLite, worker kolejki |
| Mock e-mail | <http://localhost:3002> | zewnętrzny dostawca poczty do ćwiczenia E04 |

Nie musisz kopiować `.env` — wszystkie wartości mają sensowne domyślne ustawienia. Wzór jest w `.env.example`. API i mock poczty czytają `.env` z roota repo.

Build produkcyjny możesz obejrzeć lokalnie bez dodatkowej konfiguracji:

```bash
pnpm build
pnpm preview   # web na http://localhost:4173
```

## Demo w pięciu krokach

1. Wejdź na <http://localhost:5173> i wybierz pierwszy kurs.
2. Kliknij wolne miejsce w wagonie 5.
3. Wpisz imię i e-mail, kliknij **Rezerwuję na 15 minut**.
4. Zobacz licznik, kliknij **Kupuję bilet**.
5. Odbierz bilet z kodem `PAS-XXXXXX`; potwierdzenie e-mail pojawi się w skrzynce mocka.

### Demo odporności (E04 + E06)

Wejdź w **Laboratorium**, ustaw dostawcę e-mail na **Awaria**, a potem kup kolejny bilet.

- bilet nadal zostaje wydany — poczta nie jest krytyczna,
- job e-mail przechodzi w retry, bezpiecznik otwiera się, a po limicie prób job trafia do **DLQ**,
- wróć na **Zdrowy**, kliknij **Ponów** przy jobie z DLQ — wiadomość trafia do skrzynki.

### Demo przeciążenia (E05)

W laboratorium kliknij **Test limitu: 30 prób zakupu**. Test wysyła 30 zakupów nieistniejącej rezerwacji, więc nie tworzy danych. Oczekiwany wynik to około 20 × `404` i 10 × `429` — nadmiar zamienia się w szybką odmowę zamiast obciążenia bazy.

## Architektura

```text
apps/web (React + Vite)
   │  /api (proxy w dev)
   ▼
apps/api (Fastify) ──────────────► SQLite
   │                                  ├─ reservations
   │  HTTP + timeout/retry            └─ jobs
   ▼
apps/mock-mail (Fastify)         worker e-maili
   └─ /send, /control, /messages  (ten sam proces co API w Etapie I)
```

Monorepo:

| Ścieżka | Zawartość |
| --- | --- |
| `packages/shared` | typy, TTL, `formatSeatLabel`, `isReservationActive`, fixtures 3 kursów |
| `apps/api` | 4 endpointy kontraktu, SQLite, kolejka, worker, limity, panel ops |
| `apps/web` | rozkład, mapa wagonu, formularz, licznik, bilet, laboratorium |
| `apps/mock-mail` | osobny mock dostawcy poczty ze sterowaniem awarią |

Pełny kontrakt i decyzje: [`CONTRACT.md`](./CONTRACT.md).  
Mapowanie praktyk na kod i scenariusze: [`docs/PRACTICES.md`](./docs/PRACTICES.md).

## Kontrakt API

| Metoda | Endpoint | Sukces | Odmowy |
| --- | --- | --- | --- |
| `GET` | `/api/events` | `200 EventSummary[]` | — |
| `GET` | `/api/events/:id` | `200 { event, takenSeats }` | `404 EVENT_NOT_FOUND` |
| `POST` | `/api/reservations` | `201 { reservationId, expiresAt }` | `400`, `404`, `409 SEAT_UNAVAILABLE` |
| `POST` | `/api/reservations/:id/purchase` | `200 { code }` | `404`, `409 RESERVATION_EXPIRED` |

Wszystkie błędy mają envelope `{ error: string }`; status HTTP niesie znaczenie. Zakup jest idempotentny: drugi request zwraca ten sam kod i nie tworzy drugiego joba.

Dodatkowo, poza kontraktem:

- `GET /api/health` — healthcheck bez limitu i load sheddingu,
- `GET /api/ops/status`, `GET /api/ops/snapshot`, `GET /api/ops/jobs`, `POST /api/ops/jobs/:id/retry`,
- `GET /api/ops/mail/messages`, `POST /api/ops/mail/control`, `POST /api/ops/mail/reset`.

Panel ops można wyłączyć przez `OPS_ENABLED=false`.

## Gdzie siedzą praktyki

| Lekcja | Narzędzie | Implementacja | Co widać w `/lab` |
| --- | --- | --- | --- |
| E04 | Timeout | `apps/api/src/mail.ts` — `AbortSignal.timeout(1200)` | tryb **Wolny 3 s** kończy się timeoutem |
| E04 | Retry | `apps/api/src/resilience.ts` + `worker.ts` | liczba prób, backoff, ten sam `Idempotency-Key` |
| E04 | Circuit breaker | `apps/api/src/resilience.ts` | stan `zamknięty / otwarty / półotwarty` |
| E04 | Fallback i degradacja | `apps/api/src/worker.ts`, kolejka | bilet wydany mimo awarii poczty; e-mail czeka w tle |
| E05 | Rate limiting | `apps/api/src/app.ts` — token bucket per IP | `429` + `Retry-After` |
| E05 | Load shedding | `apps/api/src/app.ts` — limit in-flight | szybkie `503 OVERLOADED` |
| E05 | Bulkhead | `apps/api/src/resilience.ts` — osobne pule | odczyt i zapis nie zabierają sobie miejsc |
| E06 | Kolejka | `apps/api/src/jobs.ts` — tabela `jobs` | gotowe / retry / zrobione / DLQ |
| E06 | Ack po pracy | `apps/api/src/worker.ts` | at-least-once + idempotencja dostawcy |
| E06 | DLQ | `apps/api/src/jobs.ts` — limit prób | job „e-mail z biletem” w DLQ i przycisk **Ponów** |

### Dlaczego e-mail, a nie płatność?

Płatność jest poza zakresem Etapu I, więc jedyną zewnętrzną zależnością w demo jest dostawca poczty. Dzięki temu widać pełną lekcję E04 bez dokładania flow płatniczego: poczta może w ogóle nie działać, a bilet i tak jest ważny. Gdy w Etapie II dojdzie płatność, wzorzec jest ten sam — tylko decyzja „krytyczna / niekrytyczna” się zmienia.

## TTL i wygasanie

- Domyślnie rezerwacja trzyma miejsce **15 minut** (`RESERVATION_TTL_MINUTES`).
- Do testów i demo można użyć `RESERVATION_TTL_SECONDS`, np. `RESERVATION_TTL_SECONDS=20 pnpm dev`.
- `expiresAt` jest liczone na serwerze w UTC; przeglądarka tylko je pokazuje.
- Wygaszanie jest leniwe: każdy odczyt mapy i zakup sprawdza czas. Nie ma crona.
- Po TTL `takenSeats` nie zawiera miejsca, a zakup zwraca `409 RESERVATION_EXPIRED`.

## Testy i jakość

```bash
pnpm test        # 43 testy: shared, API, worker, resilience, guardy
pnpm typecheck   # TypeScript strict we wszystkich pakietach
pnpm build       # API + mock-mail + web
```

Testy API używają wstrzykiwanego zegara, więc wygaśnięcie TTL nie trwa 15 minut. Testy workera pokrywają ack, retry, DLQ i przywracanie joba. Testy resilience pokrywają stany bezpiecznika, token bucket i bulkhead.

## Konfiguracja

Najważniejsze zmienne (pełna lista w `.env.example`):

| Zmienna | Domyślnie | Opis |
| --- | --- | --- |
| `RESERVATION_TTL_MINUTES` | `15` | czas trzymania miejsca |
| `RESERVATION_TTL_SECONDS` | — | nadpisanie TTL w sekundach do demo/testów |
| `DATABASE_PATH` | `data/pas.sqlite` | SQLite; przy `pnpm dev` plik jest w `apps/api/data/` |
| `MAIL_TIMEOUT_MS` | `1200` | timeout zależności pocztowej |
| `MAIL_RETRY_ATTEMPTS` | `2` | próby w jednym podejściu workera |
| `MAIL_BREAKER_FAILURE_THRESHOLD` | `4` | ile błędów otwiera bezpiecznik |
| `MAIL_BREAKER_RESET_MS` | `15000` | po jakim czasie próbny request |
| `WORKER_MAX_ATTEMPTS` | `5` | limit podejść do joba przed DLQ |
| `WORKER_BASE_BACKOFF_MS` | `2000` | start backoffu kolejki |
| `LOAD_SHED_MAX_IN_FLIGHT` | `80` | próg load sheddingu |
| `READ_BULKHEAD_CONCURRENCY` | `32` | pula odczytów |
| `WRITE_BULKHEAD_CONCURRENCY` | `8` | pula zapisów |
| `OPS_ENABLED` | `true` | panel `/lab`; wyłącz na produkcji |

Reset danych demo:

```bash
rm -rf apps/api/data
```

## Co jest poza zakresem

Zgodnie z planem: płatności online, logowanie, miejsca pośrednie, anulowanie rezerwacji, aktualizacja mapy w czasie rzeczywistym. Dane demo to 3 kursy × 2 wagony × 20 miejsc.

## Ograniczenia i następne kroki

- **Jedna instancja:** SQLite i limity w pamięci są wystarczające na demo. Przy wielu instancjach potrzebny jest wspólny licznik (np. Redis/Upstash) i wspólna kolejka.
- **Worker w API:** w Etapie I worker działa w procesie API. Semantyka claim/ack/lease jest już rozdzielona, więc przeniesienie do osobnego procesu lub kolejki (BullMQ, Temporal, Inngest) nie zmienia kontraktu.
- **Idempotencja:** dostawca dostaje `Idempotency-Key = job.id`. To daje efekt exactly-once przy at-least-once dostarczaniu.
- **Bezpieczeństwo:** panel ops jest otwarty lokalnie; na produkcji ustaw `OPS_ENABLED=false` i dodaj auth. Rate limiting używa `request.ip`; za reverse proxy skonfiguruj zaufane nagłówki.
- **Etap II:** płatność dokłada się jako osobna zależność krytyczna, z własnym timeoutem, breakerem i fallbackiem `pending` — bez zmiany modelu rezerwacji i TTL.
