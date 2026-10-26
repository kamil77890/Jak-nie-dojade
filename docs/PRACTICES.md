# Praktyki E04–E06 w kodzie

Ten dokument tłumaczy, gdzie w projekcie siedzą praktyki z lekcji **E04 (gdy zależność pada)**, **E05 (przeciążenie)** i **E06 (praca w tle)** oraz jak je zobaczyć na żywo.

Najszybsza ścieżka: `pnpm dev`, wejdź na `/lab`, ustaw tryb dostawcy poczty i kup bilet. Panel pokazuje stan bezpiecznika, kolejki, pul i skrzynki.

---

## E04 — gdy zależność pada

### Zależność

Zewnętrzną zależnością w Etapie I jest **dostawca e-mail** (`apps/mock-mail`). Bilet i kod powstają lokalnie, więc poczta jest zależnością **niekrytyczną**. Płatność jest poza zakresem etapu — gdy dojdzie w Etapie II, będzie zależnością krytyczną z tym samym zestawem narzędzi.

To jest świadoma decyzja produktowa: awaria poczty nie może cofnąć biletu. Użytkownik dostaje kod od razu, a wiadomość czeka w kolejce.

### Timeout

`apps/api/src/mail.ts` — `HttpMailer`:

```ts
fetch(url, {
  // ...
  signal: AbortSignal.timeout(this.timeoutMs), // domyślnie 1200 ms
});
```

- Timeout dotyczy **odpowiedzi zależności**, nie całego requestu użytkownika.
- Po timeoucie `fetch` rzuca `TimeoutError`, które zamieniamy na `MailDeliveryError` z `retryable: true`.
- Tryb **Wolny 3 s** w `/lab` ustawia opóźnienie większe niż timeout. Widać, że request nie wisi 3 s — zależność jest odcinana po 1,2 s.

Timeout nie rozwiązuje problemu sam: zamienia wiszenie w błąd. Dlatego pod nim jest retry i bezpiecznik.

### Retry

`apps/api/src/resilience.ts` — `withRetry`, używany w `apps/api/src/worker.ts`:

- domyślnie **2 próby** (`MAIL_RETRY_ATTEMPTS`),
- backoff wykładniczy: `base * 2^(attempt-1)` (`MAIL_RETRY_BASE_DELAY_MS`, domyślnie 250 ms),
- ponawiamy tylko błędy przejściowe: timeout, błąd sieci, `5xx`, `429`; `4xx` poza `429` jest trwały i od razu trafia do DLQ,
- **każda próba używa tego samego `Idempotency-Key`** (ID joba), więc retry nie stworzy drugiego e-maila.

Retry pomaga przy czkawce. Nie pomaga, gdy dostawca leży pięć minut — wtedy każdy request znów by próbował. Od tego jest bezpiecznik.

### Circuit breaker

`apps/api/src/resilience.ts` — `CircuitBreaker`:

| Stan | Zachowanie | Przejście |
| --- | --- | --- |
| `CLOSED` | requesty przechodzą, liczymy błędy | po `threshold` błędów → `OPEN` |
| `OPEN` | natychmiastowy błąd, bez wołania zależności | po `resetTimeoutMs` → `HALF_OPEN` |
| `HALF_OPEN` | przepuszczamy jeden request próbny | sukces → `CLOSED`, błąd → `OPEN` |

Domyślnie: próg **4 błędy** (`MAIL_BREAKER_FAILURE_THRESHOLD`), reset **15 s** (`MAIL_BREAKER_RESET_MS`). Bezpiecznik jest wspólny dla wszystkich requestów w procesie — pamięta historię całego serwera, a nie jednego żądania.

Kolejność warstw jest zgodna z lekcją:

```text
retry → breaker → fetch z timeoutem
```

Retry obejmuje bezpiecznik, więc każda próba jest osobnym zdarzeniem dla breakera. Gdy obwód jest otwarty, `CircuitOpenError` jest błędem przejściowym dla joba: worker odłoży go na później, zamiast wywalać proces.

Stan widać w `/lab` jako `zamknięty / otwarty / półotwarty` oraz w `GET /api/ops/status`.

### Fallback i łagodna degradacja

Nie używamy `breaker.fallback()`, bo wtedy `fire()` nigdy nie rzuciłby błędu i retry nie miałby czego ponawiać. Fallback jest na poziomie produktu:

1. **Zakup kończy się sukcesem** — bilet i kod są lokalne, niezależne od poczty.
2. **E-mail zostaje w kolejce** — job ma retry, backoff i DLQ. To zastępcza ścieżka zamiast synchronicznej wysyłki.
3. **UI nie kłamie** — ekran biletu mówi „potwierdzenie wyślemy w tle”, a nie „wysłano”. Panel `/lab` pokazuje faktyczny stan joba i skrzynki.
4. **Nigdy nie zwracamy fałszywego „sent”** — brak wiadomości w skrzynce jest widoczny.

To jest graceful degradation: kasa działa dalej w okrojonej wersji (bez potwierdzenia e-mail), zamiast odpowiadać błędem na cały zakup.

### Co się dzieje w awarii

| Sytuacja | Zakup | Job | Użytkownik |
| --- | --- | --- | --- |
| poczta zdrowa | 200 + kod | wysłany i ack | bilet + e-mail |
| poczta wolna (3 s) | 200 + kod | timeout, retry, potem backoff | bilet od razu, e-mail później |
| poczta down | 200 + kod | retry → breaker → DLQ po limicie | bilet od razu, e-mail w DLQ |
| poczta wróci | bez zmian | job z DLQ można przywrócić | e-mail po „Ponów” |
| brak mocka | 200 + kod | błędy sieci, DLQ | bilet od razu |

---

## E05 — przeciążenie

### Rate limiting — token bucket

`apps/api/src/resilience.ts` — `TokenBucket`, podłączony w `apps/api/src/app.ts`.

| Zakres | Pojemność | Dopełnianie | Klucz |
| --- | --- | --- | --- |
| globalny `/api` | 300 żetonów | 10/s | IP |
| `POST /api/reservations` | 60 | 2/s | IP |
| `POST /api/reservations/:id/purchase` | 40 | 2/s | IP |

Token bucket pozwala na krótki skok do pojemności wiadra, ale stały zalew ogranicza tempo dopełniania. Po przekroczeniu:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 60
```

```json
{ "error": "RATE_LIMITED", "retryAfter": 60 }
```

Dodatkowo odpowiedź niesie `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset`.

W wielu instancjach licznik w pamięci nie wystarcza — każdy proces miałby własne wiadro. Wtedy trzeba wspólnego licznika (Redis/Upstash) i atomowej operacji, dokładnie jak w E05.

### Load shedding

`apps/api/src/app.ts` — hook `onRequest`:

- licznik `inFlight` obejmuje requesty aktualnie obsługiwane,
- po przekroczeniu `LOAD_SHED_MAX_IN_FLIGHT` (domyślnie 80) od razu zwracamy `503 OVERLOADED` z `Retry-After`,
- healthcheck `/api/health` jest wyłączony z load sheddingu i globalnego limitu, żeby monitoring wiedział, że proces żyje.

`429` mówi „ty wysyłasz za dużo”. `503` mówi „my mamy za dużo”. To różne decyzje i różne komunikaty w UI.

### Bulkhead

`apps/api/src/resilience.ts` — `Bulkhead`, dwie osobne pule:

| Pula | Współbieżność | Kolejka | Co chroni |
| --- | --- | --- | --- |
| odczyt | 32 | 100 | mapa i lista kursów |
| zapis | 8 | 40 | rezerwacja i zakup |

Wolny odczyt nie zabiera całej puli zapisom. Jeśli kolejka puli jest pełna albo oczekiwanie przekroczy `BULKHEAD_WAIT_MS` (1 s), odpowiadamy `503 BUSY`. Pule widać w `/lab` jako `aktywne / współbieżność` i `w kolejce`.

### Test na żywo

W `/lab` kliknij **Test limitu: 30 prób zakupu**. To 30 równoległych `POST /purchase` na nieistniejący ID:

- 20 requestów przechodzi limit i dostaje `404 RESERVATION_NOT_FOUND`,
- 10 dostaje `429 RATE_LIMITED`,
- test nie tworzy żadnych rezerwacji.

Przy większym tłoku zobaczyłbyś także `503` z load sheddingu lub bulkheada. Panel pokazuje licznik `load shedding 503` i `rate limit 429`.

---

## E06 — praca w tle

### Kolejka

`apps/api/src/jobs.ts` — tabela `jobs` w tej samej bazie SQLite co `reservations`:

```text
id, task, input, created_at, visible_at,
total_tried, completed_at, has_error, last_error
```

Operacje:

| Operacja | Kto | Co robi |
| --- | --- | --- |
| enqueue | API, w transakcji zakupu | `INSERT` joba `send-ticket-email` |
| claim | worker | bierze najstarszy widoczny job i przesuwa `visible_at` w przyszłość (lease) |
| ack | worker | `completed_at = now` **po** wysłaniu |
| retry | worker | `visible_at = now + backoff`, `total_tried++` |
| DLQ | worker | po limicie prób `has_error = 1` |

`visible_at` pełni rolę leased visibility: job nie znika po wzięciu, ale inny worker go nie weźmie, dopóki lease trwa. Jeśli worker padnie, job wróci po lease.

### Zakup + enqueue = jedna transakcja

`apps/api/src/booking.ts` — `purchase()`:

```text
BEGIN IMMEDIATE
  sprawdź rezerwację i czas
  ustaw status = purchased, code
  INSERT job send-ticket-email
COMMIT
```

Dzięki temu nie ma sytuacji „bilet kupiony, ale job zniknął” ani „job jest, ale zakup się cofnął”. To jest exactly-once **dla enqueue**.

### Ack po pracy — at-least-once

`apps/api/src/worker.ts`:

```text
claim → wyślij e-mail → ack
```

Ack jest po wysyłce. Jeśli worker padnie między wysłaniem a ack, job wróci i spróbuje ponownie. To jest **at-least-once**: e-mail może zostać wysłany dwa razy, ale nie zginie.

### Idempotencja — efekt exactly-once

Każdy job ma `Idempotency-Key = job.id`, wysyłany do dostawcy w każdej próbie. Mock (i realny dostawca, jeśli wspiera klucz) deduplikuje:

- pierwszy request zapisuje wiadomość,
- retry z tym samym kluczem dostaje `duplicate: true` i nie tworzy drugiej wiadomości,
- nawet jeśli worker padnie po wysłaniu, a przed ack, powtórka nie zdubluje wiadomości.

To jest wzorzec „at-least-once + idempotent consumer = efekt exactly-once”. Nie da się objąć zewnętrznego dostawcy transakcją SQLite, więc nie udajemy, że mamy exactly-once po stronie wysyłki.

### Retry, backoff i DLQ

- `WORKER_MAX_ATTEMPTS` (domyślnie 5) — po tylu podejściach job idzie do DLQ,
- backoff: `base * 2^(tried-1)`, ograniczony `WORKER_MAX_BACKOFF_MS`,
- błąd trwały (np. `4xx` poza `429`, brak rezerwacji) od razu do DLQ,
- job w DLQ nie blokuje kolejki; można go przywrócić z `/lab` przyciskiem **Ponów**.

To jest odpowiedź na poison message: limit prób + odłożenie na bok, a nie nieskończone kręcenie workera.

### Worker

- działa w procesie API (`WORKER_ENABLED=true`), startuje po zbudowaniu aplikacji,
- interwał `WORKER_INTERVAL_MS` (250 ms), jedno przejście bierze maksymalnie 20 jobów,
- `stop()` czeka na bieżące przejście i jest wywoływany przy zamknięciu API,
- lease `WORKER_LEASE_MS` (30 s) chroni przed dwoma workerami w tej samej instancji,
- brak crona: kolejkę napędza interwał workera, a wygasanie rezerwacji jest leniwe.

W produkcji worker powinien być osobnym procesem (albo kolejką zarządzaną, np. BullMQ/Temporal/Inngest). Struktura claim/ack/lease jest już rozdzielona, więc przeniesienie nie zmienia kontraktu.

### Gwarancje — uczciwie

| Gwarancja | Gdzie | Co może się stać |
| --- | --- | --- |
| enqueue | transakcja SQLite | ani zguba, ani duplikat |
| wysyłka | at-least-once | e-mail może być wysłany 2×, ale klucz idempotencyjny deduplikuje |
| ack | po pracy | padnięcie workera powoduje retry, nie zgubę |
| DLQ | limit prób | zatruty job czeka na człowieka |

---

## Scenariusze demo

### 1. Zależność pada (E04 + E06)

1. `/lab` → **Awaria**.
2. Kup bilet.
3. Bilet jest wydany, kod widoczny.
4. Wróć do `/lab`: job w retry, bezpiecznik `OTWARTY`, po limicie prób `DLQ`.
5. **Zdrowy** → **Ponów** przy jobie.
6. Job `ZROBIONY`, wiadomość w skrzynce.

### 2. Poczta zwalnia (E04 — timeout)

1. `/lab` → **Wolny 3 s**.
2. Kup bilet.
3. Bilet jest od razu; job zalicza timeout (1,2 s) i retry.
4. Po powrocie do zdrowia wiadomość dojdzie.

### 3. Ruch rośnie (E05)

1. `/lab` → **Test limitu: 30 prób zakupu**.
2. Około 10 odpowiedzi to `429`, reszta `404`.
3. Licznik `rate limit 429` rośnie; pule odczytu i zapisu pokazują obciążenie.
4. Przy prawdziwym tłoku load shedding odrzuci nadmiar szybkim `503`.

---

## Testy, które pilnują praktyk

| Plik | Co sprawdza |
| --- | --- |
| `apps/api/test/resilience.test.ts` | retry, stany breakera, token bucket, bulkhead i timeout kolejki |
| `apps/api/test/worker.test.ts` | ack po pracy, retry z backoffem, DLQ, przywracanie joba, ten sam klucz idempotencyjny |
| `apps/api/test/guards.test.ts` | 429 z `Retry-After`, globalny limit, load shedding 503, healthcheck poza ochroną, panel ops |
| `apps/api/test/reservations.test.ts` | atomowość miejsca, TTL, idempotentny zakup, enqueue w transakcji |
| `packages/shared/test/shared.test.ts` | jedno źródło TTL, etykiety, fixtures |

Uruchomienie: `pnpm test`.

---

## Mapa kodu

```text
apps/api/src/
  app.ts          load shedding, globalny limit, pule, hooki, error envelope
  resilience.ts   CircuitBreaker, withRetry, TokenBucket, Bulkhead
  mail.ts         HttpMailer z AbortSignal.timeout, klient panelu mocka
  worker.ts       claim → retry/breaker → send → ack; snapshot workera
  jobs.ts         kolejka, lease, backoff, DLQ, statystyki
  booking.ts      rezerwacja/zakup, lazy expiry, transakcja zakupu + job
  db.ts           schema SQLite, BEGIN IMMEDIATE
  routes/         events, reservations, ops
apps/mock-mail/   zewnętrzny dostawca: /send, /control, /messages, /reset
apps/web/src/     ekrany A/B/C, licznik, bilet, /lab
```

## Czego te praktyki nie rozwiązują

- Rate limiting w pamięci nie działa między instancjami — potrzebny wspólny licznik.
- SQLite ma jednego writera; to demo, nie system pod prawdziwe 10× obciążenie.
- Idempotencja zależy od tego, czy dostawca honoruje `Idempotency-Key`.
- Panel `/lab` nie ma autoryzacji; na produkcji wyłącz go albo dodaj auth.
- Worker w API dzieli zasoby z requestami; w produkcji warto go rozdzielić (bulkhead procesowy).
