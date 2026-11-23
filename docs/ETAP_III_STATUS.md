# Etap III — status wdrożenia

Zakres: konta punktowe w Voucherify, płatność punktami w Stripe Checkout, naliczanie punktów po zakupie i mail z podsumowaniem przez Resend. Etapy I i II działają bez zmian.

## Co działa

| Obszar | Realizacja |
| --- | --- |
| Saldo punktów | `GET /api/loyalty?email=…` → `{ email, points }`; e-mail bez karty ma 1000 punktów **bez wywołania Voucherify** |
| Źródło prawdy | Voucherify (karta lojalnościowa per e-mail); SQLite tylko mapuje e-mail → `member_id`; cache salda 30 s w pamięci to tylko optymalizacja |
| Limit Voucherify (100/h) | budżet 90/h z priorytetami (odczyt < checkout < zwrot/naliczenie), `429` od Voucherify respektuje `Retry-After`, limit per IP na `GET /api/loyalty` |
| Płatność punktami | `POST /api/reservations/:id/checkout` z `{ points }`; 1 pkt = 1 gr, maks. połowa ceny |
| Naliczanie | 10 pkt za każdy pełny złoty zapłacony kartą; `pointsEarned` liczone przy webhooku |
| Status | `GET /api/reservations/:id` zwraca `pointsUsed` (zawsze) i `pointsEarned` (tylko po opłaceniu) |
| Mail | Resend (albo mock w dev) z biletem i podsumowaniem: kartą / punktami / zebrane |
| Zwroty punktów | nieudany Stripe, `checkout.session.expired`, zwrot płatności w webhooku i zmiana punktów oddają punkty dokładnie raz (`checkout_sessions.points_refunded_at`) |
| Zmiana punktów | inna liczba punktów przy otwartej sesji → stara sesja wygaszona w Stripe, punkty wracają, nowa sesja na nową kwotę |
| UI | saldo po wyjściu z pola e-mail (raz na adres, wynik w `sessionStorage`), pole „Użyj punktów” w podsumowaniu bez drugiego zapytania, podsumowanie na bilecie |
| Odporność | timeout, retry, circuit breaker i `503 LOYALTY_UNAVAILABLE` dla Voucherify; mail przez kolejkę |
| Błędy API | koperta `{ error, message, retryAfter? }`: kod dla programu, komunikat po polsku dla człowieka; `5xx` bez szczegółów |

## Decyzje projektowe

1. **Voucherify jako źródło prawdy.** Tabela `loyalty_accounts` trzyma wyłącznie `email → member_id` (kod karty) oraz datę bonusu. Saldo nigdy nie jest kopiowane do SQLite.
2. **Fallback `memory`.** Bez kompletu kluczy Voucherify (`LOYALTY_PROVIDER=auto`) działa lokalny dostawca pamięciowy, żeby demo i testy nie wymagały sieci. W produkcji ustaw klucze Sandboxa — konfiguracja ostrzega w logu startowym.
3. **Punkty pobierane przy tworzeniu sesji.** Dzięki temu kwota w Stripe od razu uwzględnia zniżkę. Jeśli Stripe odmówi, punkty wracają; jeśli sesja wygaśnie albo płatność zostanie zwrócona (spóźniona, zajęte miejsce, zła kwota, druga sesja), webhook oddaje punkty tej sesji.
4. **Jedna otwarta sesja na rezerwację.** Powtórka z tą samą liczbą punktów (ten sam albo nowy `Idempotency-Key`) wraca do istniejącej sesji i nie pobiera punktów drugi raz. Inna liczba punktów wygasza starą sesję w Stripe (`checkout.sessions.expire`), oddaje jej punkty i tworzy nową — zamiast po cichu zostawić starą kwotę. Uzasadnienie w CONTRACT.md §11.2.
5. **Naliczanie w jobie e-mail.** `pointsEarned` jest zapisywane w transakcji webhooka, a worker wysyła mail i dopisuje punkty do Voucherify. Znacznik `reservations.points_awarded_at` czyni job idempotentnym — brak drugiego joba i brak podwójnego naliczenia.
6. **Resend tylko z kluczem.** Bez `RESEND_API_KEY` działa dotychczasowy mock HTTP, więc Etap I/II i testy nie wymagają konta.
7. **Jeden mechanizm zwrotu punktów.** `CheckoutService.releaseSessionPoints`: znacznik `points_refunded_at` stawiany w transakcji przed wywołaniem Voucherify i zdejmowany, gdy ono padnie. Webhook zapisuje zdarzenie dopiero po zwrocie pieniędzy i punktów, więc ponowienie od Stripe'a dokańcza brakujące kroki. `confirmPayment` nie wyda biletu z sesji, której punkty już wróciły.
8. **`pointsUsed` przed płatnością** = punkty pobrane na sesje tej rezerwacji i jeszcze niezwrócone (zgadza się ze spadkiem salda); `pointsEarned` występuje tylko przy `paid`.
9. **Leniwe konto punktowe.** Kto nic nie kupił, ma z definicji 1000 punktów — `GET /api/loyalty` odpowiada bez Voucherify i bez zakładania karty (literówka w polu e-mail nie tworzy karty i nie zużywa limitu). Karta + bonus powstają przy pierwszym zapisie: pobraniu punktów w checkoucie albo naliczeniu po zakupie. Bonus jest „zajmowany” w bazie przed korektą (`welcome_pending`), więc równoległe requesty nie dadzą go dwa razy; karta, która w Voucherify już ma historię punktów (zgubione mapowanie), bonusu nie dostaje; próba z niepewnym wynikiem (timeout) przed ponowieniem sprawdza saldo.
10. **Budżet wywołań Voucherify.** Sandbox przyjmuje najwyżej 100 wywołań/h. `CallBudget` (okno przesuwne 1 h, domyślnie 90) liczy każde wyjście do sieci, także ponowienia. Priorytety: odczyt salda do 50, checkout do 70, zwrot punktów i naliczenie po zakupie do 90 — zalew odczytów nie zablokuje zakupów ani zwrotów. Odmowa = `503 LOYALTY_UNAVAILABLE` z `Retry-After` do zwolnienia miejsca (dla samego wyświetlenia — niedawne saldo z cache, jeśli jest). Job naliczenia czeka na okno bez zużywania prób, więc punkty nie lądują w DLQ.
11. **429 od Voucherify.** Bez natychmiastowego ponowienia; `Retry-After` blokuje wszystkie wywołania do Voucherify i wraca do klienta. 429 nie grzeje bezpiecznika — Voucherify działa, tylko każe czekać, a dokładny czas zna z nagłówka.
12. **Cache salda.** 30 s w pamięci procesu, nadpisywany wynikiem każdej naszej korekty (spend/award/zwrot), czyszczony po nieudanej korekcie. Checkout może użyć świeżego cache do wstępnego sprawdzenia, bo samo pobranie jest atomowe w Voucherify (brak punktów → `409` bez zapisów); starego cache w checkoucie nie używamy.
13. **Korekta salda bez automatycznego retry.** `POST /balance` nie jest idempotentne — ponowienie po timeoucie mogło pobrać punkty dwa razy. Ponawiamy tylko odczyty i zakładanie karty.

## Konfiguracja

```bash
VOUCHERIFY_APP_ID=...
VOUCHERIFY_APP_TOKEN=...
VOUCHERIFY_CAMPAIGN_ID=...
VOUCHERIFY_API_URL=https://api.voucherify.io   # US: https://api.us.voucherify.io
LOYALTY_PROVIDER=auto                          # memory tylko do demo/testów
LOYALTY_WELCOME_POINTS=1000
VOUCHERIFY_HOURLY_BUDGET=90                    # Sandbox: maks. 100 wywołań/h
VOUCHERIFY_RESERVE_CRITICAL=20                 # tylko zwroty i naliczenia
VOUCHERIFY_RESERVE_CHECKOUT=20                 # checkout; odczyty do 90-20-20 = 50
LOYALTY_BALANCE_CACHE_SECONDS=30
LOYALTY_BALANCE_STALE_SECONDS=600              # tylko do wyświetlenia przy awarii/limicie
RATE_LIMIT_LOYALTY_CAPACITY=10                 # GET /api/loyalty per IP
RATE_LIMIT_LOYALTY_PER_MINUTE=6

RESEND_API_KEY=re_...
RESEND_FROM=PAS Kasa <onboarding@resend.dev>
```

Pełna lista i komentarze: `.env.example`.

## Baza danych

Migracje są automatyczne przy starcie (`apps/api/src/db.ts`):

- `reservations.points_used`, `reservations.points_earned`, `reservations.points_awarded_at`,
- `checkout_sessions.points_used`,
- `checkout_sessions.points_refunded_at` (przy migracji wygasłe sesje z punktami dostają znacznik — stary kod już je oddał),
- tabela `loyalty_accounts(email PRIMARY KEY, member_id, welcomed_at, created_at, welcome_pending)` — `welcome_pending` dochodzi migracją do istniejącej bazy (domyślnie `0` = bonus przyznany).

## Testy

`pnpm test` pokrywa m.in.:

- nowy e-mail → 1000 punktów bez wywołania Voucherify i bez wiersza w bazie (także seria literówek),
- leniwe założenie karty przy pierwszym pobraniu/naliczeniu, jeden bonus przy równoległych zakupach, zgubione mapowanie, niepewna i odrzucona próba bonusu,
- cache: trafienie w TTL, zmiana poza nami widoczna po TTL, nadpisanie po korekcie, unieważnienie po błędzie, stare saldo tylko do wyświetlenia,
- budżet: odczyty kończą się pierwsze, checkout i zwroty mają rezerwę, `Retry-After`, stan w `/api/ops/status`, job naliczenia czeka na okno zamiast DLQ,
- `429` Voucherify: bez ponowień, `Retry-After` (sekundy/data), blokada kolejnych wywołań, bezpiecznik zamknięty,
- `GET /api/loyalty`: walidacja (brak/pusty/powtórzony/za długi/zły e-mail → 400), limit per IP → 429, 5xx bez wycieku szczegółów,
- Resend Sandbox: `403` jest trwały i nie blokuje naliczenia punktów; `bounced@resend.dev` przyjęty (`200`),
- frontend: literówki nie wysyłają zapytań, saldo po wyjściu z pola raz na e-mail, ekran płatności bez drugiego zapytania, `429`/`503` nie blokują płatności kartą,
- checkout z punktami: kwota sesji, saldo, `pointsUsed` i `pointsEarned`,
- limity: ponad połowę ceny i ponad saldo → 4xx,
- wygaśnięcie sesji → zwrot punktów bez podwójnego zwrotu,
- zwrot płatności (spóźniona, zajęte miejsce, zła kwota, druga sesja, nieznana rezerwacja) → zwrot punktów tej sesji raz, także po awarii Voucherify albo Stripe'a i ponowieniu webhooka (`points-refund.test.ts`),
- zmiana liczby punktów: ten sam/nowy klucz, za mało punktów, Stripe niedostępny, sesja już opłacona, awaria Voucherify przy zwrocie, spóźniony `completed` starej sesji, równoległe żądania,
- `pointsEarned` tylko po opłaceniu, `pointsUsed` = punkty pobrane i niezwrócone,
- walidacja `points` (400) vs reguły biznesowe (409) vs awarie (503 z `Retry-After`, bez szczegółów),
- migracja `points_refunded_at` na starej bazie,
- mail z podsumowaniem punktów,
- awaria Voucherify → `503 LOYALTY_UNAVAILABLE`,
- Stripe i Voucherify padają naraz przy tworzeniu sesji → zaległy zwrot w kolejce, każde pobranie oddane dokładnie raz (`points-refund.test.ts`),
- koperta błędu `{ error, message, retryAfter? }`: konkretny komunikat przy `4xx`, ogólny przy `5xx` i błędach parsera, bez przyczyny technicznej (`error-envelope.test.ts`).

## Ograniczenia

- Konto punktowe nie jest uwierzytelniane — każdy, kto zna e-mail, widzi saldo (taki sam model zaufania jak rezerwacja bez logowania).
- `LOYALTY_PROVIDER=memory` nie przeżywa restartu i nie nadaje się na produkcję.
- Jedna instancja API serializuje pierwsze utworzenie konta w pamięci procesu; przy wielu instancjach drugie `createMember` dostaje od Voucherify „karta istnieje” i trafia w tę samą kartę, a bonus chroni `welcome_pending` w bazie.
- Legacy API Voucherify nie ma klucza idempotencji: timeout, po którym punkty jednak zostały dopisane, może przy ponowieniu dać podwójny zwrot (wybraliśmy to zamiast utraty punktów). Awaria procesu między znacznikiem a Voucherify może z kolei zostawić punkty niezwrócone — oba przypadki do ręcznej korekty.
- Punkty po odmowie Stripe'a przy tworzeniu sesji wracają od razu, a gdy padnie także Voucherify — przez job `refund-points` w kolejce (retry, czekanie na limit). Job w DLQ (np. Voucherify leży dłużej niż wszystkie próby) trzeba ponowić ręcznie w `/lab`.
- Blokada checkoutu per rezerwacja działa w obrębie jednego procesu (jak cała baza SQLite).
- Budżet wywołań i cache salda są w pamięci procesu: restart zeruje licznik (Voucherify liczy dalej — dlatego zapas 90 vs 100), a przy kilku instancjach trzeba podzielić `VOUCHERIFY_HOURLY_BUDGET` albo przenieść licznik do Redisa.
- E-mail bez wiersza w `loyalty_accounts` ma w odczycie 1000 punktów. Jeśli baza zgubiła mapowanie, a karta istnieje w Voucherify, odczyt pokaże 1000 do pierwszego zapisu (który odnajdzie kartę i jej prawdziwe saldo; pobranie ponad saldo kończy się `409`).
- Niepewny wynik korekty salda (timeout po stronie Voucherify) nie jest ponawiany automatycznie; przy bonusie powitalnym ponowienie najpierw sprawdza saldo karty.
- Odbicia maili (np. `bounced@resend.dev`) Resend zgłasza asynchronicznie webhookiem, którego nie konsumujemy — status maila w `/lab` pokazuje „wysłany”.
- Resend w Sandboxie wysyła tylko na adres właściciela konta; do dowolnych adresów potrzebna jest zweryfikowana domena.
