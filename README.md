# PAS / S01 / Etap II — kasa biletowa z płatnością Stripe

Kasa biletowa w wariancie **Pociąg**: rozkład jazdy, mapa wagonu, rezerwacja miejsca na 15 minut, płatność kartą przez **Stripe Checkout (tryb testowy)** i bilet z kodem. Bez logowania.

Etap I realizuje plan z `Plan_Etapu_I_Pociag.pdf` (karty A, B, C). Etap II dokłada płatność: karta A — Checkout, karta B — webhook, karta C — powrót do sklepu (szczegóły i lista zagrożeń w [`CONTRACT.md` §10](CONTRACT.md#10-etap-ii--płatność-stripe-checkout)). Całość dokłada praktyki z lekcji **E04–E06**:

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

## Płatności Stripe (Etap II)

Stripe działa **wyłącznie w trybie testowym** — żadne prawdziwe pieniądze nie są pobierane. Bez kluczy aplikacja działa, ale „Zapłać” odpowiada `503 PAYMENTS_UNAVAILABLE`.

1. W [panelu Stripe](https://dashboard.stripe.com/test/apikeys) (tryb testowy / sandbox) skopiuj **Secret key** `sk_test_…`. Klucz publiczny `pk_test_…` nie jest potrzebny: Checkout działa przez przekierowanie, przeglądarka nie dotyka Stripe.js.
2. Zainstaluj [Stripe CLI](https://docs.stripe.com/stripe-cli), zaloguj się i przekieruj webhooki na API:

   ```bash
   stripe login
   stripe listen --forward-to localhost:3001/api/webhooks/stripe
   ```

   CLI wypisze `whsec_…` — to sekret webhooka.
3. Dopisz oba sekrety do `.env` w root repo (plik jest w `.gitignore`, nie commituj go):

   ```bash
   STRIPE_SECRET_KEY=sk_test_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   PUBLIC_URL=http://localhost:5173
   ```

4. `pnpm dev`, zarezerwuj miejsce i kliknij **Zapłać 89 zł**.

| Karta testowa | Wynik |
| --- | --- |
| `4242 4242 4242 4242` | płatność udana → bilet |
| `4000 0000 0000 0002` | odmowa — zostajesz na Stripe'ie, możesz wrócić i zapłacić ponownie |
| `4000 0025 0000 3155` | 3D Secure → po potwierdzeniu bilet |

Data ważności dowolna w przyszłości, CVC dowolne trzy cyfry.

Na serwerze zamiast `stripe listen` dodaj w panelu Stripe (tryb testowy) endpoint `https://<twoja-domena>/api/webhooks/stripe` ze zdarzeniami `checkout.session.completed`, `checkout.session.async_payment_succeeded` i `checkout.session.expired`, a jego sekret ustaw jako `STRIPE_WEBHOOK_SECRET`. `PUBLIC_URL` ustaw na publiczny adres sklepu. Nauczyciela dodaj w Stripe jako członka zespołu z rolą tylko do odczytu.

**Idempotencja jest obowiązkowa:** `POST /api/reservations/:id/checkout` bez nagłówka `Idempotency-Key` dostaje `400`. Klient generuje jeden klucz na rezerwację, API wysyła do Stripe'a pochodny klucz przy tworzeniu sesji i przy zwrocie, a webhook księguje każde zdarzenie dokładnie raz.

## Wdrożenie: jeden proces, jeden adres

Na serwerze API serwuje też zbudowany frontend, więc strona i `/api` są pod tym samym adresem:

```bash
pnpm install
pnpm build                       # apps/api/dist + apps/web/dist
NODE_ENV=production RESERVATION_TTL_MINUTES=2 pnpm start
# za jednym reverse proxy dodaj: TRUST_PROXY=1
```

- Przy `NODE_ENV=production` API słucha na `0.0.0.0` (inaczej `127.0.0.1`), więc działa w kontenerze i na serwerze. `HOST` nadpisuje tę wartość, a port bierze się z `PORT` (domyślnie `3001`).
- Gdy istnieje `apps/web/dist/index.html`, API serwuje frontend. Trasy Reacta (`/lab`, `/events/...`) dostają `index.html`. `/api/*` dla nieznanych ścieżek i brakujące pliki dalej zwracają JSON `404 { "error": "NOT_FOUND" }`. Wyłączysz to przez `SERVE_WEB=false`, a inny katalog wskażesz przez `WEB_DIST_PATH`.
- `TRUST_PROXY` ustawiaj **tylko wtedy, gdy przed API naprawdę stoi proxy**. Bez proxy zostaw `false` (domyślnie): inaczej klient sam dopisze sobie `X-Forwarded-For` i obejdzie limit. Za jednym reverse proxy (nginx, Render, Railway) ustaw `TRUST_PROXY=1`, za dwoma (np. Cloudflare + nginx) `TRUST_PROXY=2` — to liczba proxy przed API. Wtedy limit liczy prawdziwe IP klienta, a podrobiony `X-Forwarded-For` go nie obchodzi, bo API bierze adres dopisany przez proxy, nie przez klienta. Nie używaj `TRUST_PROXY=true`: wtedy API ufa całemu nagłówkowi i ostrzega o tym przy starcie.
- Panel ops jest przy `NODE_ENV=production` domyślnie **wyłączony** (`/api/ops/*` → `404`). Patrz [Bezpieczeństwo panelu ops](#bezpieczeństwo-panelu-ops).
- Mock poczty (`apps/mock-mail`) na wdrożeniu nie jest potrzebny. Bez niego bilet nadal jest wydawany, a job e-mail po limicie prób trafia do DLQ.

## Tryb testowy prowadzącego

Warunek wstępny testu chaosu: `expiresAt` wypada **około 2 minut** od rezerwacji.

1. Ustaw `RESERVATION_TTL_MINUTES=2`.
2. **Usuń** `RESERVATION_TTL_SECONDS` z `.env` i ze zmiennych platformy. Ta zmienna ma pierwszeństwo przed `_MINUTES`, więc zapomniane `RESERVATION_TTL_SECONDS=20` po cichu psuje tryb testowy.
3. Po starcie sprawdź log `Efektywny TTL rezerwacji: 120 s (2.0 min), źródło: RESERVATION_TTL_MINUTES`. Gdy ustawione są obie zmienne, w logu pojawia się ostrzeżenie.
4. Na działającym wdrożeniu sprawdź: `curl https://<adres>/api/health` → `"reservationTtlSeconds": 120`.

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

W laboratorium kliknij **Test limitu: 60 prób zakupu**. Test wysyła 60 zakupów nieistniejącej rezerwacji, więc nie tworzy danych. Oczekiwany wynik to około 40 × `404` i 20 × `429` — nadmiar zamienia się w szybką odmowę zamiast obciążenia bazy.

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
| `GET` | `/api/events` | `200 EventListItem[]` (z `price` w groszach) | — |
| `GET` | `/api/events/:id` | `200 { event, takenSeats }` (`event.price`) | `404 EVENT_NOT_FOUND` |
| `POST` | `/api/reservations` | `201 { reservationId, expiresAt, amount }` | `400`, `404`, `409 SEAT_UNAVAILABLE`, `429` |
| `GET` | `/api/reservations/:id` | `200 { status, amount, expiresAt, code? }` | `404 RESERVATION_NOT_FOUND` |
| `POST` | `/api/reservations/:id/checkout` | `200 { url }` — wymaga `Idempotency-Key` | `400 IDEMPOTENCY_KEY_REQUIRED`, `404`, `409 RESERVATION_EXPIRED` / `RESERVATION_PAID`, `429`, `503 PAYMENTS_UNAVAILABLE` |
| `POST` | `/api/webhooks/stripe` | `200 { received: true }` | `400 INVALID_SIGNATURE`, `500` (zwrot do ponowienia) |
| `POST` | `/api/reservations/:id/purchase` | `200 { code }` tylko po płatności | `402 PAYMENT_REQUIRED`, `404`, `409 RESERVATION_EXPIRED` |

Wszystkie błędy mają envelope `{ error: string }`; status HTTP niesie znaczenie.

- Drugie zajęcie tego samego miejsca daje `409 SEAT_UNAVAILABLE` — także powtórka identycznego requestu i dwa równoległe requesty. Pierwsza rezerwacja zostaje bez zmian.
- Bilet wydaje wyłącznie webhook Stripe'a. Księgowanie jest idempotentne: ponowna dostawa nie tworzy drugiego kodu ani joba e-mail. Spóźniona albo podwójna płatność jest automatycznie zwracana (reguły w `CONTRACT.md` §10.4).

Dodatkowo, poza kontraktem:

- `GET /api/health` — healthcheck bez limitu i load sheddingu; pokazuje `reservationTtlSeconds`,
- `GET /api/ops/status`, `GET /api/ops/snapshot`, `GET /api/ops/jobs`, `POST /api/ops/jobs/:id/retry`,
- `GET /api/ops/mail/messages`, `POST /api/ops/mail/control`, `POST /api/ops/mail/reset`.

Panel ops można wyłączyć przez `OPS_ENABLED=false`; przy `NODE_ENV=production` jest domyślnie wyłączony.

## Gdzie siedzą praktyki

| Lekcja | Narzędzie | Implementacja | Co widać w `/lab` |
| --- | --- | --- | --- |
| E04 | Timeout | `apps/api/src/mail.ts` — `AbortSignal.timeout(1200)` | tryb **Wolny 3 s** kończy się timeoutem |
| E04 | Retry | `apps/api/src/resilience.ts` + `worker.ts` | liczba prób, backoff, ten sam `Idempotency-Key` |
| E04 | Circuit breaker | `apps/api/src/resilience.ts` | stan `zamknięty / otwarty / półotwarty` |
| E04 | Fallback i degradacja | `apps/api/src/worker.ts`, kolejka | bilet wydany mimo awarii poczty; e-mail czeka w tle |
| E05 | Rate limiting | `apps/api/src/app.ts` — token bucket per IP; rezerwacja 40 na start + 4/s, odmowy walidacji (`400`/`413`/`415`) oddają żeton | `429` + `Retry-After` |
| E05 | Load shedding | `apps/api/src/app.ts` — limit in-flight | szybkie `503 OVERLOADED` |
| E05 | Bulkhead | `apps/api/src/resilience.ts` — osobne pule | odczyt i zapis nie zabierają sobie miejsc |
| E06 | Kolejka | `apps/api/src/jobs.ts` — tabela `jobs` | gotowe / retry / zrobione / DLQ |
| E06 | Ack po pracy | `apps/api/src/worker.ts` | at-least-once + idempotencja dostawcy |
| E06 | DLQ | `apps/api/src/jobs.ts` — limit prób | job „e-mail z biletem” w DLQ i przycisk **Ponów** |
| E04 | Timeout + retry Stripe | `apps/api/src/payments.ts` — timeout SDK 8 s, 2 ponowienia z tym samym `Idempotency-Key` | `503 PAYMENTS_UNAVAILABLE`, rezerwacja trwa |
| E04 | Breaker Stripe | `apps/api/src/app.ts` + `checkout.ts` — osobny bezpiecznik płatności | szybkie `503` zamiast czekania na Stripe'a |
| E06 | Idempotencja płatności | `apps/api/src/checkout.ts` — klucz klienta, jedna otwarta sesja, `stripe_events` | podwójne kliknięcie i ponowny webhook bez skutków ubocznych |

### E-mail niekrytyczny, płatność krytyczna

Poczta może w ogóle nie działać, a bilet i tak jest ważny — e-mail idzie kolejką. Płatność jest zależnością **krytyczną**: bez potwierdzenia od Stripe'a biletu nie ma. Dlatego awaria Stripe'a kończy się szybkim `503` z zachowaniem rezerwacji, a wynik płatności przychodzi asynchronicznie webhookiem, który Stripe sam ponawia.

## TTL i wygasanie

- Domyślnie rezerwacja trzyma miejsce **15 minut** (`RESERVATION_TTL_MINUTES`).
- Do testów i demo można użyć `RESERVATION_TTL_SECONDS`, np. `RESERVATION_TTL_SECONDS=20 pnpm dev`. Ma pierwszeństwo przed `_MINUTES`; gdy ustawisz obie, API ostrzega w logu startowym.
- Efektywny TTL i jego źródło są w logu startowym oraz w `GET /api/health` (`reservationTtlSeconds`).
- Niepoprawna wartość (np. `RESERVATION_TTL_MINUTES=2min`) nie przechodzi po cichu: zmienna jest ignorowana, a log startowy to ostrzega. Przecinek dziesiętny (`2,5`) jest akceptowany. Przy `NODE_ENV=production` bez zmiennej TTL log ostrzega, że działa domyślne 15 minut.
- Interfejs pokazuje TTL z `GET /api/health`, więc w trybie testowym pisze „2 minuty”, a nie „15 minut”.
- `expiresAt` jest liczone na serwerze w UTC; przeglądarka tylko je pokazuje.
- Wygaszanie jest leniwe: każdy odczyt mapy i zakup sprawdza czas. Nie ma crona.
- Po TTL `takenSeats` nie zawiera miejsca, a checkout i zakup zwracają `409 RESERVATION_EXPIRED`.
- Sesja Stripe'a żyje co najmniej 30 minut (wymóg Stripe'a), dłużej niż rezerwacja. Płatność po `expiresAt` jest automatycznie zwracana; płatność przed `expiresAt` z webhookiem po terminie daje bilet, o ile miejsce jest wolne.

## Testy i jakość

```bash
pnpm test        # 126 testów: shared, API, płatności Stripe, worker, resilience, guardy, test chaosu, wdrożenie, UI kart A/B/C, E2E ekranów
pnpm typecheck   # TypeScript strict we wszystkich pakietach
pnpm build       # API + mock-mail + web
```

Testy API używają wstrzykiwanego zegara, więc wygaśnięcie TTL nie trwa 15 minut. `apps/api/test/chaos.test.ts` odtwarza szybki przebieg testera z jednego IP (B3 → B1 → B2 → kolejne rezerwacje bez `429`), zalew B5 i podrabianie `X-Forwarded-For` przy `TRUST_PROXY=1`. Testy workera pokrywają ack, retry, DLQ i przywracanie joba. Testy resilience pokrywają stany bezpiecznika, token bucket i bulkhead.

Testy płatności (`apps/api/test/payments.test.ts`) używają atrapy Stripe'a z tą samą semantyką `Idempotency-Key`, a webhooki podpisują prawdziwym SDK (`generateTestHeaderString`) — sprawdzają brak klucza, powtórki, równoległe kliknięcia, awarię i bezpiecznik, zły podpis, surowe body, ponowne dostawy, spóźnione i podwójne płatności ze zwrotem.

Testy web (`apps/web/test`) działają w jsdom. `reservation.test.tsx` sprawdza formularz B (etykieta, walidacja, `409`), licznik (od `expiresAt`, po odświeżeniu, wygaśnięcie, powrót po zakupie) i przycisk C. `e2e.test.tsx` przechodzi ekrany A → B → C na prawdziwym API (Fastify + SQLite w pamięci przez `inject`) przy TTL = 2 min, ze wspólnym zegarem przeglądarki i API: happy path z płatnością (Checkout → podpisany webhook → strona powrotu → bilet), wygaśnięcie i `409` przy płatności.

## Konfiguracja

Najważniejsze zmienne (pełna lista w `.env.example`):

| Zmienna | Domyślnie | Opis |
| --- | --- | --- |
| `NODE_ENV` | — | `production` zmienia wartości domyślne `HOST` i `OPS_ENABLED` |
| `HOST` | `127.0.0.1`; przy `NODE_ENV=production` `0.0.0.0` | adres nasłuchu API |
| `PORT` | `3001` | port API |
| `RESERVATION_TTL_MINUTES` | `15` | czas trzymania miejsca; tryb testowy: `2` |
| `RESERVATION_TTL_SECONDS` | — | nadpisanie TTL w sekundach do demo/testów; **ma pierwszeństwo** przed `_MINUTES` |
| `DATABASE_PATH` | `data/pas.sqlite` | SQLite; przy `pnpm dev` plik jest w `apps/api/data/` |
| `MAIL_TIMEOUT_MS` | `1200` | timeout zależności pocztowej |
| `MAIL_RETRY_ATTEMPTS` | `2` | próby w jednym podejściu workera |
| `MAIL_BREAKER_FAILURE_THRESHOLD` | `4` | ile błędów otwiera bezpiecznik |
| `MAIL_BREAKER_RESET_MS` | `15000` | po jakim czasie próbny request |
| `WORKER_MAX_ATTEMPTS` | `5` | limit podejść do joba przed DLQ |
| `WORKER_BASE_BACKOFF_MS` | `2000` | start backoffu kolejki |
| `LOAD_SHED_MAX_IN_FLIGHT` | `80` | próg load sheddingu; liczą się requesty z odebranym body |
| `REQUEST_TIMEOUT_MS` | `10000` | czas na nagłówki i limit bezczynności połączenia; klient, który przestał wysyłać body, jest rozłączany |
| `READ_BULKHEAD_CONCURRENCY` | `32` | pula odczytów |
| `WRITE_BULKHEAD_CONCURRENCY` | `8` | pula zapisów |
| `RATE_LIMIT_RESERVATION_CAPACITY` | `40` | limit rezerwacji per IP: pojemność kubełka |
| `RATE_LIMIT_RESERVATION_REFILL_PER_SECOND` | `4` | limit rezerwacji per IP: doładowanie na sekundę |
| `OPS_ENABLED` | `true`; przy `NODE_ENV=production` `false` | panel `/lab` i `/api/ops/*` |
| `OPS_TOKEN` | — | gdy ustawiony, `/api/ops/*` wymaga `Authorization: Bearer <token>` |
| `TRUST_PROXY` | `false` | za reverse proxy ustaw **liczbę proxy** przed API, np. `1`; `true` jest podatne na podrobiony `X-Forwarded-For` |
| `SERVE_WEB` | `true` | serwowanie `apps/web/dist` przez API, gdy katalog istnieje |
| `WEB_DIST_PATH` | `apps/web/dist` | inny katalog zbudowanego frontendu |

Reset danych demo:

```bash
rm -rf apps/api/data
```

## Limit rezerwacji

Limit rezerwacji to token bucket per IP: **40 na start i doładowanie 4 na sekundę**. Do limitu liczą się tylko requesty, które przeszły walidację. Odmowy walidacji (`400`, `413`, `415`: zły body, za duży body, zły `Content-Type`) oddają żeton, bo nie dotknęły bazy, a seria złych requestów i tak jest ograniczona limitem globalnym (300 na start + 10/s). `404` (nieistniejący kurs lub miejsce) i `409 SEAT_UNAVAILABLE` żetonu nie oddają, więc zalew nieistniejących albo zajętych miejsc też dostaje `429`.

- Szybki przebieg testera z jednego IP mieści się w limicie: złe requesty z B3 (`400` za darmo, `404` po żetonie), 4 powtórki rezerwacji, 20 równoczesnych prób jednego miejsca i 10 kolejnych rezerwacji pod testy zakupu i TTL — bez żadnego `429`.
- 100 rezerwacji w 10 s z jednego IP: po ok. 80 odpowiedziach `2xx`/`409` reszta (ok. 20) dostaje `429` z `Retry-After`. Inny klient ma osobny kubełek.
- Po zalewie limit odbudowuje się w ok. 10 s (żeton co 0,25 s). Requesty wysłane z tego samego IP w ułamku sekundy po zalewie dostaną `429` przy każdym ustawieniu, które nadal łapie B5. Porównanie na prawdziwych requestach:

  | Ustawienie | Szybki przebieg bez B5 | 1 s po zalewie | Zalew rozłożony na 13 s |
  | --- | --- | --- | --- |
  | 60 + 2/s | 0 × `429` | 3 z 5 to `429` | 15 × `429` |
  | **40 + 4/s** (domyślne) | 0 × `429` | 1 z 5 to `429` | 9 × `429` |
  | 30 + 5/s | 7 z 10 to `429` | 0 z 5 | 6 × `429` |
- Limit zakupów (40 + 2/s) się nie zmienił, a `404` przy zakupie nadal zużywa żeton. Na tym opiera się demo przeciążenia w `/lab`.

## Bezpieczeństwo panelu ops

`/api/ops/*` pokazuje `reservationId` i treść maili z kodami biletów. Mając `reservationId`, można kupić cudzą rezerwację, dlatego:

- przy `NODE_ENV=production` panel jest domyślnie wyłączony (`404`),
- jeśli chcesz go mieć na wdrożeniu, ustaw `OPS_ENABLED=true` **i** `OPS_TOKEN=<losowy sekret>`; wtedy każdy request do `/api/ops/*` musi mieć `Authorization: Bearer <sekret>`, inaczej dostaje `401 UNAUTHORIZED`,
- `OPS_ENABLED=true` bez `OPS_TOKEN` na produkcji działa, ale API ostrzega w logu startowym,
- strona `/lab` w przeglądarce nie wysyła tokenu, więc przy włączonym `OPS_TOKEN` pokazuje błąd połączenia. To celowe: panel z tokenem służy do `curl`, nie do publicznego UI.

## Co jest poza zakresem

Zgodnie z planem: logowanie, miejsca pośrednie, anulowanie rezerwacji, aktualizacja mapy w czasie rzeczywistym. Dane demo to 3 kursy × 2 wagony × 20 miejsc.

## Ograniczenia i następne kroki

- **Jedna instancja:** SQLite i limity w pamięci są wystarczające na demo. Przy wielu instancjach potrzebny jest wspólny licznik (np. Redis/Upstash) i wspólna kolejka.
- **Worker w API:** w Etapie I worker działa w procesie API. Semantyka claim/ack/lease jest już rozdzielona, więc przeniesienie do osobnego procesu lub kolejki (BullMQ, Temporal, Inngest) nie zmienia kontraktu.
- **Idempotencja:** dostawca dostaje `Idempotency-Key = job.id`. To daje efekt exactly-once przy at-least-once dostarczaniu.
- **Bezpieczeństwo:** panel ops jest otwarty lokalnie, a na produkcji domyślnie wyłączony albo chroniony `OPS_TOKEN`. Rate limiting używa `request.ip`; za reverse proxy ustaw `TRUST_PROXY=1` (liczbę proxy), inaczej wszyscy klienci dzielą jeden limit.
- **Płatności:** sesje Stripe'a nie są aktywnie wygaszane, gdy rezerwacja wygaśnie (brak crona) — spóźniona zapłata jest zwracana z webhooka. Przy jednej instancji blokada „jedna sesja naraz” jest w pamięci procesu; przy wielu instancjach trzeba ją przenieść do bazy.
