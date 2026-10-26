import { useEffect, useState } from "react";

export function useCountdown(expiresAt: string): { remainingMs: number; expired: boolean } {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [expiresAt]);

  const target = new Date(expiresAt).getTime();
  const remainingMs = Number.isFinite(target) ? Math.max(0, target - now) : 0;
  return { remainingMs, expired: remainingMs <= 0 };
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · PAS` : "PAS · Kasa biletowa";
  }, [title]);
}
