# Nowy wygląd — zasady

Zasady dla każdej zmiany w nowym wyglądzie `apps/web`. Kolejność prac jest w [`ROADMAP.md`](./ROADMAP.md).

## Zasady główne

Te cztery zasady są nadrzędne. Wszystko niżej tylko je uzupełnia.

### 1. Zrzut przed, zrzut po, raport HTML

Każda zmiana ekranu przechodzi przez tę samą procedurę:

1. **Przed zmianą** — zrzut ekranu.
2. Zmiana.
3. **Po zmianie** — zrzut ekranu w tych samych warunkach.
4. **Graficzne zaznaczenie zmian** na zrzucie „po”: numerowane ramki wokół każdego zmienionego miejsca.
5. **Raport HTML** dla autora projektu: zrzuty przed i po obok siebie, ramki z numerami, a pod spodem lista zmian z tymi samymi numerami. Każda pozycja mówi, co się zmieniło i czy możliwości ekranu zostały takie same.

Szczegóły procedury są w sekcji [Zrzuty i raport](#zrzuty-i-raport).

### 2. Nie zmieniamy funkcjonalności, logiki ani backendu

Nowy wygląd to wyłącznie nowa warstwa wizualna: markup, klasy, style, animacje, teksty pomocnicze.

**Kategorycznie nie zmieniamy:**
- `apps/api`, `apps/mock-mail`, `packages/shared` (backend, kontrakt, model danych),
- `apps/web/src/lib/api.ts`, `session.ts`, `errors.ts` i hooków — sposobu pobierania, zapisu i obsługi danych,
- przepływu między ekranami (adresy, przekazywane dane, przekierowania),
- reakcji na odpowiedzi serwera (`409`, wygaśnięcie, opłacona rezerwacja, płatność),
- tekstów wymaganych przez karty (np. „Wagon 5, miejsce 12”, komunikat wygaśnięcia, „Zapłać 89 zł”).

**Jeśli zmiana logiki jest naprawdę niezbędna, najpierw pytam autora projektu o zgodę.** Pytanie zawiera: co, dlaczego bez tego się nie da, jakie ma skutki. Bez zgody nie zmieniam.

### 3. Te same możliwości na każdym ekranie

Po zmianach każdy ekran ma **dokładnie te same możliwości** co na `main`: te same akcje, te same informacje, te same stany (ładowanie, pusto, błąd, wygaśnięcie, sukces). Listą kontrolną jest [inwentarz możliwości w `ROADMAP.md`](./ROADMAP.md#inwentarz-możliwości-ekranów). Każdy raport HTML odhacza możliwości zmienianego ekranu.

### 4. Przeniesienie czegokolwiek — tylko po konsultacji

Przeniesienie elementu, akcji albo informacji w inne miejsce ekranu lub na inny ekran wymaga **wcześniejszej konsultacji z autorem projektu**. Dotyczy to też połączenia dwóch elementów w jeden i usunięcia czegoś, co ma inną drogę dostępu.

## Zrzuty i raport

- **Warunki zrzutu są takie same przed i po:** ten sam adres, ten sam stan danych (np. ta sama rezerwacja, te same zajęte miejsca), ten sam motyw.
- **Zawsze trzy rozmiary okna**, każdy zrzut w każdym z nich:

  | Urządzenie | Rozmiar okna |
  | --- | --- |
  | laptop | 1440 × 900 |
  | tablet | 820 × 1180 |
  | telefon | 390 × 844 |

- **Stan „przed”** pochodzi z gałęzi `main` albo z ostatniego zaakceptowanego stanu `feat/new-look`.
- **Ekrany z kilkoma stanami** (licznik, płatność, wygaśnięcie, błąd) — zrzut każdego stanu, którego dotyczy zmiana.
- **Zaznaczenie:** ramka wokół zmienionego obszaru i numer, który odpowiada pozycji na liście zmian.
- **Raport HTML:** jeden na krok, w `../Jak-nie-dojade-raporty/<nr>-<ekran>/index.html` (obok repo, poza gitem), razem ze zrzutami. Zrzuty i raporty nie trafiają do repozytorium. Zawiera:
  - zrzuty przed i po obok siebie, osobno dla laptopa, tabletu i telefonu,
  - listę zmian z numerami,
  - listę możliwości ekranu z inwentarza, każdą oznaczoną jako „bez zmian” albo opisaną,
  - pytania do autora projektu, jeśli coś wymaga zgody (zasady 2 i 4).
- Po raporcie czekam na akceptację, zanim przejdę do następnego ekranu.

## Zasady pomocnicze

### Wygląd

- Kolory tylko przez tokeny z `styles.css` (`bg-bg`, `text-ink`, `border-line`…), w obu motywach: jasnym i ciemnym.
- Typografia: Archivo Variable; godziny i duże liczby `narrow`, nagłówki `condensed`.
- Bez animacji treść ma być kompletna (`prefers-reduced-motion`). GSAP tylko przez `useGsap`.
- Fokus widoczny w obu motywach (kontrast obrysu ≥ 3:1), wszystko obsługiwalne z klawiatury.
- Laptop, tablet i telefon bez poziomego przewijania; na telefonie przycisk „Zapłać” na pierwszym ekranie, pod licznikiem.

### Testy

- Testy UI i E2E z `main` muszą przechodzić. **Przy zmianie wyglądu zmieniam selektory, nie asercje.**
- Przed każdym commitem: `pnpm test`, `pnpm typecheck`, `pnpm build`.

### Git i praca równoległa

- Nazwy gałęzi i opisy commitów po angielsku; treść dokumentów po polsku.
- Prace trwają na `feat/new-look`. **Nowy wygląd nie trafia do `main` ani do PR do `main` bez akceptacji autora projektu.**
- Jedna sesja na obszar. Nie ruszam cudzych dev serwerów ani przeglądarki DevTools używanej przez inną sesję.
- Bez force-pusha na wspólne gałęzie. Klucze Stripe tylko w `.env`, nigdy na zrzutach ani w raportach.
