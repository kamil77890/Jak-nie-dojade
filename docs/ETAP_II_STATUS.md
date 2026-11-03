# Etap II — status (03.11.2026)

Płatność Stripe Checkout w trybie testowym według `[PAS][S01]_Projekt__Etap_II.pdf`. Gałąź `feat/etap-2-stripe`. Szczegóły kontraktu i lista zagrożeń: [`CONTRACT.md` §10](../CONTRACT.md#10-etap-ii--płatność-stripe-checkout).

## Zrobione

| Wymaganie z PDF | Gdzie | Stan |
| --- | --- | --- |
| `price` przy kursie (8900 gr = 89 zł) | `packages/shared/src/fixtures.ts`, lista, mapa, formularz | ✅ |
| `amount` zamrożone w chwili rezerwacji | `apps/api/src/booking.ts`, kolumna `reservations.amount` + migracja starej bazy | ✅ |
| Karta A: `POST /api/reservations/:id/checkout` → `{ url }`, przycisk „Zapłać 89 zł” | `apps/api/src/checkout.ts`, `apps/web/src/components/PurchasePanel.tsx` | ✅ |
| **Idempotency-Key obowiązkowy** | brak → `400 IDEMPOTENCY_KEY_REQUIRED`; klucz klienta w `sessionStorage`, pochodne klucze do Stripe'a (sesja, zwrot), deduplikacja webhooków po `event.id` | ✅ |
| Karta B: `POST /api/webhooks/stripe`, podpis `constructEvent` na surowym body | `apps/api/src/routes/webhooks.ts`, `payments.ts` | ✅ |
| Karta C: „Płatność w toku…” → bilet, po przerwaniu „Zapłać ponownie” | `apps/web/src/pages/PaymentReturnPage.tsx`, `ReservationPage` (`cancel`) | ✅ |
| `GET /api/reservations/:id` → `{ status, amount, expiresAt, code? }` | `routes/reservations.ts` | ✅ |
| Kwoty w groszach, waluta PLN | sesja Checkout, porównanie `amount_total` w webhooku | ✅ |
| Klucze tylko w env serwera, nie w repo ani w przeglądarce | `.env` (w `.gitignore`), klucz `sk_live_` wyłącza płatności | ✅ |
| Stripe na liście zagrożeń | `CONTRACT.md` §10.5 | ✅ |
| Kontrakt wewnętrzny: adresy powrotu, zapis płatności | `CONTRACT.md` §10.3 | ✅ |
| Wszystko z Etapu I działa dalej | stary `POST /purchase`: po płatności ten sam kod, bez płatności `402` | ✅ |

Ponad PDF: spóźniona, podwójna albo niezgodna kwotowo płatność → automatyczny zwrot; osobny bezpiecznik, timeout i ponowienia dla Stripe'a; jedna otwarta sesja na rezerwację.

## Jak przetestowane

- **126 testów** (`pnpm test`, wcześniej 92), w tym `apps/api/test/payments.test.ts` — atrapa Stripe'a, webhooki podpisane prawdziwym SDK. Typy i build czyste.
- **Chrome (DevTools MCP / Puppeteer), bez klucza Stripe'a:** lista z cenami → mapa → rezerwacja → „Zapłać” przy niedziałającym Stripe (komunikat, rezerwacja trwa) → anulowanie i „Zapłać ponownie” → strona powrotu + podpisany webhook → bilet bez odświeżania → podrobiony webhook `400`, powtórka bez drugiego kodu i e-maila → wygaśnięcie → płatność po czasie bez biletu → widok 390 px bez poziomego przewijania.
- **Prawdziwe SDK** dotarło do API Stripe'a; z fałszywym kluczem dostało `401`, API odpowiedziało `503` w ok. 160 ms, przyczyna jest w logu serwera.

### Na prawdziwym Stripe (tryb testowy, 03.11.2026)

Klucz `sk_test` w `.env`, webhooki przez `stripe listen --forward-to localhost:3001/api/webhooks/stripe`, przeglądarka Chrome (DevTools MCP).

| Scenariusz | Wynik |
| --- | --- |
| Karta `4242 4242 4242 4242` | Checkout z kwotą 89,00 zł i opisem kursu → `checkout.session.completed` → webhook `200` → strona powrotu zamienia się w bilet (`PAS-647DRS`) |
| Karta `4000 0000 0000 0002` (odmowa) | Stripe: „Karta została odrzucona”, brak webhooka; „Wstecz” → „Płatność przerwana. Nic nie pobraliśmy”, przycisk „Zapłać ponownie 89 zł”, licznik biegnie |
| Karta `4000 0025 0000 3155` (3D Secure) | okno 3D Secure 2 → „Complete” → bilet (`PAS-ESNPAG`) |
| Płatność po wygaśnięciu (`RESERVATION_TTL_SECONDS=60`) | rezerwacja `expired`, zapłata kartą 4242 → webhook `200`, log `late_payment, refunded: true`, w Stripe zwrot 89,00 zł `succeeded`; bez biletu, klient widzi komunikat o automatycznym zwrocie |
| Ponowna dostawa zdarzenia (`stripe events resend`) | webhook `200`, ten sam kod biletu, jeden job e-mail |
| Podrobiony webhook (zły podpis / brak podpisu) | `400 INVALID_SIGNATURE`, stan bez zmian |
| `checkout` dla opłaconej / wygasłej rezerwacji | `409 RESERVATION_PAID` / `409 RESERVATION_EXPIRED` |
| Widok 390 px | przycisk „Zapłać” widoczny na pierwszym ekranie, pod licznikiem; bez poziomego przewijania |

## Do zrobienia

| Co | Dlaczego | Co trzeba |
| --- | --- | --- |
| Nauczyciel w koncie Stripe (tylko odczyt) | czynność w panelu Stripe | Settings → Team and security → Invite, rola *View only* |
| Wdrożenie | PDF zakłada Vercel/Next.js; nasze API (Fastify, SQLite, worker w tle) wymaga stałego procesu, a webhook — stałego publicznego adresu | wdrożyć API na Render/Railway (jeden proces, `README` → „Wdrożenie”), ustawić klucze i `PUBLIC_URL`, dodać endpoint webhooka w panelu Stripe |
| Wiele instancji API | blokada „jedna sesja naraz” jest w pamięci procesu | przy skalowaniu przenieść do bazy |

Zrobione od poprzedniej wersji: klucze `sk_test` i `whsec` w `.env`, testy na prawdziwej stronie Stripe'a (wszystkie trzy karty), prawdziwy zwrot spóźnionej płatności, panel płatności na telefonie przesunięty pod licznik (`apps/web/src/styles.css`, widok ≤ 900 px).

## Klucze — ściąga

```bash
# .env w root repo (jest w .gitignore — nie commitować)
STRIPE_SECRET_KEY=sk_test_...      # tajny klucz testowy; pk_test_ NIE wystarczy
STRIPE_WEBHOOK_SECRET=whsec_...    # z `stripe listen` albo z panelu (endpoint)
PUBLIC_URL=http://localhost:5173   # na serwerze: publiczny adres sklepu
```

Bez tych zmiennych aplikacja działa, ale „Zapłać” i webhook odpowiadają `503 PAYMENTS_UNAVAILABLE`, a log startowy ostrzega o wyłączonych płatnościach.
