# Kontrakt PAS / S01 / Etap I — wariant Pociąg

Wersja 1.0. Kontrakt jest wspólny dla kart A, B i C. Zmiana typu, formatu identyfikatora, TTL albo kodów błędów wymaga zmiany w `packages/shared` i review wszystkich trzech kart.

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
    "arrivalTime": "10:55"
  }
]
```

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

Brak endpointu `GET /api/reservations/:id` jest celowy: ekran B i C korzystają z jednego obiektu przekazanego z zakupu oraz z `sessionStorage`. Serwer pozostaje źródłem prawdy o ważności — przy zakupie ponownie sprawdza czas.

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

Płatności online, logowanie, anulowanie rezerwacji, miejsca pośrednie, aktualizacja mapy w czasie rzeczywistym, wiele rezerwacji na jedno miejsce i wiele miejsc na jedną rezerwację.

## 9. Kryteria akceptacji

- `GET /api/events` zwraca 3 kursy; `GET /api/events/:id` zwraca event + `takenSeats`, a nieznany id daje `404`.
- Oba wagony mają po 20 miejsc; okno/korytarz wynikają z numeru.
- Aktywna rezerwacja B blokuje miejsce w A; wygasła znika po odświeżeniu.
- Drugie zajęcie miejsca daje `409 SEAT_UNAVAILABLE`.
- Zakup aktywnej rezerwacji daje `200 { code }`; powtórka daje ten sam kod.
- Zakup po TTL daje `409 RESERVATION_EXPIRED`; miejsce jest wolne w A.
- E-mail nie blokuje wydania biletu: awaria poczty nie zmienia odpowiedzi zakupu.
