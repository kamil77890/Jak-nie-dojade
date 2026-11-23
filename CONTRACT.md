# Kontrakt PAS / S01 / Etap I + II + III — wariant Pociąg

Wersja 3.0 (Etap III: punkty Voucherify, płatność punktami i mail Resend, sekcja 11). Kontrakt jest wspólny dla kart A, B i C. Zmiana typu, formatu identyfikatora, TTL albo kodów błędów wymaga zmiany w `packages/shared` i review wszystkich trzech kart.

## 1. Decyzje, które zdejmują niepewność

| # | Decyzja | Wartość |
| --- | --- | --- |
| 01 | `takenSeats` | `string[]` — wyłącznie `seatId` miejsc kupionych oraz z ważną rezerwacją; bez duplikatów i bez wygasłych |
| 02 | odmowa zakupu | `409` + `{ "error": "RESERVATION_EXPIRED" }` |
| 03 | format `seatId` | `"wagon-miejsce"`, np. `"5-12"`; `eventId` i `seatId` są tekstem |
| 04 | TTL | jedno źródło: `RESERVATION_TTL_MINUTES` (domyślnie 15), w testach/demo `RESERVATION_TTL_SECONDS` (ma pierwszeństwo); tryb testowy prowadzącego: `RESERVATION_TTL_MINUTES=2` bez `_SECONDS` |
| 05 | powtórzona rezerwacja | identyczny request (ten sam kurs, miejsce, e-mail i imię po normalizacji) przy ważnej, nieopłaconej rezerwacji → `200` z **tą samą** rezerwacją; każde inne zajęcie miejsca z ważną rezerwacją albo kupionego → `409 SEAT_UNAVAILABLE` (od Etapu III, kryterium B1) |

Dane demo: 3 kursy, każdy z wagonami **5** i **6**, po **20 miejsc** (1–20). Siatka wagonu to 5 rzędów × 4 miejsca. Pozycja wynika z numeru: 1 i 4 przy oknie, 2 i 3 przy korytarzu.

## 2. Model danych

```ts
type SeatPosition = "window" | "aisle";

interface Seat {
  id: string;          // "5-12"
  number: number;      // 12
  position: SeatPosition;
}

interface Wagon {
  id: string;          // "5"
  number: number;      // 5
  seats: Seat[];
}

interface Event {
  id: string;          // "ic-7310-2026-11-21"
  relation: string;    // "Warszawa Wschodnia → Kraków Główny"
  date: string;        // "2026-11-21"
  departureTime: string; // "08:10"
  arrivalTime: string;   // "10:55"
  wagons: Wagon[];
}

type EventSummary = Omit<Event, "wagons">;

interface Reservation {
  id: string;
  eventId: string;
  seatId: string;
  customerName: string;
  email: string;
  createdAt: string;   // ISO 8601 UTC
  expiresAt: string;   // ISO 8601 UTC
  status: "active" | "purchased" | "expired";
  code?: string;       // tylko dla purchased
}
```

## 3. Endpointy

Wszystkie odpowiedzi sukcesu są JSON-em. Wszystkie błędy mają wspólny envelope:

```json
{ "error": "SEAT_UNAVAILABLE", "message": "To miejsce jest już zajęte." }
```

- `error` — stały kod do obsługi w programie (lista w §6 i w `packages/shared`),
- `message` — komunikat odmowy po polsku dla człowieka; przy `5xx` zawsze ogólny, bez przyczyny technicznej (ta trafia do logu serwera),
- `retryAfter` — tylko przy `429`/`503`, ta sama wartość co nagłówek `Retry-After`.

Status HTTP niesie znaczenie; sukces nigdy nie zwraca `error`. UI może pokazać `message` wprost albo dobrać własny tekst po kodzie (`apps/web/src/lib/errors.ts` robi to drugie, a `message` bierze dla `VALIDATION_ERROR` i kodów, których jeszcze nie zna).

### `GET /api/events`

`200`

```json
[
  {
    "id": "ic-7310-2026-11-21",
    "relation": "Warszawa Wschodnia → Kraków Główny",
    "date": "2026-11-21",
    "departureTime": "08:10",
    "arrivalTime": "10:55",
    "wagonCount": 2,
    "seatCount": 40,
    "freeSeats": 38
  }
]
```

`wagonCount`, `seatCount` i `freeSeats` to pola dodatkowe dla listy kursów (typ `EventListItem`). `freeSeats` liczy się z tego samego store'u co `takenSeats`: kupione i ważne rezerwacje są zajęte, wygasłe nie.

### `GET /api/events/:id`

`200`

```json
{
  "event": {
    "id": "ic-7310-2026-11-21",
    "relation": "Warszawa Wschodnia → Kraków Główny",
    "date": "2026-11-21",
    "departureTime": "08:10",
    "arrivalTime": "10:55",
    "wagons": [
      {
        "id": "5",
        "number": 5,
        "seats": [
          { "id": "5-1", "number": 1, "position": "window" }
        ]
      }
    ]
  },
  "takenSeats": ["5-3", "5-7"]
}
```

Odmowy:

- `404 EVENT_NOT_FOUND` — nie ma kursu o podanym `id`.

### `POST /api/reservations`

Wejście:

```json
{
  "eventId": "ic-7310-2026-11-21",
  "seatId": "5-12",
  "customerName": "Anna Kowalska",
  "email": "anna@example.com"
}
```

Walidacja: `eventId` i `seatId` niepuste stringi, `customerName` 2–80 znaków po `trim`, poprawny e-mail do 160 znaków.

`201` — nowa rezerwacja; `200` — powtórka identycznego requestu (niżej). Ciało jest w obu przypadkach takie samo:

```json
{
  "reservationId": "8a7f...",
  "expiresAt": "2026-11-21T08:25:00.000Z",
  "amount": 8900
}
```

**Idempotencja (kryterium B1).** Identyczny request to ten sam `eventId` i `seatId` oraz ten sam klient po normalizacji:

- `email`: `trim` + małe litery (`" ANNA@Example.com "` = `"anna@example.com"`),
- `customerName`: `trim`, ciągi białych znaków zwinięte do jednej spacji, Unicode NFC (`" Anna   Kowalska "` = `"Anna Kowalska"`); wielkość liter ma znaczenie.

| Stan miejsca | Odpowiedź |
| --- | --- |
| wolne (także po wygaśnięciu poprzedniej rezerwacji tego klienta) | `201`, nowa rezerwacja |
| ważna, nieopłacona rezerwacja **tego samego** klienta | `200`, ta sama rezerwacja: ten sam `reservationId`, `expiresAt` i `amount`; TTL się nie przedłuża, nic nie jest zapisywane |
| ważna rezerwacja innego klienta, także ten sam e-mail z innym imieniem | `409 SEAT_UNAVAILABLE` |
| kupione (także przez tego samego klienta) | `409 SEAT_UNAVAILABLE` |

Dwa i więcej równoległych identycznych requestów daje jedną rezerwację: pierwszy dostaje `201`, pozostałe `200` z tym samym `reservationId`. Równoległe requesty różnych klientów na to samo miejsce: dokładnie jeden `201`, reszta `409` (kryterium B2). Nagłówek `Idempotency-Key` nie jest potrzebny i jest ignorowany: o tożsamości decyduje treść requestu, więc kryterium działa także dla `curl` bez nagłówków.

Dlaczego zgodność e-maila **i** imienia: prowadzący wysyła identyczny request, a ścisła zgodność utrudnia poznanie cudzego `reservationId` po samym adresie e-mail. Ograniczenie: kto zna kurs, miejsce, e-mail i imię klienta, dostanie jego `reservationId` (tak jak sam klient po ponowieniu), a z nim `GET /api/reservations/:id` (status, a po zakupie kod biletu) i możliwość zapłacenia za tę rezerwację. Bez kompletu tych danych powtórka dostaje `409` i niczego nie ujawnia.

Odmowy:

| Status | `error` | Kiedy |
| --- | --- | --- |
| `400` | `VALIDATION_ERROR` | brak pola, zły e-mail, za krótkie imię |
| `404` | `EVENT_OR_SEAT_NOT_FOUND` | nie ma kursu albo miejsca w tym kursie |
| `409` | `SEAT_UNAVAILABLE` | miejsce jest kupione albo ma ważną rezerwację innego klienta (powtórka identycznego requestu dostaje `200`, patrz wyżej) |
| `429` | `RATE_LIMITED` | przekroczony limit rezerwacji per IP (40 na start + 4/s); nagłówek `Retry-After`. Odmowy walidacji (`400`, `413`, `415`) nie zużywają limitu; `404`, `409` i powtórka `200` zużywają |
| `503` | `BUSY` / `OVERLOADED` | przeciążenie lub pełna pula zapisów |

Zapis jest atomowy: sprawdzenie i insert dzieją się w jednej transakcji `BEGIN IMMEDIATE`, a częściowy unikalny indeks `(event_id, seat_id) WHERE status IN ('active','purchased')` jest ostatnią linią obrony.

### `POST /api/reservations/:id/purchase`

Brak body. `Content-Type: application/json` z pustym body jest traktowany jak brak body.

`200`

```json
{ "code": "PAS-7K2M9Q" }
```

Odmowy:

| Status | `error` | Kiedy |
| --- | --- | --- |
| `404` | `RESERVATION_NOT_FOUND` | nie ma rezerwacji o tym `id` |
| `409` | `RESERVATION_EXPIRED` | rezerwacja wygasła; miejsce wróciło do puli |
| `429` | `RATE_LIMITED` | przekroczony limit zakupów |
| `503` | `BUSY` / `OVERLOADED` | przeciążenie lub pełna pula zapisów |

Zakup jest idempotentny: jeśli rezerwacja ma już status `purchased`, zwracamy ten sam `code` i nie tworzymy drugiego joba e-mail.

## 4. Ważność rezerwacji

```text
B: expiresAt = createdAt + TTL
A: takenSeats = purchased + active, gdzie expiresAt > now
C: now >= expiresAt → 409 RESERVATION_EXPIRED
```

- Czas wygasania jest **leniwy**: każdy odczyt mapy i każdy zakup sprawdza zegar. Nie ma crona ani procesu czyszczącego.
- `expiresAt` liczy serwer; przeglądarka tylko wyświetla countdown.
- `isReservationActive()` i `ttlMsFromEnv()` mieszkają w `packages/shared` i są wspólne dla API, testów i ewentualnych kolejnych klientów.
- Wygasła rezerwacja nie blokuje miejsca. Nowa rezerwacja tego samego miejsca jest dozwolona.

## 5. Przepływ między kartami

| Przejście | Adres | Dane | Zasada |
| --- | --- | --- | --- |
| A → B | `/events/:eventId/reserve/:seatId` | `eventId`, `seatId`; opcjonalnie snapshot eventu | URL działa po odświeżeniu; B może pobrać event ponownie |
| B → licznik | `/reservations/:reservationId` | `ReservationView` w `location.state` + `sessionStorage` | po odświeżeniu dane zostają; ID jest w URL |
| C → bilet | `/reservations/:reservationId/ticket` | `{ code }` + `ReservationView` | zapis w `sessionStorage`; bez dodatkowego GET |

`ReservationView`:

```ts
interface ReservationView {
  reservationId: string;
  expiresAt: string;
  event: EventSummary;
  seatId: string;
  customerName: string;
  email: string;
}
```

Etykietę „Wagon 5, miejsce 12” liczy `formatSeatLabel(seatId)`.

Od Etapu II jest `GET /api/reservations/:id` (sekcja 10): strona powrotu ze Stripe'a nie ma `location.state`, a bilet wydaje webhook, więc klient musi zapytać serwer o status. `ReservationView` ma od Etapu II pole `amount`.

## 6. Kody i komunikaty

- Kod biletu: `PAS-` + 6 znaków z alfabetu bez `I`, `O`, `0`, `1` (czytelność).
- `409` na zakupie zawsze oznacza wygasłą rezerwację, nie „zajęte miejsce”.
- `409` na rezerwacji zawsze oznacza zajęte miejsce.
- `404` na rezerwacji i zakupie są rozdzielone, żeby klient wiedział, czy zgubił rezerwację, czy kurs.
- `429` = „ty wysyłasz za dużo”; `503` = „my mamy za dużo”. UI tłumaczy to innym komunikatem.

## 7. Rozszerzenia operacyjne (poza kontraktem biznesowym)

Te endpointy istnieją dla demo praktyk E04–E06 i panelu `/lab`. Nie są potrzebne do działania kart A/B/C.

| Endpoint | Rola |
| --- | --- |
| `GET /api/health` | healthcheck poza limitem i load sheddingiem; `{ ok, now, reservationTtlSeconds }` |
| `GET /api/ops/status` | bezpiecznik, kolejka, pule, liczniki, tryb mocka poczty; od Etapu III `loyalty`: dostawca, budżet wywołań Voucherify (`used`, progi, `blockedUntil`, `denied`) i statystyki cache salda |
| `GET /api/ops/snapshot` | status + joby + skrzynka w jednym requeście |
| `GET /api/ops/jobs?limit=25` | ostatnie joby |
| `POST /api/ops/jobs/:id/retry` | przywrócenie joba z DLQ |
| `GET /api/ops/mail/messages` | skrzynka mocka |
| `POST /api/ops/mail/control` | `{ "mode": "healthy" \| "slow" \| "down" \| "flaky" }` |
| `POST /api/ops/mail/reset` | czyszczenie skrzynki |

`OPS_ENABLED=false` wyłącza całą tę grupę (poza healthcheckiem) i wtedy odpowiada ona `404 NOT_FOUND`. Przy `NODE_ENV=production` grupa jest domyślnie wyłączona. Gdy ustawiony jest `OPS_TOKEN`, każdy request do `/api/ops/*` wymaga nagłówka `Authorization: Bearer <OPS_TOKEN>`, a bez niego dostaje `401 UNAUTHORIZED`.

Nieznana ścieżka pod `/api/*` zawsze zwraca `404 { "error": "NOT_FOUND", "message": "Nie znaleziono zasobu." }`, także wtedy, gdy API serwuje zbudowany frontend.

## 8. Poza kontraktem Etapu I

Logowanie, anulowanie rezerwacji, miejsca pośrednie, aktualizacja mapy w czasie rzeczywistym, wiele rezerwacji na jedno miejsce i wiele miejsc na jedną rezerwację.

## 9. Kryteria akceptacji

- `GET /api/events` zwraca 3 kursy; `GET /api/events/:id` zwraca event + `takenSeats`, a nieznany id daje `404`.
- Oba wagony mają po 20 miejsc; okno/korytarz wynikają z numeru.
- Aktywna rezerwacja B blokuje miejsce w A; wygasła znika po odświeżeniu.
- Drugie zajęcie miejsca przez innego klienta daje `409 SEAT_UNAVAILABLE`; identyczny request (po kolei i równolegle) daje `200` z tą samą rezerwacją.
- Zakup aktywnej rezerwacji daje `200 { code }`; powtórka daje ten sam kod.
- Zakup po TTL daje `409 RESERVATION_EXPIRED`; miejsce jest wolne w A.
- E-mail nie blokuje wydania biletu: awaria poczty nie zmienia odpowiedzi zakupu.

## 10. Etap II — płatność Stripe Checkout

Klient rezerwuje miejsce jak w Etapie I i widzi cenę, klika „Zapłać 89 zł”, płaci na stronie Stripe'a i wraca po bilet. Bilet wydaje **wyłącznie webhook** — strona powrotu tylko czyta status. Stripe działa wyłącznie w trybie testowym (`sk_test_…`); klucz live wyłącza płatności.

### 10.1 Zmiany w API

| Endpoint | Zmiana |
| --- | --- |
| `GET /api/events`, `GET /api/events/:id` | pole `price` — cena miejsca na cały kurs w groszach (`8900` = 89 zł) |
| `POST /api/reservations` | odpowiedź ma dodatkowo `amount` — cena zamrożona w chwili rezerwacji |
| `POST /api/reservations/:id/checkout` (nowy) | `200 { url }` strony Stripe'a; nagłówek **`Idempotency-Key` obowiązkowy** |
| `POST /api/webhooks/stripe` (nowy) | zdarzenia Stripe'a, podpis `Stripe-Signature` sprawdzany na surowym body |
| `GET /api/reservations/:id` (nowy) | `{ status, amount, expiresAt, code? }`, `status`: `"held"` \| `"paid"` \| `"expired"`; `code` tylko przy `paid` |
| `POST /api/reservations/:id/purchase` | nie wydaje już darmowego biletu: opłacona → `200 { code }` (ten sam kod), nieopłacona → `402 PAYMENT_REQUIRED`, wygasła → `409 RESERVATION_EXPIRED` |

Odmowy `checkout`:

| Status | `error` | Kiedy |
| --- | --- | --- |
| `400` | `IDEMPOTENCY_KEY_REQUIRED` | brak nagłówka albo zły format (8–100 znaków `A–Z a–z 0–9 - _`) |
| `404` | `RESERVATION_NOT_FOUND` | nie ma rezerwacji |
| `409` | `RESERVATION_EXPIRED` | rezerwacja wygasła |
| `409` | `RESERVATION_PAID` | rezerwacja jest już opłacona |
| `429` | `RATE_LIMITED` | limit zakupów (ten sam co `purchase`) |
| `503` | `PAYMENTS_UNAVAILABLE` | Stripe nie odpowiada, bezpiecznik otwarty albo brak kluczy; rezerwacja trwa dalej |

Odmowy webhooka: `400 INVALID_SIGNATURE` (brak lub zły podpis), `503 PAYMENTS_UNAVAILABLE` (brak kluczy), `500` gdy zwrot się nie udał — Stripe ponowi dostawę.

### 10.2 Idempotencja (obowiązkowa)

| Miejsce | Klucz | Efekt |
| --- | --- | --- |
| klient → `checkout` | `Idempotency-Key` = `crypto.randomUUID()`, jeden na rezerwację, trzymany w `sessionStorage` (`pas.checkout-key.<id>`) | podwójne kliknięcie, odświeżenie i „Zapłać ponownie” wysyłają ten sam klucz |
| API → Stripe (sesja) | `pas-checkout-<reservationId>-<Idempotency-Key>`; od Etapu III z sufiksami (§11.2) | SDK ponawia błędy sieci i 5xx z tym samym kluczem — Stripe nie utworzy drugiej sesji. Parametry sesji (w tym `expires_at`) wynikają z rezerwacji, nie z zegara, więc powtórka ma identyczne body |
| API → Stripe (wygaszenie) | `pas-expire-<sessionId>` | Etap III: zmiana liczby punktów wygasza starą sesję; ponowienie nie robi nic nowego |
| API → Stripe (zwrot) | `pas-refund-<sessionId>` | ponowiony webhook nie zwróci pieniędzy dwa razy |
| Stripe → webhook | `event.id` w tabeli `stripe_events` | ponowna dostawa tego samego zdarzenia nic nie zmienia |
| rezerwacja ↔ sesja | `paid_session_id` | drugie zdarzenie tej samej sesji (np. `async_payment_succeeded`) to powtórka, nie druga zapłata |

Dodatkowo: jedna otwarta sesja na rezerwację. Nowy klucz przy wciąż otwartej sesji dostaje jej `url` (o ile liczba punktów się nie zmieniła — §11.2), a równoległe requesty o sesję są szeregowane per rezerwacja — klient nie ma dwóch sesji do opłacenia.

### 10.3 Kontrakt wewnętrzny (decyzje lidera)

**Adresy powrotu** (`PUBLIC_URL` + ścieżka):

| Stripe | Adres | Ekran |
| --- | --- | --- |
| `success_url` | `/reservations/:id/payment/success?session_id={CHECKOUT_SESSION_ID}` | karta C: „Płatność w toku…”, odpytuje `GET /api/reservations/:id` (co 1,5 s, po 30 s co 5 s) i sam zamienia się w bilet |
| `cancel_url` | `/reservations/:id/payment/cancel` | ekran rezerwacji z komunikatem „Płatność przerwana” i przyciskiem „Zapłać ponownie” — dopóki rezerwacja jest ważna |

**Zapis płatności** (SQLite):

- `reservations.amount` — kwota w groszach z chwili rezerwacji; `reservations.paid_session_id` — sesja, która opłaciła rezerwację. Statusy w bazie zostają z Etapu I: `active` → API `held`, `purchased` → `paid`, `expired` → `expired`.
- `checkout_sessions(id, reservation_id, idempotency_key, url, amount, status, created_at, expires_at, payment_intent)`, `status`: `open` | `completed` | `expired` | `refunded`; unikalne `(reservation_id, idempotency_key)`. Etap III dodaje `points_used` i `points_refunded_at` (§11.3); kolejne sesje tej samej rezerwacji mają w `idempotency_key` sufiks `.<n>`.
- `stripe_events(id, type, received_at)` — przetworzone zdarzenia.
- Zaksięgowanie płatności, kod biletu i job e-mail powstają w **jednej transakcji**, jak zakup w Etapie I.

**Sesja Checkout:** `mode=payment`, `currency=pln`, `unit_amount = reservation.amount` (nigdy kwota od klienta), `client_reference_id = reservationId` (też w `metadata`), `customer_email`, `expires_at = expiresAt rezerwacji + 31 min` (Stripe wymaga min. 30 min).

**Webhook:** obsługuje `checkout.session.completed` i `checkout.session.async_payment_succeeded` (tylko `payment_status = paid`) oraz `checkout.session.expired`. Pozostałe typy potwierdza `200` bez zmian.

### 10.4 Reguły księgowania płatności

O tym, czy klient zdążył, decyduje czas zdarzenia u Stripe'a (`event.created`), nie chwila dostarczenia webhooka.

| Sytuacja | Wynik |
| --- | --- |
| zapłata przed `expiresAt`, kwota i waluta się zgadzają | `paid`, kod biletu, job e-mail |
| zapłata przed `expiresAt`, webhook po `expiresAt`, miejsce wolne | `paid` — spóźniony webhook nie odbiera biletu |
| zapłata przed `expiresAt`, ale miejsce w międzyczasie zajął ktoś inny | zwrot, rezerwacja `expired` |
| zapłata po `expiresAt` | zwrot, rezerwacja `expired` |
| kwota ≠ `amount` albo waluta ≠ PLN | zwrot, bez biletu |
| druga opłacona sesja tej samej rezerwacji | zwrot drugiej płatności, bilet bez zmian |
| nieznana rezerwacja | zwrot |

### 10.5 Lista zagrożeń: Stripe (zależność zewnętrzna)

| Zagrożenie | Zabezpieczenie |
| --- | --- |
| Stripe wolny albo niedostępny przy tworzeniu sesji | timeout SDK (`STRIPE_TIMEOUT_MS`, 8 s), ponowienia z tym samym kluczem (`STRIPE_MAX_NETWORK_RETRIES`, 2), osobny bezpiecznik (5 błędów → 30 s przerwy), odpowiedź `503 PAYMENTS_UNAVAILABLE`; rezerwacja trwa, klient ponawia tym samym kluczem |
| podwójne kliknięcie, zerwane połączenie, dwie karty | obowiązkowy `Idempotency-Key`, jedna otwarta sesja na rezerwację, blokada równoległych requestów |
| podrobiony webhook („zapłaciłem”) | podpis `Stripe-Signature` z `STRIPE_WEBHOOK_SECRET` na surowym body; bez podpisu `400`, stan bez zmian |
| ponowne dostawy i zła kolejność zdarzeń | deduplikacja po `event.id` i `paid_session_id`; `expired` nie nadpisuje `completed` |
| webhook nie dochodzi / dochodzi z opóźnieniem | strona powrotu odpytuje status bez limitu; Stripe ponawia dostawę do 3 dni; czas płatności z `event.created` |
| sesja Stripe żyje dłużej niż rezerwacja (min. 30 min vs TTL 2–15 min) | spóźniona płatność → automatyczny zwrot; ekran powrotu informuje o zwrocie |
| zwrot się nie udał | webhook odpowiada `500`, zdarzenie nie jest zapisane, Stripe ponawia; zwrot ma stały klucz |
| manipulacja kwotą po stronie klienta | kwota tylko z bazy (`reservations.amount`); webhook porównuje `amount_total` i walutę |
| wyciek kluczy | `sk_test_…` i `whsec_…` tylko w zmiennych środowiskowych serwera; nie ma ich w repo, w bundlu frontendu ani w logach; klucz `sk_live_…` wyłącza płatności |
| darmowy bilet przez stary `POST /purchase` | `402 PAYMENT_REQUIRED` dla nieopłaconej rezerwacji |

### 10.6 Kryteria akceptacji Etapu II

- Kurs i rezerwacja pokazują cenę; `POST /api/reservations` zwraca `amount = 8900`.
- „Zapłać 89 zł” przenosi na Stripe Checkout; karta `4242 4242 4242 4242` → bilet z kodem po powrocie.
- `4000 0000 0000 0002` (odmowa) zostawia klienta na Stripe'ie z komunikatem; po powrocie przez anulowanie widać „Zapłać ponownie”.
- `4000 0025 0000 3155` wymaga 3D Secure; po potwierdzeniu — bilet.
- Bez `Idempotency-Key` checkout daje `400`; ten sam klucz daje tę samą sesję.
- Zły podpis webhooka daje `400` i nie wydaje biletu; ponowna dostawa nie tworzy drugiego kodu ani e-maila.
- Wszystko z sekcji 9 (Etap I) działa dalej; zakup bez płatności nie wydaje biletu.

## 11. Etap III — punkty lojalnościowe (Voucherify) i mail (Resend)

Sekcja uzupełnia §3 (nowy endpoint i opcjonalne body checkoutu) i §6 (nowe kody błędów). Wszystko z §9–§10 działa bez zmian; zakup bez punktów to ten sam przepływ co w Etapie II.

### 11.1 Reguły biznesowe

| # | Decyzja | Wartość |
| --- | --- | --- |
| 11.01 | konto punktowe | przypisane do e-maila, bez logowania; e-mail normalizowany do małych liter |
| 11.02 | bonus powitalny | e-mail, który jeszcze nic nie kupił, ma **1000 punktów**; kartę w Voucherify i bonus zakładamy leniwie przy pierwszym zapisie punktów (pobranie w checkoucie albo naliczenie po zakupie) — sam odczyt salda niczego nie zakłada; bonus przyznawany dokładnie raz. Karta, która już istnieje w Voucherify (założona w panelu, w kasie albo przy zgubionym mapowaniu), ma pierwszeństwo: liczy się jej saldo, a bonusu nie dublujemy, jeśli karta ma historię punktów |
| 11.03 | naliczanie | **10 punktów za każdy pełny złoty zapłacony kartą**; punkty za zakup dopisuje worker po potwierdzeniu płatności |
| 11.04 | płatność punktami | 1 punkt = 1 grosz; maksymalnie **połowa ceny biletu** (`floor(amount / 2)`) |
| 11.05 | saldo | źródłem prawdy jest **Voucherify**; SQLite trzyma tylko mapowanie e-mail → karta i znaczniki naliczeń; krótki cache salda w pamięci procesu (domyślnie **10 s**) to wyłącznie optymalizacja odczytu — zmiana w panelu Voucherify jest widoczna w sklepie najpóźniej po 10 s; checkout cache nie używa (świeży odczyt przed pobraniem) |
| 11.08 | limit Voucherify | Sandbox przyjmuje **najwyżej 100 wywołań API na godzinę**; API pilnuje własnego budżetu (domyślnie 90/h) z priorytetami: odczyt salda (do 45) < checkout (do 70) < zwrot/naliczenie punktów (do 90); koszt i przepustowość: §11.6.1 |
| 11.09 | zwrot punktów po wygaśnięciu | punkty pobrane na sesję, której rezerwacja wygasła bez płatności, wracają **najpóźniej 15 s po `expiresAt`** (zamiatanie co 2 s); sesja jest wcześniej wygaszana w Stripe, więc nie da się jej już opłacić |
| 11.06 | brak punktów / za dużo | odmowa `4xx` z kodem i komunikatem; żadnych częściowych zapisów |
| 11.07 | mail | bilet + podsumowanie: ile kartą, ile punktami, ile punktów zebrano — przez **Resend** |

### 11.2 Endpointy

#### `GET /api/loyalty?email=…`

`200`:

```json
{ "email": "anna@example.com", "points": 1000 }
```

- E-mail normalizowany: `trim` + małe litery; maks. 160 znaków; format jak przy rezerwacji.
- E-mail bez karty w naszej bazie → **jedno wyszukanie karty** w Voucherify (`GET /v1/loyalties/{campaign}/members?customer=<e-mail>`, priorytet odczytu). Karty nie ma → `200` z `points: 1000`, bez zakładania karty (literówka w trakcie pisania nie tworzy konta); wynik „brak karty” pamiętamy `LOYALTY_NO_CARD_CACHE_SECONDS` (10 s). Karta jest (założona w panelu, w kasie albo baza zgubiła mapowanie) → zapisujemy mapowanie i zwracamy **jej saldo** z tej samej odpowiedzi (karta bez historii punktów: 1000, bo bonus jest jeszcze należny).
- Brak budżetu odczytów, `429` albo awaria Voucherify przy tym wyszukaniu → `200` z `points: 1000` (jak dla nowego klienta), a nie `503`: większość takich adresów to naprawdę nowi klienci, a checkout i tak sprawdza prawdziwą kartę przed pobraniem punktów (najwyżej odmówi `409`), więc nic nie zostanie wydane na podstawie tej odpowiedzi. Wynik awarii nie jest zapamiętywany jako „brak karty”.
- E-mail z kartą → saldo z Voucherify; powtórka w ciągu `LOYALTY_BALANCE_CACHE_SECONDS` (10 s) idzie z cache, a każda nasza korekta salda od razu ten cache nadpisuje. Zmiana zrobiona w panelu Voucherify jest więc widoczna najpóźniej po 10 s.
- Brak, pusty, powtórzony (`?email=a&email=b`), za długi albo niepoprawny e-mail → `400 VALIDATION_ERROR`.
- Za dużo odczytów z jednego IP (domyślnie 10 na start, potem 6/min) → `429 RATE_LIMITED` z `Retry-After`; odpowiedź `400` oddaje żeton.
- Voucherify niedostępny, odpowiedział `429` albo wyczerpał się budżet wywołań → `503 LOYALTY_UNAVAILABLE` z `Retry-After` (realny czas do zwolnienia budżetu albo z nagłówka Voucherify; inaczej 5 s). Jeśli mamy odczyt nie starszy niż `LOYALTY_BALANCE_STALE_SECONDS` (10 min), odpowiedź to `200` z tym saldem.
- Odpowiedź `5xx` niesie tylko kopertę `{ "error", "retryAfter" }` — treść błędu Voucherify trafia wyłącznie do logu serwera.

#### `GET /api/reservations/:id`

Do odpowiedzi z §3 dochodzą dwa pola:

```json
{
  "status": "paid",
  "amount": 8900,
  "expiresAt": "2026-11-01T09:15:00.000Z",
  "pointsUsed": 1000,
  "pointsEarned": 790,
  "code": "PAS-7K4M2Q"
}
```

| Pole | `paid` | `held` / `expired` |
| --- | --- | --- |
| `pointsUsed` | punkty wydane na ten zakup | punkty pobrane z karty na sesje płatności tej rezerwacji i **jeszcze niezwrócone** (np. otwarta sesja z punktami); `0` bez punktów albo po ich zwrocie — po wygaśnięciu rezerwacji najpóźniej 15 s po `expiresAt` (§11.09) |
| `pointsEarned` | punkty za zakup (`floor(kwota_kartą / 100) * 10`) | **pole nie występuje** |
| `code` | kod biletu | pole nie występuje |

Dlaczego `pointsUsed` przed płatnością nie jest zawsze `0`: punkty schodzą z salda w Voucherify już przy tworzeniu sesji. Gdyby status pokazywał `0`, klient widziałby spadek salda bez wyjaśnienia. Wartość zawsze zgadza się z tym, czego brakuje na karcie z powodu tej rezerwacji, i wraca do `0`, gdy punkty wrócą (wygaśnięcie, zwrot płatności, zmiana punktów).

`pointsEarned` jest opcjonalne w typie `ReservationStatusResponse` (`packages/shared`). Frontend czyta je tylko przy `status: "paid"`, więc zmiana jest zgodna wstecz.

#### `POST /api/reservations/:id/checkout`

Body jest opcjonalne:

```json
{ "points": 1000 }
```

- Brak body albo `points: 0` → zachowanie z Etapu II, kwota sesji = `amount`.
- `points > 0` → saldo w Voucherify maleje, a `amount` sesji = `amount - points`.
- `points > floor(amount / 2)` → `409 POINTS_LIMIT_EXCEEDED`.
- `points > saldo` → `409 INSUFFICIENT_POINTS`.
- `points` ujemne, niecałkowite, nie-liczba (string, bool, obiekt, tablica) albo większe niż `Number.MAX_SAFE_INTEGER` → `400 VALIDATION_ERROR`. `points: null` = brak punktów. Body, które nie jest obiektem, albo zły JSON → `400 VALIDATION_ERROR`.
- Kolejność sprawdzeń: pusty id (`400`), `Idempotency-Key` (`400`), format `points` (`400`) → rezerwacja (`404` / `409 RESERVATION_EXPIRED` / `409 RESERVATION_PAID`) → limit połowy ceny (`409`) → powtórka otwartej sesji z tą samą liczbą punktów (`200`, bez kosztów) → limit checkoutów z punktami per IP i per e-mail (`429 RATE_LIMITED`) → saldo (`409` / `503`). Nic nie jest pobierane ani tworzone, zanim wszystkie przejdą.
- **Limit checkoutów z punktami** (budżet Voucherify, §11.6.1): per IP `RATE_LIMIT_POINTS_IP_CAPACITY` (12) na start i `RATE_LIMIT_POINTS_IP_PER_HOUR` (6) na godzinę, per e-mail rezerwacji `RATE_LIMIT_POINTS_EMAIL_CAPACITY` (6) i `RATE_LIMIT_POINTS_EMAIL_PER_HOUR` (6). Żeton zużywa tylko żądanie, które dochodzi do Voucherify — walidacja, `404`, `409` przed saldem i powtórka tej samej sesji nic nie kosztują, a odpowiedź `503` oddaje żeton. Po wyczerpaniu: `429 RATE_LIMITED` z `Retry-After` (koperta `{ error, message, retryAfter }`). Checkout **bez punktów** limitem nie jest objęty.
- Otwarta sesja **z tą samą liczbą punktów** (ten sam albo nowy `Idempotency-Key`) → ta sama sesja, bez wywołania Stripe'a i **bez drugiego pobrania punktów**.
- Otwarta sesja **z inną liczbą punktów** (też: brak body przy sesji z punktami = `0`) → zmiana punktów:
  1. saldo musi wystarczyć z uwzględnieniem punktów, które wrócą ze starej sesji — inaczej `409 INSUFFICIENT_POINTS`, a stara sesja zostaje nietknięta;
  2. stara sesja jest wygaszana w Stripe (`checkout.sessions.expire`, klucz `pas-expire-<sessionId>`); Stripe niedostępny → `503 PAYMENTS_UNAVAILABLE`, stara sesja dalej działa;
  3. jeśli Stripe odpowie, że stara sesja jest już opłacona → `409 RESERVATION_PAID` (bilet wyda webhook; UI przechodzi do ekranu „Płatność w toku…”), nic nie jest zwracane ani tworzone;
  4. punkty starej sesji wracają na kartę (dokładnie raz, §11.3); Voucherify niedostępny → `503 LOYALTY_UNAVAILABLE` — punkty odda webhook `checkout.session.expired` (Stripe wysyła go także dla sesji wygaszonej przez API) albo następny checkout z punktami;
  5. powstaje nowa sesja na nową kwotę i z nowym `url`.
- Klucz Stripe'a dla sesji: `pas-checkout-<reservationId>-<Idempotency-Key>` dla pierwszej sesji rezerwacji, `…-<Idempotency-Key>.<n>` dla `n`-tej kolejnej (Stripe pamięta klucz 24 h i oddałby wygaszoną sesję), plus `-p<points>`, gdy `points > 0` (ponowienie po błędzie Stripe'a z inną liczbą punktów to inne parametry). Ten sam klucz klienta + te same punkty + brak nowej sesji w międzyczasie = ten sam klucz Stripe'a.
- Awaria Voucherify przy sprawdzaniu/pobieraniu punktów (także wyczerpany budżet checkoutu albo `429` Voucherify) → `503 LOYALTY_UNAVAILABLE` z `Retry-After`. Punkty pobrane przed błędem Stripe'a wracają na kartę. Checkout **bez punktów** nie rozmawia z Voucherify, więc działa także przy jego awarii.
- **Saldo i pobranie pod blokadą e-maila.** Checkouty z punktami tego samego e-maila (np. dwie rezerwacje) idą w procesie jeden po drugim. Pod blokadą: (1) **świeży** odczyt salda z Voucherify (nie z cache; wyjątek: wartość otrzymana już pod tą blokadą, np. wynik bonusu albo zwrotu), (2) porównanie z `points` (z punktami, które wrócą z zastępowanej sesji) → `409 INSUFFICIENT_POINTS` bez żadnego zapisu, (3) ewentualne wygaszenie starej sesji, (4) pobranie i sesja Stripe'a. Drugi z dwóch równoległych checkoutów na saldzie 1000 po 1000 pkt widzi więc saldo 0 i dostaje `409` — **także wtedy, gdy Voucherify dopuszcza saldo ujemne**. Gdyby pobranie mimo to zeszło poniżej zera (punkty wydane poza naszym procesem między odczytem a pobraniem: panel, druga instancja), punkty wracają od razu (albo przez job `refund-points`) i odpowiedź to `409 INSUFFICIENT_POINTS`, bez sesji.
- E-mail bez karty w bazie: przy `points ≤ 1000` (bonus) nie pytamy Voucherify przed pobraniem — kartę zakłada (albo odnajduje istniejącą) samo pobranie, a jeśli karta już istniała, przed odjęciem punktów porównujemy jej prawdziwe saldo (odmowa `409` bez zapisu). Przy `points > 1000` najpierw jedno wyszukanie karty (wynik „brak karty” z `GET /api/loyalty` sprzed ≤ 10 s wystarcza): brak karty → `409`, karta z panelu → jej saldo.

**Dlaczego wygaszenie i nowa sesja, a nie `409`.** Wcześniej nowa liczba punktów była po cichu ignorowana: UI pokazywało „Zapłać 85 zł”, a Stripe pobierał 79 zł. Jawna odmowa `409` byłaby bezpieczna, ale zostawiałaby klienta bez wyjścia aż do wygaśnięcia sesji (TTL rezerwacji + 31 min — dłużej niż sama rezerwacja), bo frontend trzyma jeden `Idempotency-Key` na rezerwację. Wygaszenie jest bezpieczne, bo Stripe gwarantuje, że wygaszonej sesji nie da się już opłacić, a opłaconej nie da się wygasić — dostajemy jednoznaczną odpowiedź, którą sesję klient może jeszcze zapłacić. Wszystkie kroki są idempotentne, a żądania checkoutu jednej rezerwacji są szeregowane (blokada w procesie), więc dwa kliknięcia z różnymi punktami nie zostawią dwóch otwartych sesji.

### 11.3 Zapis punktów (SQLite + Voucherify)

- `loyalty_accounts(email PRIMARY KEY, member_id, welcomed_at, created_at, welcome_pending)` — e-mail → kod karty w Voucherify. Wiersz powstaje przy pierwszym zapisie punktów. `welcome_pending`: `0` bonus przyznany (albo karta już miała historię punktów — wtedy bonus był dany wcześniej), `1` bonus należny, `2` próba z niepewnym wynikiem (timeout) — przed ponowieniem sprawdzamy saldo karty, żeby nie zdublować bonusu.
- `reservations.points_used`, `reservations.points_earned`, `reservations.points_awarded_at` — podsumowanie zakupu i znacznik, że punkty już poszły do Voucherify.
- `checkout_sessions.points_used` — ile punktów obniżyło tę sesję; potrzebne do zwrotu i do webhooka.
- `checkout_sessions.points_refunded_at` — kiedy punkty tej sesji wróciły na kartę. To jedyny mechanizm zwrotu punktów (`CheckoutService.releaseSessionPoints`), wspólny dla wygaśnięcia sesji, zwrotu płatności w webhooku i zmiany liczby punktów:
  1. w transakcji `BEGIN IMMEDIATE` znacznik jest stawiany tylko, gdy punkty nie wróciły **i sesja nie opłaciła rezerwacji** (`reservations.paid_session_id ≠ id` — punkty wydane na bilet nie wracają nigdy);
  2. API dopisuje punkty w Voucherify;
  3. gdy Voucherify padnie, znacznik jest zdejmowany, a wołający odpowiada `5xx` (webhook → Stripe ponawia; checkout → `503`).

  Równoległe wywołania dla tej samej sesji w jednym procesie czekają na ten sam wynik. `confirmPayment` w tej samej bazie odmawia wydania biletu z sesji, której punkty już wróciły (zwrot płatności, powód `points_returned`) — zniżka i zwrot punktów nigdy nie występują razem.
- Migracja: kolumna `points_refunded_at` jest dodawana automatycznie; wygasłe sesje z punktami sprzed migracji dostają znacznik (stary kod oddawał punkty przy `open → expired`).
- Saldo **nie jest** kopiowane do bazy. Odczyt `GET /api/loyalty` dla e-maila z kartą pyta Voucherify albo bierze krótki cache w pamięci procesu (nie w SQLite). Cache to tylko optymalizacja: saldo może zmienić się poza nami (np. korekta marketingu w panelu Voucherify), dlatego TTL jest krótki (10 s), a checkout go nie używa.
- `jobs.input.mailSentAt` — znacznik, że mail z biletem już poszedł; job, który wraca tylko po punkty (Voucherify niedostępny), nie wysyła maila drugi raz.

### 11.4 Przepływ

1. Ekran B: po wyjściu z pola e-mail (poprawny format) `GET /api/loyalty` pokazuje saldo (nowy klient: 1000) — raz na e-mail; ekran płatności używa tego samego wyniku z `sessionStorage`. Przy `429`/`503` UI czeka `Retry-After` i nie pokazuje pola punktów; płatność kartą działa.
2. Ekran B: klient podaje liczbę punktów; UI ogranicza ją do `min(saldo, floor(cena/2))`.
3. Checkout: walidacja → limit per IP/e-mail → pod blokadą e-maila świeże saldo → pobranie punktów (jeśli > 0) → sesja Stripe na kwotę po punktach.
4. Webhook `checkout.session.completed`: zapis `pointsUsed` i `pointsEarned = floor(kwota_kartą / 100) * 10` w jednej transakcji z kodem biletu.
5. Worker: wysyła mail przez Resend (i zapisuje `mailSentAt`), potem dopisuje `pointsEarned` do Voucherify i stawia `points_awarded_at`. Job jest at-least-once — znaczniki chronią przed podwójnym naliczeniem i drugim mailem. Voucherify niedostępny (awaria albo limit): job czeka na Voucherify bez zużywania prób — odstęp rośnie od 5 s do 60 s (`WORKER_LOYALTY_RETRY_BASE_MS`, `WORKER_LOYALTY_RETRY_MAX_MS`), przy limicie tyle, ile każe `Retry-After`; po 24 h od utworzenia (`WORKER_LOYALTY_RETRY_HORIZON_HOURS`) zwykłe próby i DLQ. Tak samo job `refund-points`.
6. Rezerwacja wygasła bez płatności, a jej sesja ma niezwrócone punkty: co 2 s (`POINTS_SWEEP_INTERVAL_MS`) zamiatanie (a) wygasza sesję w Stripe (`pas-expire-<sessionId>`) — po tym klient nie może jej opłacić; Stripe odpowiada „opłacona” → nic nie ruszamy, bilet albo zwrot pieniędzy i punktów zrobi webhook (sesję sprawdzamy znowu po minucie), (b) ustawia `expired`, (c) oddaje punkty przez `points_refunded_at` (dokładnie raz). Błąd Stripe'a albo Voucherify → ponowienie w kolejnym przebiegu (backoff 2 s → 60 s, przy limicie `Retry-After`); stan jest w bazie, więc restart niczego nie gubi.
7. `checkout.session.expired` (Stripe wysyła go także dla sesji wygaszonej przez nas, ok. 31 min po `expiresAt` albo od razu po wygaszeniu): sesja `open → expired`, potem zwrot punktów (dokładnie raz — po zamiataniu to już no-op), na końcu zapis zdarzenia. Awaria Voucherify → `503` i ponowienie od Stripe'a.
8. Płatność bez biletu (spóźniona, zajęte miejsce, zła kwota, druga opłacona sesja, nieznana rezerwacja, punkty sesji już zwrócone): sesja → `refunded`, **zwrot pieniędzy** (`pas-refund-<sessionId>`), **zwrot punktów tej sesji** (`points_refunded_at`), na końcu zapis zdarzenia. Każdy krok jest idempotentny, więc ponowienie od Stripe'a po awarii w dowolnym miejscu dokańcza brakujące kroki i niczego nie dubluje. Przy „drugiej opłaconej sesji” wracają punkty sesji zwracanej, a nie tej, która opłaciła bilet.
9. Zmiana liczby punktów przy otwartej sesji: §11.2 (wygaszenie starej sesji, zwrot jej punktów, nowa sesja).

### 11.5 Nowe kody błędów

| HTTP | `error` | Kiedy |
| --- | --- | --- |
| `409` | `POINTS_LIMIT_EXCEEDED` | punkty > połowa ceny biletu |
| `409` | `INSUFFICIENT_POINTS` | saldo mniejsze niż liczba punktów |
| `503` | `LOYALTY_UNAVAILABLE` | Voucherify wolny/niedostępny/odrzucił żądanie, odpowiedział `429` albo wyczerpał się nasz budżet wywołań; zawsze z `Retry-After` |
| `429` | `RATE_LIMITED` | (kod z §6) checkout z punktami ponad limit per IP albo per e-mail; z `Retry-After` |

Pozostałe odpowiedzi checkoutu z punktami używają kodów z §10.1 (`400 VALIDATION_ERROR`, `400 IDEMPOTENCY_KEY_REQUIRED`, `404 RESERVATION_NOT_FOUND`, `409 RESERVATION_EXPIRED`, `409 RESERVATION_PAID`, `503 PAYMENTS_UNAVAILABLE`). Koperta błędu jak w §3: `{ "error": "KOD", "message": "…", "retryAfter"? }`. Odpowiedzi `5xx` nie zawierają przyczyny (ta trafia do logu serwera); nieobsłużony błąd to zawsze `500 { "error": "INTERNAL_ERROR", "message": "Wystąpił błąd serwera. Spróbuj ponownie za chwilę." }`.

Webhook: `400 INVALID_SIGNATURE`; `500`, gdy nie udał się zwrot pieniędzy; `503 LOYALTY_UNAVAILABLE`, gdy nie udał się zwrot punktów. W obu ostatnich przypadkach Stripe ponawia dostawę. Limit i saldo zostają przy `409` (jak `SEAT_UNAVAILABLE`): żądanie jest poprawne składniowo, ale koliduje ze stanem; `422` w repo nie występuje.

### 11.6 Lista zagrożeń: Voucherify i Resend

| Zagrożenie | Zabezpieczenie |
| --- | --- |
| Voucherify wolny albo niedostępny | timeout (`VOUCHERIFY_TIMEOUT_MS`, 5 s), retry z backoffem (`VOUCHERIFY_MAX_RETRIES`) tylko dla odczytów i zakładania karty — korekta salda nie jest ponawiana automatycznie (mogłaby pobrać punkty dwa razy), osobny bezpiecznik (5 błędów → 30 s; otwarty nie zużywa limitu), `503 LOYALTY_UNAVAILABLE`; płatność kartą bez punktów działa dalej |
| **limit Voucherify Sandbox: 100 wywołań API/h** | własny budżet w oknie przesuwnym (`VOUCHERIFY_HOURLY_BUDGET`, 90 — zapas na ręczne wywołania), liczony per wywołanie (także ponowienia); priorytety: odczyt salda kończy się pierwszy (`budżet − rezerwy`, domyślnie **45**), checkout ma rezerwę (`VOUCHERIFY_RESERVE_CHECKOUT`, **25** — do 70), zwrot i naliczenie punktów — ostatnią (`VOUCHERIFY_RESERVE_CRITICAL`, **20** — do 90). Po przekroczeniu: `503 LOYALTY_UNAVAILABLE` z `Retry-After` do zwolnienia miejsca (albo niedawne saldo z cache); naliczenie i zwroty w workerze czekają na okno bez zużywania prób (nie trafiają do DLQ). Stan budżetu: `GET /api/ops/status` → `loyalty.budget`. Budżet jest w pamięci procesu — przy kilku instancjach trzeba go podzielić albo przenieść do Redisa. Koszty i przepustowość: §11.6.1 |
| zalew checkoutów z punktami z jednego IP (każdy nowy e-mail = karta + bonus + pobranie = 3 wywołania) zjada budżet checkoutu innym klientom | limit per IP (12 na start, 6/h) i per e-mail (6, 6/h) liczony tylko dla żądań, które dochodzą do Voucherify → `429 RATE_LIMITED` z `Retry-After`; jedno IP zużyje najwyżej ok. 36 wywołań naraz i ok. 18/h dalej, więc z 70 wywołań checkoutu co najmniej ok. 34 zostaje innym, gdy odczyty śpią (przy pełnym zużyciu odczytów 25 to rezerwa tylko dla checkoutu). Mniejszy limit zablokowałby test wyścigu prowadzącego (5 e-maili × 2 checkouty z jednego IP); limity są w env |
| `429` od Voucherify | bez natychmiastowego ponowienia; `Retry-After` (sekundy albo data HTTP, bez nagłówka 60 s, maks. 1 h) blokuje wszystkie wywołania do Voucherify i trafia do klienta jako `Retry-After` przy `503`; `429` nie liczy się jako awaria bezpiecznika |
| zużycie limitu przez odczyty salda (skrypt, literówki) | odczyt salda e-maila bez karty kosztuje jedno wyszukanie karty (priorytet odczytu, pamiętane 10 s) i nigdy nie zakłada karty; przy wyczerpanym budżecie odczytów odpowiada 1000 bez wywołania; cache salda 10 s; limit per IP na `GET /api/loyalty` (`RATE_LIMIT_LOYALTY_CAPACITY` 10, `RATE_LIMIT_LOYALTY_PER_MINUTE` 6) → `429 RATE_LIMITED`; UI pyta raz po wyjściu z pola e-mail i pamięta wynik. Zalew odczytów (z dowolnej liczby IP) zatrzyma się na progu odczytów (45 wywołań w godzinie, łącznie z innym ruchem) — checkout i zwroty mają swoje rezerwy |
| karta założona poza sklepem (panel marketingu, kasa) albo zgubione mapowanie — sklep pokazuje 1000 i odmawia punktów, które klient ma | odczyt salda i checkout ponad bonus szukają karty w Voucherify po e-mailu; znaleziona karta dostaje mapowanie i liczy się jej saldo (bez drugiego bonusu, jeśli ma historię); pobranie ≤ bonusu dla e-maila bez mapowania przed odjęciem porównuje saldo odnalezionej karty |
| fałszywe karty w Voucherify (literówki, cudze e-maile) | karta powstaje dopiero przy pierwszym zapisie punktów (zakup), nie przy odczycie salda |
| punkty pobrane, ale Stripe odmówił | natychmiastowy zwrot punktów (`awardPoints`) przed odpowiedzią `503`; gdy Voucherify też nie przyjmie zwrotu, trafia on do kolejki jobów (`refund-points`: czekanie na Voucherify z backoffem do 60 s bez zużywania prób przez 24 h, potem DLQ w `/lab`) — jeden job na każde pobranie, więc ponowienia z tym samym kluczem niczego nie gubią |
| Voucherify leży (unieważniony klucz → 401, 5xx, timeout) przy naliczeniu punktów po zakupie | bilet i mail niezależne od punktów: mail idzie od razu i raz (`mailSentAt`, a w razie awarii procesu — `Idempotency-Key = job.id` w Resend); job czeka na Voucherify z odstępem 5 s → 60 s bez zużywania prób (otwarty bezpiecznik nie kosztuje wywołań), więc po przywróceniu punkty dochodzą najpóźniej po ok. 60 s + 30 s bezpiecznika; DLQ dopiero po 24 h (np. usunięta kampania) |
| podwójne kliknięcie / ponowienie checkoutu | `Idempotency-Key` + jedna otwarta sesja; punkty pobierane tylko przy tworzeniu sesji |
| porzucona sesja Stripe (rezerwacja wygasła, punkty zeszły) | zamiatanie co 2 s: najpierw wygaszenie sesji w Stripe (po tym nie da się jej opłacić), potem zwrot punktów — najpóźniej 15 s po `expiresAt`, a nie dopiero po `checkout.session.expired` (Stripe: min. 30 min). Stripe mówi „opłacona” → punkty zostają, decyduje webhook (bilet albo zwrot pieniędzy i punktów). Stripe albo Voucherify niedostępne → ponowienie w kolejnym przebiegu (backoff do 60 s, przy limicie `Retry-After`). Późniejszy `checkout.session.expired` (także powtórzony) i równoległy `completed` nie dublują zwrotu (`points_refunded_at`) |
| płatność zwrócona (spóźniona, zajęte miejsce, zła kwota, druga sesja, nieznana rezerwacja), a punkty przepadają | webhook po zwrocie pieniędzy oddaje punkty **tej** sesji przez `points_refunded_at`; zdarzenie zapisywane dopiero po obu zwrotach |
| awaria Voucherify w środku zwrotu punktów | znacznik zdejmowany, odpowiedź `5xx`, ponowienie od Stripe'a (albo następny checkout z punktami) kończy zwrot; zwrot pieniędzy ma stały klucz, więc się nie dubluje |
| podwójny zwrot punktów (powtórka webhooka, `expired` po zmianie punktów, równoległe żądania) | znacznik stawiany w transakcji przed wywołaniem Voucherify + wspólna obietnica dla równoległych wywołań w procesie |
| zniżka punktowa i zwrot punktów naraz (`completed` po `expired` albo po zmianie punktów) | `confirmPayment` odmawia biletu z sesji, której punkty wróciły → zwrot płatności; punkty sesji, która opłaciła bilet, nigdy nie wracają |
| klient zmienia liczbę punktów przy otwartej sesji („Zapłać X” ≠ kwota w Stripe) | wygaszenie starej sesji w Stripe, zwrot jej punktów, nowa sesja; opłacona w międzyczasie → `409 RESERVATION_PAID`; żądania jednej rezerwacji szeregowane |
| niejednoznaczny wynik w Voucherify (timeout, choć punkty zostały dopisane) | **ryzyko szczątkowe**: API zdejmuje znacznik i ponawia, więc w tym rzadkim przypadku klient może dostać punkty dwa razy (legacy API Voucherify nie ma klucza idempotencji). Wybraliśmy nadmiarowy zwrot zamiast utraty punktów klienta; do wykrycia w historii karty |
| awaria procesu między postawieniem znacznika a odpowiedzią Voucherify | **ryzyko szczątkowe**: znacznik zostaje, punkty mogą nie wrócić; do ręcznej korekty (wiersze z `points_refunded_at` bez wpisu w historii karty) |
| wiele instancji API | blokada checkoutu per rezerwacja, blokada pobrań per e-mail, budżet, limity i wspólna obietnica zwrotu działają w obrębie procesu; poprawność zwrotu zapewnia znacznik w bazie (jedna baza SQLite = jedna instancja, jak w §10). Przy kilku instancjach dwa checkouty jednego e-maila mogłyby przejść świeży odczyt równocześnie — wtedy ratuje kontrola po pobraniu (saldo < 0 → natychmiastowy zwrot i `409`), ale saldo jest ujemne przez czas jednego wywołania. Pełne rozwiązanie: blokada we wspólnym magazynie (Redis/DB) albo jedna instancja |
| podwójne naliczenie punktów za zakup | `points_earned` liczone raz przy płatności, `points_awarded_at` + job at-least-once |
| klient podmienia liczbę punktów / kwotę | kwota sesji liczona z bazy; saldo sprawdzane i pobierane w Voucherify, nie w przeglądarce |
| wyścig dwóch zakupów na jednym saldzie | blokada pobrań per e-mail + świeży odczyt salda tuż przed pobraniem (nie polegamy na tym, że Voucherify odrzuca saldo ujemne); drugi checkout → `409 INSUFFICIENT_POINTS`; pobranie, które mimo to zejdzie poniżej zera (zmiana poza nami), jest od razu oddawane (`409`, brak sesji) |
| fałszywe konto na cudzy e-mail | konto bez logowania (jak w Etapie I); punkty są przyjazne, nie pieniężne — brak wypłaty, tylko zniżka do połowy ceny |
| wyciek kluczy Voucherify | `VOUCHERIFY_APP_ID` i `VOUCHERIFY_APP_TOKEN` tylko w env serwera; brak w bundlu i logach |
| Resend niedostępny / limit | timeout (`RESEND_TIMEOUT_MS`), retry z backoffem i bezpiecznikiem; bilet jest ważny niezależnie od maila, status widać na stronie |
| Resend Sandbox (bez zweryfikowanej domeny) wysyła tylko na adres właściciela konta i adresy testowe `delivered@resend.dev` / `bounced@resend.dev` | odmowa (`403`) to błąd trwały: job od razu w DLQ, bez ponowień; punkty za zakup są naliczane **przed** zgłoszeniem błędu maila, więc odmowa nie blokuje naliczenia (test). `bounced@resend.dev` Resend przyjmuje (`200`), a odbicie zgłasza później asynchronicznie (webhook, którego nie konsumujemy) — dla nas to wysłany mail; bilet i punkty są niezależne od doręczenia |
| duplikat maila przy powtórce joba | `Idempotency-Key` = `job.id` w Resend |
| podszycie się pod nadawcę / spam | domena nadawcy zweryfikowana w Resend (SPF/DKIM), `RESEND_FROM` tylko z env |
| wyciek klucza Resend | klucz wyłącznie na serwerze; rotacja po ujawnieniu; brak w repo i frontendzie |

#### 11.6.1 Budżet Voucherify: koszt wywołań i przepustowość

Podział budżetu 90/h (okno przesuwne; Sandbox: 100/h): **odczyt salda do 45**, **checkout do 70** (co najmniej 25 tylko dla niego), **zwroty i naliczenia do 90** (co najmniej 20 tylko dla nich). Progi liczą **wszystkie** wywołania w oknie: gdy w ostatniej godzinie poszło już 45 wywołań (jakichkolwiek), odczyty są wstrzymane. Wtedy `GET` dla karty z panelu albo po korekcie w panelu pokaże ostatnie znane saldo (albo 1000 dla e-maila bez mapowania) — obietnica „≤ 15 s” z III.A2 obowiązuje, dopóki godzinne zużycie nie przekroczy 45. Wcześniejszy podział 30/65 wyczerpywał odczyty w kilka minut testu czarnej skrzynki (`s2-timing`), stąd 45/70. Odczyty kończą się pierwsze, a przy ich braku `GET /api/loyalty` nadal odpowiada (cache do 10 min albo 1000 dla e-maila bez karty).

| Operacja | odczyt | checkout | krytyczne |
| --- | --- | --- | --- |
| `GET /api/loyalty`, e-mail z kartą | 1 na 10 s na e-mail (cache) | | |
| `GET /api/loyalty`, e-mail bez karty w bazie | 1 (wyszukanie), wynik pamiętany 10 s | | |
| checkout z punktami, nowy klient (≤ 1000 pkt) | | 3: karta + bonus + pobranie (bonus zwraca saldo, więc bez odczytu) | |
| checkout z punktami, karta jest | | 2: świeży odczyt + pobranie | |
| checkout z punktami ponad bonus, e-mail bez karty | | 0–1 (wyszukanie; 0, gdy `GET` sprzed ≤ 10 s) → `409` | |
| odmowa `409` za mało punktów (karta jest) | | 1 | |
| zmiana liczby punktów przy otwartej sesji | | jak checkout | +1 (zwrot starej sesji) |
| naliczenie po zakupie | | | 1 (+2: karta + bonus, gdy pierwszy zakup był kartą) |
| zwrot punktów porzuconej sesji / po odmowie Stripe'a | | | 1 |
| powtórka checkoutu (ta sama sesja), checkout bez punktów, walidacja | 0 | 0 | 0 |

Pełny zakup:

| Scenariusz | wywołania | zmiana względem poprzedniej wersji |
| --- | --- | --- |
| nowy klient przez UI: saldo → checkout 1000 pkt → zapłata → naliczenie | 1 + 3 + 1 = **5** | +1 odczyt: wyszukanie karty z panelu/kasy (III.A2) |
| stały klient przez UI z punktami | 0–1 + 2 + 1 = **3–4** | świeży odczyt zamiast wstępnego sprawdzenia z cache (III.B3); bez `GET` tuż przed — bez zmian |
| nowy klient płacący kartą | 1 + 0 + 3 = **4** | +1 odczyt |
| stały klient płacący kartą | 0–1 + 0 + 1 = **1–2** | bez zmian |
| porzucona rezerwacja z punktami (nowy klient) | 1 + 3 + 1 = **5** | zwrot w 15 s zamiast po 31 min, ten sam koszt |

Przepustowość w godzinie (sam ten rodzaj ruchu): **ok. 18 zakupów z punktami nowych klientów** (90 / 5; checkout 54 ≤ 70, odczyty 18 ≤ 45) albo **ok. 22 zakupy stałych klientów z punktami** (90 / 4), albo ok. 22 pierwsze zakupy kartą. Szacunek testu prowadzącego (ok. 100+ operacji w godzinie): większość operacji (rezerwacje, statusy, checkouty bez punktów, webhooki, powtórki tej samej sesji, walidacja) nie kosztuje nic. Liczą się zakupy z punktami na nowe e-maile (ok. 4 wywołania checkoutu i naliczenia + 1 odczyt) i odczyty salda. Przy **ok. 15 zakupach z punktami** (60 wywołań) i do 30 odczytów budżet 90 **wystarcza**; przy 20 zakupach (80) odczyty kończą się pierwsze (saldo z cache albo 1000 dla nowego e-maila, bez `503`), a zakupy z punktami działają do ok. 70 wywołań — dalsze dostają uczciwe `503 LOYALTY_UNAVAILABLE` z `Retry-After`, a kartą płaci się normalnie. Każde dodatkowe przejście scenariusza z nowymi e-mailami to ok. 4–5 wywołań. Zalecenie bez zmian: przed testem nie zużywać budżetu (godzina przerwy po próbach) i obserwować `GET /api/ops/status → loyalty.budget`.

Rozważone i odrzucone: bonus i pierwsze pobranie w jednej korekcie (`+1000 − punkty`) oszczędziłoby 1 wywołanie na nowego klienta, ale w historii karty nie byłoby osobnych wpisów „+1000” i „−1000”, po których prowadzący sprawdza pobranie (III.B2/B3), a przy `points = 1000` korekta wynosiłaby 0. Dłuższy cache „brak karty” (np. 60 s) oszczędza tylko powtórne odczyty tego samego adresu (UI pyta raz na adres), a łamie obietnicę „karta z panelu widoczna w 15 s”, gdy ktoś pytał o ten adres wcześniej.

### 11.7 Kryteria akceptacji Etapu III

- Nowy e-mail → `GET /api/loyalty` zwraca 1000 punktów po jednym wyszukaniu karty (bez zakładania karty); pierwszy zakup zakłada kartę z bonusem dokładnie raz.
- Karta założona w panelu Voucherify z 3000 pkt dla e-maila, który nic nie kupił → `GET` zwraca 3000, checkout z `points: 2000` → `200`. Korekta w panelu widoczna w `GET` najpóźniej po 10 s.
- Dwa równoległe checkouty po 1000 pkt na saldzie 1000 → dokładnie jeden `200` i jeden `409 INSUFFICIENT_POINTS`, saldo nigdy < 0 — także z dostawcą, który przyjmuje saldo ujemne.
- Checkout z punktami, nie płacę, rezerwacja wygasa → saldo wraca najpóźniej 15 s po `expiresAt`, `GET /api/reservations/:id` → `expired`, `pointsUsed: 0`; sesji nie da się opłacić; późniejszy `checkout.session.expired` nie dubluje zwrotu.
- Voucherify leży przy naliczeniu → bilet i jeden mail od razu, job nie trafia do DLQ; po przywróceniu punkty są na karcie w ≤ 2 min.
- Jedno IP z serią checkoutów z punktami dostaje `429 RATE_LIMITED` z `Retry-After`, a klient z innego IP dalej płaci punktami.
- Zalew odczytów salda nie wyczerpuje limitu Voucherify potrzebnego na zakupy i zwroty punktów (`429` per IP, budżet z priorytetami, `503` z `Retry-After`).
- Checkout z `points: 1000` dla biletu 89 zł tworzy sesję na 79 zł, a saldo spada o 1000.
- Po opłaceniu status ma `pointsUsed: 1000` i `pointsEarned: 790`; worker dopisuje 790 punktów.
- `points: 4451` przy cenie 89 zł → `409 POINTS_LIMIT_EXCEEDED`; `points: 2000` przy saldzie 1000 → `409 INSUFFICIENT_POINTS`.
- Wygasła sesja oddaje punkty; powtórka webhooka nie dubluje zwrotu.
- Zwrot płatności (spóźniona, zajęte miejsce, zła kwota, druga sesja) oddaje punkty tej sesji dokładnie raz — także po awarii Voucherify i ponowieniu webhooka.
- Zmiana liczby punktów przy otwartej sesji daje nową sesję na nową kwotę, a punkty starej wracają raz; ten sam klucz z tymi samymi punktami zwraca tę samą sesję.
- `GET /api/reservations/:id` przed opłaceniem nie ma `pointsEarned`; `pointsUsed` pokazuje punkty pobrane i niezwrócone.
- Mail (Resend lub mock w dev) zawiera bilet i podsumowanie: kartą, punktami, zebrane punkty.
- Wszystkie testy Etapów I–II przechodzą (`pnpm test`), a typecheck jest czysty.
