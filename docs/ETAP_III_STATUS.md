# Etap III — status wdrożenia

Zakres: konta punktowe w Voucherify, płatność punktami w Stripe Checkout, naliczanie punktów po zakupie i mail z podsumowaniem przez Resend. Etapy I i II działają bez zmian.

## Co działa

| Obszar | Realizacja |
| --- | --- |
| Saldo punktów | `GET /api/loyalty?email=…` → `{ email, points }`; e-mail bez karty ma 1000 punktów bez wywołania Voucherify (wyszukanie karty z panelu/kasy tylko z `LOYALTY_LOOKUP_UNKNOWN_CARDS=true`); niezakodowany `+` w `?email=` działa |
| Źródło prawdy | Voucherify (karta lojalnościowa per e-mail); SQLite tylko mapuje e-mail → `member_id`; cache salda 10 s w pamięci to tylko optymalizacja odczytu, checkout czyta saldo świeżo |
| Limit Voucherify (100/h) | budżet 90/h z priorytetami (odczyt do 15 < checkout do 70, rezerwa 55 < zwrot/naliczenie do 90), `429` od Voucherify respektuje `Retry-After`, limit per IP na `GET /api/loyalty`, limit per IP i per e-mail na checkout z punktami |
| Płatność punktami | `POST /api/reservations/:id/checkout` z `{ points }`; 1 pkt = 1 gr, maks. połowa ceny |
| Naliczanie | 10 pkt za każdy pełny złoty zapłacony kartą; `pointsEarned` liczone przy webhooku |
| Status | `GET /api/reservations/:id` zwraca `pointsUsed` (zawsze) i `pointsEarned` (tylko po opłaceniu) |
| Mail | Resend (albo mock w dev) z biletem i podsumowaniem: kartą / punktami / zebrane |
| Zwroty punktów | wygaśnięcie rezerwacji (zamiatanie co 2 s: ≤ 15 s po `expiresAt`), nieudany Stripe, `checkout.session.expired`, zwrot płatności w webhooku i zmiana punktów oddają punkty dokładnie raz (`checkout_sessions.points_refunded_at`) |
| Wyścig na saldzie | checkouty z punktami jednego e-maila pod blokadą, świeże saldo tuż przed pobraniem; nie polegamy na tym, że Voucherify odrzuca saldo ujemne |
| Awaria Voucherify | naliczenie i zaległe zwroty czekają na Voucherify (5 s → 60 s, bez zużywania prób, do 24 h); mail idzie od razu i raz |
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
9. **Leniwe konto punktowe.** Kto nic nie kupił, ma z definicji 1000 punktów — `GET /api/loyalty` nie zakłada karty (literówka w polu e-mail nie tworzy karty). Domyślnie nie pyta przy tym Voucherify (oficjalne kryteria nie sprawdzają kart z panelu, a test używa wielu adresów `delivered+…@resend.dev`); z `LOYALTY_LOOKUP_UNKNOWN_CARDS=true` robi jedno wyszukanie karty (wynik „brak karty” pamiętany 10 s) i karta z panelu albo kasy dostaje mapowanie. Bez budżetu odczytów albo przy awarii odpowiada 1000 bez `503` — checkout i tak sprawdza prawdziwą kartę przed pobraniem. Karta + bonus powstają przy pierwszym zapisie: pobraniu punktów w checkoucie albo naliczeniu po zakupie. Bonus jest „zajmowany” w bazie przed korektą (`welcome_pending`), więc równoległe requesty nie dadzą go dwa razy; karta, która w Voucherify już ma historię punktów (zgubione mapowanie), bonusu nie dostaje; próba z niepewnym wynikiem (timeout) przed ponowieniem sprawdza saldo.
10. **Budżet wywołań Voucherify.** Sandbox przyjmuje najwyżej 100 wywołań/h. `CallBudget` (okno przesuwne 1 h, domyślnie 90) liczy każde wyjście do sieci, także ponowienia. Priorytety: odczyt salda do 15, checkout do 70 (co najmniej 55 tylko dla niego), zwrot punktów i naliczenie po zakupie do 90 (co najmniej 20 tylko dla nich); progi liczą wszystkie wywołania w oknie, więc po 45 wywołaniach w godzinie odczyty (także wyszukanie karty z panelu) są wstrzymane — zalew odczytów nie zablokuje zakupów ani zwrotów. Koszt wywołań na zakup i przepustowość: CONTRACT.md §11.6.1 (ok. 18 zakupów z punktami nowych klientów albo ok. 22 stałych na godzinę). Odmowa = `503 LOYALTY_UNAVAILABLE` z `Retry-After` do zwolnienia miejsca (dla samego wyświetlenia — niedawne saldo z cache, jeśli jest). Job naliczenia czeka na okno bez zużywania prób, więc punkty nie lądują w DLQ.
11. **429 od Voucherify.** Bez natychmiastowego ponowienia; `Retry-After` blokuje wszystkie wywołania do Voucherify i wraca do klienta. 429 nie grzeje bezpiecznika — Voucherify działa, tylko każe czekać, a dokładny czas zna z nagłówka.
12. **Cache salda.** 10 s w pamięci procesu (zmiana w panelu widoczna w ≤ 10 s), nadpisywany wynikiem każdej naszej korekty (spend/award/zwrot), czyszczony po nieudanej korekcie. Checkout go nie używa.
13. **Korekta salda bez automatycznego retry.** `POST /balance` nie jest idempotentne — ponowienie po timeoucie mogło pobrać punkty dwa razy. Ponawiamy tylko odczyty i zakładanie karty.
14. **Blokada pobrań per e-mail + świeże saldo (III.B3).** Checkouty z punktami jednego e-maila idą w procesie jeden po drugim (`LoyaltyService.withSpendLock`, wewnątrz istniejącej blokady per rezerwacja). Pod blokadą: świeży odczyt salda (wartość z cache sprzed blokady się nie liczy; liczy się wynik bonusu albo zwrotu otrzymany już pod blokadą — bez dodatkowego wywołania), porównanie, ewentualne wygaszenie starej sesji, pobranie. Świeży odczyt **zastępuje** dawne wstępne sprawdzenie, a nie dochodzi do niego. Pobranie, które mimo to zejdzie poniżej zera (zmiana poza nami), jest od razu oddawane i kończy się `409`. E-mail bez mapowania przy pobraniu ≤ bonusu nie kosztuje odczytu: kartę zakłada samo pobranie, a gdy karta już istniała, przed odjęciem porównujemy jej saldo.
15. **Zamiatanie porzuconych sesji (III.B4).** `PointsReleaseSweeper` co 2 s woła `CheckoutService.releaseAbandonedSessionPoints`: najpierw `checkout.sessions.expire` w Stripe (klucz `pas-expire-<id>`, ten sam co przy zmianie punktów), potem `expired` w bazie i zwrot przez `releaseSessionPoints`. Stripe „opłacona” → nic nie ruszamy (webhook), sesja wraca do sprawdzenia po minucie. Błąd Stripe'a/Voucherify → backoff 2 s → 60 s (przy limicie `Retry-After`). Każda sesja pod blokadą rezerwacji, więc nie ściga się z checkoutem.
16. **Awaria Voucherify w jobach (III.X1).** `LoyaltyUnavailableError` (nie tylko limit) daje `deferMs`: odstęp = połowa wieku joba, od 5 s do 60 s; próby nie liczą się do `WORKER_MAX_ATTEMPTS` przez 24 h od utworzenia joba, potem zwykłe próby i DLQ. Mail idzie przed punktami, a `jobs.input.mailSentAt` sprawia, że job, który wraca tylko po punkty, nie wysyła go drugi raz.
17. **Limit checkoutów z punktami.** Per IP 12 na start i 6/h, per e-mail 6 i 6/h (`TokenBucket`), pobierany w `CheckoutService` tuż przed pierwszym wywołaniem Voucherify; `503` oddaje żeton. Normalny klient (kilka prób) go nie trafi, test wyścigu z jednego IP (10 checkoutów) się mieści, a jedno IP zużyje najwyżej ok. 36 wywołań naraz i ok. 18/h.

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
VOUCHERIFY_RESERVE_CHECKOUT=55                 # checkout do 90-20 = 70; odczyty do 90-20-55 = 15
LOYALTY_BALANCE_CACHE_SECONDS=10
LOYALTY_BALANCE_STALE_SECONDS=600              # tylko do wyświetlenia przy awarii/limicie
LOYALTY_LOOKUP_UNKNOWN_CARDS=false             # true = GET szuka karty z panelu/kasy (1 odczyt)
LOYALTY_NO_CARD_CACHE_SECONDS=10               # „brak karty” po wyszukaniu (tylko z LOOKUP=true)
RATE_LIMIT_LOYALTY_CAPACITY=30                 # GET /api/loyalty per IP
RATE_LIMIT_LOYALTY_PER_MINUTE=20
RATE_LIMIT_POINTS_IP_CAPACITY=30               # checkout z punktami per IP
RATE_LIMIT_POINTS_IP_PER_HOUR=6
RATE_LIMIT_POINTS_EMAIL_CAPACITY=6             # checkout z punktami per e-mail
RATE_LIMIT_POINTS_EMAIL_PER_HOUR=6
POINTS_SWEEP_INTERVAL_MS=2000                  # zwrot punktów porzuconych sesji
WORKER_LOYALTY_RETRY_BASE_MS=5000              # job czeka na Voucherify: 5 s → 60 s, do 24 h
WORKER_LOYALTY_RETRY_MAX_MS=60000
WORKER_LOYALTY_RETRY_HORIZON_HOURS=24

RESEND_API_KEY=re_...
RESEND_FROM=PAS Kasa <onboarding@resend.dev>
```

Pełna lista i komentarze: `.env.example`.

## Baza danych

Migracje są automatyczne przy starcie (`apps/api/src/db.ts`):

- `reservations.points_used`, `reservations.points_earned`, `reservations.points_awarded_at`,
- `checkout_sessions.points_used`,
- `checkout_sessions.points_refunded_at` (przy migracji wygasłe sesje z punktami dostają znacznik — stary kod już je oddał),
- tabela `loyalty_accounts(email PRIMARY KEY, member_id, welcomed_at, created_at, welcome_pending)` — `welcome_pending` dochodzi migracją do istniejącej bazy (domyślnie `0` = bonus przyznany),
- `jobs.input.mailSentAt` (w JSON wejścia joba, bez migracji) — mail z biletem już wysłany.

## Testy

`pnpm test` pokrywa m.in.:

- nowy e-mail → 1000 punktów po jednym wyszukaniu karty (odczyt), bez zakładania karty i wiersza w bazie (także seria literówek),
- III.A2 (`loyalty-criteria.test.ts`): karta z panelu z 3000 → `GET` 3000, checkout 2000 → `200`; karta z 200 → checkout 1000 → `409` bez zapisu, 200 → sesja 8700; karta bez historii → bonus raz; „brak karty” i korekta w panelu widoczne po 10 s; awaria wyszukania → 1000 bez `503`; to samo przez HTTP z prawdziwym klientem Voucherify,
- III.B3 (`loyalty-criteria.test.ts`): dostawca dopuszczający saldo ujemne — 5 prób po dwa równoległe checkouty: zawsze `200` + `409`, saldo 0, jeden wpis −1000, przegrany kupuje kartą za 8900; przez HTTP — koszt 3 + 1 wywołania; zmiana salda poza nami między odczytem a pobraniem → zwrot i `409`,
- III.B4 (`points-sweep.test.ts`, sterowany zegar): punkty wracają w pierwszym przebiegu po `expiresAt`, sesja wygaszona w Stripe, `pointsUsed: 0`; `expired` od Stripe'a (2×) i spóźniony `completed` nie dublują; Stripe „opłacona” → punkty zostają, bilet z webhooka; `completed` równolegle z zamiataniem; Stripe niedostępny, Voucherify niedostępny i limit (`Retry-After`) → ponowienie bez zgubienia; sesje bez punktów i opłacone nietknięte; interwał w aplikacji,
- III.X1 (`loyalty-outage.test.ts`): 401 przez 20 min — 40 prób bez DLQ, odstęp 5 s → 60 s, jeden mail, po przywróceniu punkty w ≤ 2 min; mail następnego klienta niezablokowany; horyzont → DLQ i ręczne „Ponów” bez drugiego maila; `refund-points` czeka zamiast DLQ,
- limit checkoutów z punktami: 12 z jednego IP przechodzi, 13. → `429` z `Retry-After`, inne IP kupuje; walidacja, `409` limitu, powtórka sesji nie zużywają żetonu, `503` go oddaje; limit per e-mail; koszt wywołań na zakup (nowy i stały klient),
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
- Punkty po odmowie Stripe'a przy tworzeniu sesji wracają od razu, a gdy padnie także Voucherify — przez job `refund-points` w kolejce (czeka na Voucherify do 24 h). Job w DLQ (Voucherify leży dłużej niż 24 h albo błąd trwały) trzeba ponowić ręcznie w `/lab`.
- Blokada checkoutu per rezerwacja i blokada pobrań per e-mail działają w obrębie jednego procesu (jak cała baza SQLite). Przy kilku instancjach dwa checkouty jednego e-maila na różnych instancjach mogą równocześnie przejść świeży odczyt; jeśli Voucherify przyjmie wtedy saldo ujemne, kontrola po pobraniu od razu oddaje punkty (`409`), ale przez czas jednego wywołania saldo jest ujemne. Pełne rozwiązanie wymaga wspólnej blokady (Redis/DB).
- Zmiana zachowania (II.A2 z punktami): sesja z punktami jest wygaszana w Stripe ok. 2 s po `expiresAt`, więc spóźniona zapłata tym linkiem jest odrzucana przez Stripe (klient nie zostaje obciążony), zamiast przyjęcia i automatycznego zwrotu. Sesje bez punktów zachowują się jak w Etapie II (zapłata po czasie → zwrot). W okienku między `expiresAt` a zamiataniem zapłata nadal kończy się zwrotem pieniędzy i punktów.
- Zamiatanie porzuconych sesji działa w procesie API (co 2 s). Gdy proces nie działa, punkty odda webhook `checkout.session.expired` albo zamiatanie po starcie.
- Budżet wywołań i cache salda są w pamięci procesu: restart zeruje licznik (Voucherify liczy dalej — dlatego zapas 90 vs 100), a przy kilku instancjach trzeba podzielić `VOUCHERIFY_HOURLY_BUDGET` albo przenieść licznik do Redisa.
- E-mail bez wiersza w `loyalty_accounts`, przy wyczerpanym budżecie odczytów albo awarii Voucherify, ma w odczycie 1000 punktów, nawet jeśli karta istnieje (panel, kasa). Checkout i tak użyje prawdziwego salda karty.
- Limit checkoutów z punktami per IP nie odróżni prowadzącego od atakującego: 12 na start mieści test wyścigu (10 checkoutów), ale cały test z jednego IP z ponad ok. 18 checkoutami z punktami w godzinie dostanie `429` (env `RATE_LIMIT_POINTS_IP_*`).
- Niepewny wynik korekty salda (timeout po stronie Voucherify) nie jest ponawiany automatycznie; przy bonusie powitalnym ponowienie najpierw sprawdza saldo karty.
- Odbicia maili (np. `bounced@resend.dev`) Resend zgłasza asynchronicznie webhookiem, którego nie konsumujemy — status maila w `/lab` pokazuje „wysłany”.
- Resend w Sandboxie wysyła tylko na adres właściciela konta; do dowolnych adresów potrzebna jest zweryfikowana domena.
