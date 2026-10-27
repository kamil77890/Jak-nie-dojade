const MONTHS_PL = [
  "stycznia",
  "lutego",
  "marca",
  "kwietnia",
  "maja",
  "czerwca",
  "lipca",
  "sierpnia",
  "września",
  "października",
  "listopada",
  "grudnia",
] as const;

export function parseSeatId(seatId: string): { wagonNumber: number; seatNumber: number } | null {
  const match = /^(\d+)-(\d+)$/.exec(seatId);
  if (!match) return null;
  const wagonNumber = Number(match[1]);
  const seatNumber = Number(match[2]);
  if (!Number.isInteger(wagonNumber) || !Number.isInteger(seatNumber)) return null;
  return { wagonNumber, seatNumber };
}

/** "5-12" → "Wagon 5, miejsce 12" — jedna etykieta dla A, B, C i e-maila. */
export function formatSeatLabel(seatId: string): string {
  const parsed = parseSeatId(seatId);
  if (!parsed) return seatId;
  return `Wagon ${parsed.wagonNumber}, miejsce ${parsed.seatNumber}`;
}

export function formatEventDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const monthName = MONTHS_PL[month - 1];
  if (!monthName) return isoDate;

  return `${day} ${monthName} ${year}`;
}

export function formatEventDateShort(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  return `${match[3]}.${match[2]}.${match[1]}`;
}

export function formatDuration(departureTime: string, arrivalTime: string): string {
  const start = toMinutes(departureTime);
  const end = toMinutes(arrivalTime);
  if (start === null || end === null) return "";
  const duration = end >= start ? end - start : end + 24 * 60 - start;
  const hours = Math.floor(duration / 60);
  const minutes = duration % 60;
  return minutes === 0 ? `${hours} godz.` : `${hours} godz. ${minutes} min`;
}

function toMinutes(time: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatTimeLeft(totalMinutes: number): string {
  const total = Math.max(0, Math.round(totalMinutes));
  const minutes = total % 60;
  const hours = Math.floor(total / 60);
  if (hours === 0) return `${minutes} min`;
  if (minutes === 0) return `${hours} godz.`;
  return `${hours} godz. ${minutes} min`;
}

/** 8900 → "89 zł", 8950 → "89,50 zł". Kwoty w API są w groszach. */
export function formatPrice(amount: number): string {
  const zloty = amount / 100;
  const whole = Number.isInteger(zloty);
  const text = new Intl.NumberFormat("pl-PL", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
    useGrouping: true,
  }).format(zloty);
  return `${text} zł`;
}
