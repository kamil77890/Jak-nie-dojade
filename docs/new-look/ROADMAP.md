# Nowy wygląd — ścieżka rozwoju

Stan na 03.11.2026. Jak doprowadzić nowy wygląd `apps/web` do merge'a z `main`. Obowiązują [zasady główne](./PRINCIPLES.md#zasady-główne): zrzut przed i po z raportem HTML, zero zmian funkcjonalności bez zgody, te same możliwości na każdym ekranie, przenoszenie tylko po konsultacji.

## Gdzie jesteśmy

| Gałąź | Commit | Co zawiera |
| --- | --- | --- |
| `main` | `2e1a9a5` | **stary wygląd** + API po audycie + zgodność z kartami A/B/C + Etap II (Stripe Checkout) |
| `origin/nowy-wyglad` | `7052a0d` | nowy wygląd z poziomu Etapu I: bez płatności i bez zmian po audycie |
| `wip/nowy-wyglad` (tylko lokalnie) | `d549b5b` | `nowy-wyglad` + poprawki ekranu licznika, liczb z API, hero i błędu rezerwacji |
| `feat/new-look-pkp-ideas` (tylko lokalnie) | `5633acb` | `wip/nowy-wyglad` + raporty 01–10 (pasek kroków, „Aa”, ciemny motyw) |
| `feat/new-look` (tylko lokalnie) | — | `main` + nowy wygląd z `feat/new-look-pkp-ideas`, logika z `main` (raport 11) |

`main` zawiera revert nowego wyglądu (`1c42309`), więc zwykły merge go nie przywróci. Redesign wraca przez `git revert 1c42309` na gałęzi roboczej.

**Punkt odniesienia:** możliwości każdego ekranu bierzemy z `main`. Nowy wygląd z `nowy-wyglad` nie ma płatności Stripe ani zmian po audycie, więc na kilku ekranach ma **mniej** możliwości niż `main`. Te braki uzupełniamy, nie zmieniając logiki: komponenty i wywołania z `main` dostają nowy markup.

## Etapy

### 0. Przygotowanie

- [x] Gałąź `feat/new-look` od aktualnego `main`.
- [x] Zrzuty „przed” wszystkich ekranów z `main` (laptop 1440 × 900, tablet 820 × 1180, telefon 390 × 844; oba motywy; wszystkie stany z inwentarza). To baza dla raportów.
- [x] Narzędzie do raportu: skrypt, który składa zrzuty przed i po, ramki z numerami i listę zmian w `index.html`.

### 1. Fundament wyglądu

- [x] Wygląd (style, czcionki, `Shell`, motywy, animacje, media) wzięty z `feat/new-look-pkp-ideas` zamiast `git revert 1c42309` — ten sam efekt, bez starych wersji plików logiki.
- [x] Pliki logiki (`lib/api.ts`, `session.ts`, `errors.ts`, hooki) i testy biorę **w wersji z `main`**. Revert reverta przywróciłby ich starsze wersje.
- [x] `pnpm install` (wracają `gsap`, `lenis`, `tailwindcss`, Archivo).
- [x] **Raport 11** (jeden na etapy 1–3): wszystkie ekrany i stany, przed (`main`) i po (jasny, ciemny). Czeka na akceptację.

### 2. Ekrany — po kolei, każdy z osobnym raportem

Dla każdego ekranu: zrzut przed (`main`) → nowy markup z logiką z `main` → zrzut po → raport → akceptacja → następny ekran.

| Krok | Ekran | Trasa | Co szczególnie sprawdzić |
| --- | --- | --- | --- |
| 2.1 | Rozkład | `/` | cena, wagony, miejsca i wolne z API (`EventListItem`); tego nie ma w `nowy-wyglad` |
| 2.2 | Mapa wagonu | `/events/:id` | przełącznik wagonów, odświeżanie, legenda okno/korytarz |
| 2.3 | Formularz | `/events/:id/reserve/:seatId` | etykieta „Wagon 5, miejsce 12”, cena, TTL z serwera |
| 2.4 | Licznik i płatność | `/reservations/:id` i `…/payment/cancel` | „Zapłać 89 zł”, „Zapłać ponownie”, stan po `409`, opłacona, wygasła; tego nie ma w `nowy-wyglad` |
| 2.5 | Powrót z płatności | `/reservations/:id/payment/success` | ekran **nie istnieje** w `nowy-wyglad`; nowy markup dla logiki z `main` |
| 2.6 | Bilet | `/reservations/:id/ticket` | wszystkie pola biletu, drukowanie |
| 2.7 | Nie znaleziono | `*` | — |
| 2.8 | Laboratorium | `/lab` | poziomy scroll na telefonie |

Poprawki z `d549b5b` (ekran licznika, liczby z API, hero, błąd rezerwacji) wchodzą w krokach 2.1, 2.3 i 2.4. Ich logika już jest na `main`, więc przenoszę tylko wygląd.

### 3. Testy

- [x] Testy UI i E2E z `main` (126) przechodzą na nowych ekranach, razem 129. Zmienione 3 selektory (lista w raporcie 11).

### 4. Raport końcowy i PR

- [ ] Raport zbiorczy: wszystkie ekrany przed i po, cały inwentarz odhaczony, lista decyzji podjętych przez autora projektu.
- [ ] PR `feat/new-look` → `main` **dopiero po akceptacji autora projektu**.
- [ ] Po merge'u: usunąć `wip/nowy-wyglad` i `nowy-wyglad`.

## Inwentarz możliwości ekranów

Stan `main` (`2e1a9a5`). Po zmianach każdy ekran ma mieć wszystko z tej listy. Brak albo przeniesienie pozycji wymaga zgody autora projektu.

### Wspólne (Shell)

- Logo prowadzi na stronę główną.
- Nawigacja: Rozkład (`/`), Laboratorium (`/lab`).
- Link do laboratorium w stopce.

### Rozkład `/`

- Lista kursów z API. Każdy kurs pokazuje: dzień, miesiąc, rok, numer pociągu, dzień tygodnia, relację, odjazd, przyjazd, czas podróży, pełną datę, **cenę**, liczbę wagonów, liczbę miejsc, **wolne miejsca** (z oznaczeniem „wyprzedane”).
- Klik w kurs otwiera mapę wagonu.
- Stany: ładowanie, błąd z ponowieniem („Rozkład nie odpowiada”), pusta lista („Na razie pusto na peronie”).
- Fakty: liczba kursów (z API), miejsca numerowane, czas rezerwacji (TTL z serwera), płatności.
- Sekcja „Od peronu do kodu”: 3 kroki, TTL z serwera.
- Link do laboratorium.

### Mapa wagonu `/events/:id`

- Powrót do rozkładu.
- Nagłówek kursu: relacja, data, odjazd, przyjazd, czas podróży, wolne miejsca.
- Przełącznik wagonów 5 i 6, z liczbą wolnych przy każdym.
- Mapa 5 × 4: wolne klikalne, zajęte wyszarzone i nieklikalne, legenda wolne/zajęte/okno/korytarz.
- Klik wolnego miejsca otwiera formularz.
- Odświeżanie: przycisk „Odśwież”, czas ostatniej aktualizacji, automatycznie po powrocie i na focus; ostrzeżenie, gdy odświeżenie się nie uda (zostaje ostatni stan).
- Stany: ładowanie, błąd z ponowieniem i powrotem do rozkładu.
- Boczne karty: wskazówka „Kliknij wolne miejsce” (z TTL), „Kasa nie padnie przez e-mail” z linkiem do laboratorium.

### Formularz `/events/:id/reserve/:seatId`

- Powrót do mapy.
- Etykieta miejsca dokładnie „Wagon 5, miejsce 12”, kurs, data, cena, TTL z serwera.
- Pola: imię i nazwisko, e-mail; zapamiętane dane podróżnego; walidacja przy polach.
- Przycisk rezerwacji ze stanem „w toku”; błąd serwera (np. zajęte miejsce, `409` przy powtórce).
- Podsumowanie kursu z boku i kroki „Co dalej?”.
- Stany: ładowanie, błąd wczytania kursu, miejsce nie istnieje, miejsce zajęte (z powrotem do mapy).

### Licznik i płatność `/reservations/:id` (oraz `…/payment/cancel`)

- Powrót do mapy.
- Licznik od `expiresAt` z serwera, pasek postępu, godzina ważności, stany: normalny, ostrzeżenie, pilny, wygasły.
- Szczegóły: podróżny, e-mail, miejsce, **do zapłaty**, identyfikator rezerwacji.
- Panel płatności: „Do zapłaty 89 zł”, przycisk „Zapłać 89 zł” ze stanem „Przechodzimy do płatności…”; po anulowaniu „Płatność przerwana”, „Zapłać ponownie 89 zł”; błędy płatności (np. Stripe niedostępny).
- Wygaśnięcie (licznik na zerze albo `409`): `RESERVATION_EXPIRED_MESSAGE`, przycisk zablokowany, cały ekran w stanie wygaśnięcia.
- Sprawdzenie statusu u serwera po wejściu: opłacona → strona powrotu, wygasła → stan wygaśnięcia.
- Bilet już kupiony → „Bilet jest już kupiony” z linkiem do biletu.
- Brak danych w tej karcie → „Ta karta nie pamięta rezerwacji” z powrotem do rozkładu.
- Telefon: przycisk „Zapłać” na pierwszym ekranie, pod licznikiem.
- Karta „Licznik to tylko podpowiedź” z linkiem do laboratorium.

### Powrót z płatności `/reservations/:id/payment/success`

- „Płatność w toku…” i sprawdzanie statusu, aż serwer potwierdzi płatność.
- Opłacona → bilet bez odświeżania.
- Opłacona, ale bez danych w tej karcie → „Płatność przyjęta” z powrotem do rozkładu.
- Wygasła przed potwierdzeniem → komunikat o automatycznym zwrocie, powrót do rozkładu.
- Błąd sprawdzania statusu → komunikat.

### Bilet `/reservations/:id/ticket`

- Relacja, data, odjazd, przyjazd, czas podróży, miejsce („Wagon 5, miejsce 12”), podróżny, e-mail, godzina wydania, **kod biletu** (duży).
- Przyciski: powrót do rozkładu, drukowanie / zapis PDF.
- Informacja o potwierdzeniu e-mail wysyłanym kolejką.
- Brak biletu w tej karcie → komunikat z linkiem do strony powrotu z płatności.

### Nie znaleziono `*`

- Komunikat „Ten peron nie istnieje” i powrót do rozkładu.

### Laboratorium `/lab`

- Odświeżanie stanu.
- Dostawca e-mail: przełączanie trybu (zdrowy, wolny, awaria, niestabilny).
- Ochrona kasy: test limitu (60 prób zakupu) z wynikiem.
- Kolejka e-maili: statystyki, ostatnie joby, ponowienie joba z DLQ.
- Skrzynka: wiadomości i czyszczenie.
- Scenariusze „Co warto kliknąć”.

## Znane problemy

Z audytu UI i przeglądu kodu. Każda poprawka idzie w kroku ekranu, którego dotyczy, i jest opisana w jego raporcie.

| # | Problem | Ekran | Stan |
| --- | --- | --- | --- |
| 1 | Poziomy scroll na telefonie | `/lab` (2.8) | poprawione (ramka tabeli jobów `relative`) |
| 2 | Za słaby kontrast obrysu fokusu na jasnym tle (żółty na jasnoszarym) | wszystkie (1) | otwarte |
| 3 | Przy ograniczeniu animacji zdanie „Jak to działa” ma 12% krycia | `/` (2.1) | poprawione w `d549b5b` |
| 4 | Sztywne „3 kursy / 120 miejsc / 40 miejsc w kursie” | `/` (2.1) | poprawione w `d549b5b`; docelowo dane z `EventListItem` |
| 5 | Karta najbliższego odjazdu wisi jako szkielet przy wyłączonym API | `/` (2.1) | poprawione w `d549b5b` |
| 6 | Błąd strony rezerwacji zostaje po przejściu na poprawny kurs | formularz (2.3) | poprawione w `d549b5b` |
| 7 | Po zakupie „Wstecz” proponuje ponowny zakup; po `409` nagłówek i licznik działają dalej | licznik (2.4) | przeniesione z `main` (raport 11, testy) |
