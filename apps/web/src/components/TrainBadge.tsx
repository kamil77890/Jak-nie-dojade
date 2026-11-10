import { trainCategory, trainLabel } from "../lib/format";

/** Numer pociągu w kolorze jego kategorii (IC, TLK, EIP). */
export function TrainBadge({ eventId, className = "" }: { eventId: string; className?: string }) {
  return (
    <span className={`train-badge ${className}`} data-category={trainCategory(eventId) ?? undefined}>
      {trainLabel(eventId)}
    </span>
  );
}
