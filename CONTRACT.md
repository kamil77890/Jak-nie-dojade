# Kontrakt PAS / S01 / Etap I + II — wariant Pociąg

Wersja 2.0 (Etap II: płatność Stripe Checkout, sekcja 10). Kontrakt jest wspólny dla kart A, B i C. Zmiana typu, formatu identyfikatora, TTL albo kodów błędów wymaga zmiany w `packages/shared` i review wszystkich trzech kart.

## 1. Decyzje, które zdejmują niepewność

| # | Decyzja | Wartość |
| --- | --- | --- |
| 01 | `takenSeats` | `string[]` — wyłącznie `seatId` miejsc kupionych oraz z ważną rezerwacją; bez duplikatów i bez wygasłych |
| 02 | odmowa zakupu | `409` + `{ "error": "RESERVATION_EXPIRED" }` |
| 03 | format `seatId` | `"wagon-miejsce"`, np. `"5-12"`; `eventId` i `seatId` są tekstem |
| 04 | TTL | jedno źródło: `RESERVATION_TTL_MINUTES` (domyślnie 15), w testach/demo `RESERVATION_TTL_SECONDS` (ma pierwszeństwo); tryb testowy prowadzącego: `RESERVATION_TTL_MINUTES=2` bez `_SECONDS` |
| 05 | powtórzona rezerwacja | każde drugie zajęcie miejsca z ważną rezerwacją, także identyczny request → `409 SEAT_UNAVAILABLE` |

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
{ "error": "SEAT_UNAVAILABLE" }
```

Status HTTP niesie znaczenie; sukces nigdy nie zwraca `error`.

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

`201`

```json
{
  "reservationId": "8a7f...",
  "expiresAt": "2026-11-21T08:25:00.000Z"
}
```

Rezerwacja nie jest idempotentna: drugie zajęcie tego samego miejsca daje `409 SEAT_UNAVAILABLE`, także gdy to powtórka identycznego requestu (ten sam `eventId`, `seatId`, `customerName` i `email`) albo dwa równoległe requesty. Pierwsza rezerwacja zostaje bez zmian, a TTL się nie przedłuża.

Odmowy:

| Status | `error` | Kiedy |
| --- | --- | --- |
| `400` | `VALIDATION_ERROR` | brak pola, zły e-mail, za krótkie imię |
| `404` | `EVENT_OR_SEAT_NOT_FOUND` | nie ma kursu albo miejsca w tym kursie |
| `409` | `SEAT_UNAVAILABLE` | miejsce jest kupione albo ma ważną rezerwację |
| `429` | `RATE_LIMITED` | przekroczony limit rezerwacji per IP (40 na start + 4/s); nagłówek `Retry-After`. Odmowy walidacji (`400`, `413`, `415`) nie zużywają limitu; `404` i `409` zużywają |
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
| `GET /api/ops/status` | bezpiecznik, kolejka, pule, liczniki, tryb mocka poczty |
| `GET /api/ops/snapshot` | status + joby + skrzynka w jednym requeście |
| `GET /api/ops/jobs?limit=25` | ostatnie joby |
| `POST /api/ops/jobs/:id/retry` | przywrócenie joba z DLQ |
| `GET /api/ops/mail/messages` | skrzynka mocka |
| `POST /api/ops/mail/control` | `{ "mode": "healthy" \| "slow" \| "down" \| "flaky" }` |
| `POST /api/ops/mail/reset` | czyszczenie skrzynki |

`OPS_ENABLED=false` wyłącza całą tę grupę (poza healthcheckiem) i wtedy odpowiada ona `404 NOT_FOUND`. Przy `NODE_ENV=production` grupa jest domyślnie wyłączona. Gdy ustawiony jest `OPS_TOKEN`, każdy request do `/api/ops/*` wymaga nagłówka `Authorization: Bearer <OPS_TOKEN>`, a bez niego dostaje `401 UNAUTHORIZED`.

Nieznana ścieżka pod `/api/*` zawsze zwraca `404 { "error": "NOT_FOUND" }`, także wtedy, gdy API serwuje zbudowany frontend.

## 8. Poza kontraktem Etapu I

Logowanie, anulowanie rezerwacji, miejsca pośrednie, aktualizacja mapy w czasie rzeczywistym, wiele rezerwacji na jedno miejsce i wiele miejsc na jedną rezerwację.

## 9. Kryteria akceptacji

- `GET /api/events` zwraca 3 kursy; `GET /api/events/:id` zwraca event + `takenSeats`, a nieznany id daje `404`.
- Oba wagony mają po 20 miejsc; okno/korytarz wynikają z numeru.
- Aktywna rezerwacja B blokuje miejsce w A; wygasła znika po odświeżeniu.
- Drugie zajęcie miejsca daje `409 SEAT_UNAVAILABLE`.
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
| API → Stripe (sesja) | `pas-checkout-<reservationId>-<Idempotency-Key>` | SDK ponawia błędy sieci i 5xx z tym samym kluczem — Stripe nie utworzy drugiej sesji. Parametry sesji (w tym `expires_at`) wynikają z rezerwacji, nie z zegara, więc powtórka ma identyczne body |
| API → Stripe (zwrot) | `pas-refund-<sessionId>` | ponowiony webhook nie zwróci pieniędzy dwa razy |
| Stripe → webhook | `event.id` w tabeli `stripe_events` | ponowna dostawa tego samego zdarzenia nic nie zmienia |
| rezerwacja ↔ sesja | `paid_session_id` | drugie zdarzenie tej samej sesji (np. `async_payment_succeeded`) to powtórka, nie druga zapłata |

Dodatkowo: jedna otwarta sesja na rezerwację. Nowy klucz przy wciąż otwartej sesji dostaje jej `url`, a równoległe requesty o sesję czekają na pierwszy — klient nie ma dwóch sesji do opłacenia.

### 10.3 Kontrakt wewnętrzny (decyzje lidera)

**Adresy powrotu** (`PUBLIC_URL` + ścieżka):

| Stripe | Adres | Ekran |
| --- | --- | --- |
| `success_url` | `/reservations/:id/payment/success?session_id={CHECKOUT_SESSION_ID}` | karta C: „Płatność w toku…”, odpytuje `GET /api/reservations/:id` (co 1,5 s, po 30 s co 5 s) i sam zamienia się w bilet |
| `cancel_url` | `/reservations/:id/payment/cancel` | ekran rezerwacji z komunikatem „Płatność przerwana” i przyciskiem „Zapłać ponownie” — dopóki rezerwacja jest ważna |

**Zapis płatności** (SQLite):

- `reservations.amount` — kwota w groszach z chwili rezerwacji; `reservations.paid_session_id` — sesja, która opłaciła rezerwację. Statusy w bazie zostają z Etapu I: `active` → API `held`, `purchased` → `paid`, `expired` → `expired`.
- `checkout_sessions(id, reservation_id, idempotency_key, url, amount, status, created_at, expires_at, payment_intent)`, `status`: `open` | `completed` | `expired` | `refunded`; unikalne `(reservation_id, idempotency_key)`.
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
