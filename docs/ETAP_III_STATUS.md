# Etap III — status wdrożenia

Zakres: konta punktowe w Voucherify, płatność punktami w Stripe Checkout, naliczanie punktów po zakupie i mail z podsumowaniem przez Resend. Etapy I i II działają bez zmian.

## Co działa

| Obszar | Realizacja |
| --- | --- |
| Saldo punktów | `GET /api/loyalty?email=…` → `{ email, points }`; nowy e-mail dostaje 1000 punktów |
| Źródło prawdy | Voucherify (karta lojalnościowa per e-mail); SQLite tylko mapuje e-mail → `member_id` |
| Płatność punktami | `POST /api/reservations/:id/checkout` z `{ points }`; 1 pkt = 1 gr, maks. połowa ceny |
| Naliczanie | 10 pkt za każdy pełny złoty zapłacony kartą; `pointsEarned` liczone przy webhooku |
| Status | `GET /api/reservations/:id` zwraca `pointsUsed` i `pointsEarned` |
| Mail | Resend (albo mock w dev) z biletem i podsumowaniem: kartą / punktami / zebrane |
| Zwroty punktów | nieudany Stripe i `checkout.session.expired` oddają punkty dokładnie raz |
| UI | saldo po wpisaniu e-maila, pole „Użyj punktów” w podsumowaniu, podsumowanie na bilecie |
| Odporność | timeout, retry, circuit breaker i `503 LOYALTY_UNAVAILABLE` dla Voucherify; mail przez kolejkę |

## Decyzje projektowe

1. **Voucherify jako źródło prawdy.** Tabela `loyalty_accounts` trzyma wyłącznie `email → member_id` (kod karty) oraz datę bonusu. Saldo nigdy nie jest kopiowane do SQLite.
2. **Fallback `memory`.** Bez kompletu kluczy Voucherify (`LOYALTY_PROVIDER=auto`) działa lokalny dostawca pamięciowy, żeby demo i testy nie wymagały sieci. W produkcji ustaw klucze Sandboxa — konfiguracja ostrzega w logu startowym.
3. **Punkty pobierane przy tworzeniu sesji.** Dzięki temu kwota w Stripe od razu uwzględnia zniżkę. Jeśli Stripe odmówi, punkty wracają; jeśli sesja wygaśnie, webhook `checkout.session.expired` również je zwraca.
4. **Jedna otwarta sesja na rezerwację.** Powtórka z tym samym `Idempotency-Key` (albo nowym) wraca do istniejącej sesji i nie pobiera punktów drugi raz; nowa liczba punktów jest wtedy ignorowana.
5. **Naliczanie w jobie e-mail.** `pointsEarned` jest zapisywane w transakcji webhooka, a worker wysyła mail i dopisuje punkty do Voucherify. Znacznik `reservations.points_awarded_at` czyni job idempotentnym — brak drugiego joba i brak podwójnego naliczenia.
6. **Resend tylko z kluczem.** Bez `RESEND_API_KEY` działa dotychczasowy mock HTTP, więc Etap I/II i testy nie wymagają konta.

## Konfiguracja

```bash
VOUCHERIFY_APP_ID=...
VOUCHERIFY_APP_TOKEN=...
VOUCHERIFY_CAMPAIGN_ID=...
VOUCHERIFY_API_URL=https://api.voucherify.io   # US: https://api.us.voucherify.io
LOYALTY_PROVIDER=auto                          # memory tylko do demo/testów
LOYALTY_WELCOME_POINTS=1000

RESEND_API_KEY=re_...
RESEND_FROM=PAS Kasa <onboarding@resend.dev>
```

Pełna lista i komentarze: `.env.example`.

## Baza danych

Migracje są automatyczne przy starcie (`apps/api/src/db.ts`):

- `reservations.points_used`, `reservations.points_earned`, `reservations.points_awarded_at`,
- `checkout_sessions.points_used`,
- tabela `loyalty_accounts(email PRIMARY KEY, member_id, welcomed_at, created_at)`.

## Testy

`pnpm test` pokrywa m.in.:

- nowy e-mail → 1000 punktów, powtórka bez bonusu,
- checkout z punktami: kwota sesji, saldo, `pointsUsed` i `pointsEarned`,
- limity: ponad połowę ceny i ponad saldo → 4xx,
- wygaśnięcie sesji → zwrot punktów bez podwójnego zwrotu,
- mail z podsumowaniem punktów,
- awaria Voucherify → `503 LOYALTY_UNAVAILABLE`.

## Ograniczenia

- Konto punktowe nie jest uwierzytelniane — każdy, kto zna e-mail, widzi saldo (taki sam model zaufania jak rezerwacja bez logowania).
- `LOYALTY_PROVIDER=memory` nie przeżywa restartu i nie nadaje się na produkcję.
- Jedna instancja API serializuje pierwsze utworzenie konta w pamięci procesu; przy wielu instancjach rzadki wyścig może utworzyć dwie karty, ale tylko jedna zostanie zapisana w mapowaniu.
- Zmiana liczby punktów po utworzeniu otwartej sesji wymaga odczekania na jej wygaśnięcie (albo webhook `expired`) — obowiązuje zasada jednej otwartej sesji.
- Resend w Sandboxie wysyła tylko na adres właściciela konta; do dowolnych adresów potrzebna jest zweryfikowana domena.
