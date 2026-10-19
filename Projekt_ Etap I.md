# **Projekt PAS S01: Etap I**

## **Prośba od CEO**

Etap I to kasa biletowa bez płatności online: klient rezerwuje miejsce na 15 minut, a potem je kupuje. Każdy wariant sprowadza się do wydarzenia z ograniczoną liczbą numerowanych miejsc, a jedna rezerwacja to jedno miejsce na jednym wydarzeniu.

> 1. Klient wybiera wydarzenie i wolne miejsce.  
> 2. Rezerwuje je, podając imię i e-mail. Miejsce jest trzymane przez 15 minut i dla innych wygląda na zajęte.  
> 3. Klika „Kupuję” i dostaje kod biletu. Płatność dojdzie w kolejnym etapie.  
> 4. Jeśli nie zdąży w 15 minut, rezerwacja przepada, a miejsce wraca do puli.

## **Wspólny kontrakt API**

Kontrakt API jest ten sam dla wszystkich firm i wariantów, bo testy uderzają w każdą firmę tak samo. Warianty różnią się tylko tym, co widzi klient.

| Karta | Endpoint | Zwraca |
| :---- | :---- | :---- |
| **A. Wydarzenia i mapa** | GET /api/events | lista wydarzeń |
| **A. Wydarzenia i mapa** | GET /api/events/:id | { event, takenSeats }: miejsca kupione i z ważną rezerwacją |
| **B. Rezerwacja** | POST /api/reservations z { eventId, seatId, customerName, email } | { reservationId, expiresAt } |
| **C. Zakup** | POST /api/reservations/:id/purchase | { code } albo odmowa, gdy rezerwacja wygasła |

> * Rezerwacja jest ważna 15 minut. W trakcie testów czas ważności wynosi 2 minuty, ustawiany zmienną środowiskową.  
> * eventId i seatId to tekst, więc zmieszczą każdy format wydarzenia i miejsca.

## 

## **Kino**

Wydarzenie to seans, miejsce to fotel. Wariant pasuje bez uproszczeń.

| Karta | Co widzi klient |
| :---- | :---- |
| **A. Repertuar i sala** | lista seansów (film, data, godzina, sala) i mapa sali: ekran na górze, rzędy A–H z numerowanymi fotelami, zajęte wyszarzone |
| **B. Rezerwacja fotela** | formularz dla wybranego fotela („Rząd F, miejsce 7”) i licznik „Trzymamy Twój fotel jeszcze 14:32” |
| **C. Zakup biletu** | przycisk „Kupuję bilet”, potem bilet: film, sala, rząd i miejsce, kod. Po czasie komunikat „Rezerwacja wygasła, fotel wrócił do puli” |

> * seatId: "F7"  
> * Przykładowe dane: 3 seanse w 2 salach po 8×10 foteli.

## **Pociąg**

Wydarzenie to kurs (relacja, data, godzina odjazdu), miejsce to miejsce w wagonie. Uproszczenie: bilet zawsze na całą trasę, bez stacji pośrednich.

| Karta | Co widzi klient |
| :---- | :---- |
| **A. Rozkład i wagon** | lista kursów (relacja, odjazd, przyjazd) i mapa wagonu z przełącznikiem wagonów, miejsca przy oknie i przy korytarzu, zajęte wyszarzone |
| **B. Rezerwacja miejsca** | formularz dla wybranego miejsca („Wagon 5, miejsce 42”) i licznik czasu rezerwacji |
| **C. Zakup biletu** | przycisk „Kupuję bilet”, potem bilet: relacja, odjazd, wagon i miejsce, kod. Po czasie komunikat, że miejsce wróciło do puli |

> * seatId: "5-42"  
> * Przykładowe dane: 3 kursy, każdy z 2 wagonami po 20 miejsc.

## 

## **Hotel**

Wydarzenie to noc w hotelu, miejsce to pokój. Uproszczenie: jedna rezerwacja to jedna noc.

| Karta | Co widzi klient |
| :---- | :---- |
| **A. Terminy i pokoje** | lista najbliższych nocy i plan pięter z pokojami (numer, typ: 1-osobowy albo 2-osobowy), zajęte wyszarzone |
| **B. Rezerwacja pokoju** | formularz dla wybranego pokoju („Pokój 204, noc 21/22 listopada”) i licznik czasu rezerwacji |
| **C. Potwierdzenie pobytu** | przycisk „Potwierdzam pobyt”, potem potwierdzenie z numerem pokoju, datą i kodem. Po czasie komunikat, że pokój wrócił do puli |

> * seatId: "204"  
> * Przykładowe dane: 7 najbliższych nocy, 2 piętra po 6 pokoi.

## **Koncerty**

Wydarzenie to koncert (wykonawca, data, obiekt), miejsce to numerowane miejsce w sektorze. Uproszczenie: tylko miejsca numerowane, bez płyty.

| Karta | Co widzi klient |
| :---- | :---- |
| **A. Koncerty i sektory** | lista koncertów i mapa: scena oraz sektory z numerowanymi miejscami, zajęte wyszarzone |
| **B. Rezerwacja miejsca** | formularz dla wybranego miejsca („Sektor B, rząd 3, miejsce 12”) i licznik czasu rezerwacji |
| **C. Zakup biletu** | przycisk „Kupuję bilet”, potem bilet: wykonawca, data, sektor, rząd i miejsce, kod. Po czasie komunikat, że miejsce wróciło do puli |

> * seatId: "B-3-12"  
> * Przykładowe dane: 3 koncerty, 2 sektory po 5 rzędów × 8 miejsc.

## 

## **Jak łączą się karty**

W każdym wariancie karty łączą się tak samo, więc każdy zaczyna od zaślepek i nikt nie czeka na nikogo.

> 1. Karta A: kliknięcie wolnego miejsca na mapie prowadzi do formularza z karty B.  
> 2. Karta B: po rezerwacji klient widzi ekran z licznikiem czasu.  
> 3. Karta C: na tym ekranie dokłada przycisk zakupu i ekran biletu z kodem.

Lider ustala w kontrakcie wewnętrznym model danych, adresy stron i dane przekazywane między ekranami. Z listy zagrożeń dokłada własne karty.