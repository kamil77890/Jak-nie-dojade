export type SeatPosition = "window" | "aisle";

export interface Seat {
  /** Pełny identyfikator miejsca, np. "5-12". */
  id: string;
  /** Numer miejsca w wagonie, 1–20. */
  number: number;
  position: SeatPosition;
}

export interface Wagon {
  /** Identyfikator wagonu, np. "5". */
  id: string;
  number: number;
  seats: Seat[];
}

export interface Event {
  /** Identyfikator kursu, np. "ic-7310-2026-11-21". */
  id: string;
  /** Relacja, np. "Warszawa Wschodnia → Kraków Główny". */
  relation: string;
  /** Data odjazdu w formacie YYYY-MM-DD. */
  date: string;
  /** Godzina odjazdu w formacie HH:MM. */
  departureTime: string;
  /** Godzina przyjazdu w formacie HH:MM. */
  arrivalTime: string;
  wagons: Wagon[];
}

export type EventSummary = Omit<Event, "wagons">;

export type ReservationStatus = "active" | "purchased" | "expired";

export interface Reservation {
  id: string;
  eventId: string;
  seatId: string;
  customerName: string;
  email: string;
  /** ISO 8601, UTC. */
  createdAt: string;
  /** ISO 8601, UTC. */
  expiresAt: string;
  status: ReservationStatus;
  code?: string;
}

export interface CreateReservationInput {
  eventId: string;
  seatId: string;
  customerName: string;
  email: string;
}

export interface CreateReservationResponse {
  reservationId: string;
  expiresAt: string;
}

export interface PurchaseResponse {
  code: string;
}

/** Jeden obiekt przekazywany między ekranem B i C. */
export interface ReservationView {
  reservationId: string;
  expiresAt: string;
  event: EventSummary;
  seatId: string;
  customerName: string;
  email: string;
}

export interface EventDetailResponse {
  event: Event;
  takenSeats: string[];
}

export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "EVENT_NOT_FOUND"
  | "EVENT_OR_SEAT_NOT_FOUND"
  | "SEAT_UNAVAILABLE"
  | "RESERVATION_NOT_FOUND"
  | "RESERVATION_EXPIRED"
  | "RATE_LIMITED"
  | "OVERLOADED"
  | "BUSY"
  | "MAIL_UNAVAILABLE"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

export interface ApiError {
  error: ApiErrorCode | string;
  retryAfter?: number;
}

export interface Ticket {
  code: string;
  reservationId: string;
  event: EventSummary;
  seatId: string;
  customerName: string;
  email: string;
  issuedAt: string;
}

export type JobState = "ready" | "retry" | "done" | "dlq";

export interface JobView {
  id: string;
  task: string;
  input: unknown;
  createdAt: string;
  visibleAt: string;
  totalTried: number;
  completedAt: string | null;
  hasError: boolean;
  lastError: string | null;
  state: JobState;
}

export interface QueueStats {
  ready: number;
  retry: number;
  done: number;
  dlq: number;
  total: number;
}

export interface BreakerSnapshot {
  state: "closed" | "open" | "half_open";
  failures: number;
  openedAt: number | null;
  lastError: string | null;
}

export interface OpsStatus {
  now: string;
  uptimeSeconds: number;
  config: {
    ttlMinutes: number;
    ttlSeconds: number;
    mailTimeoutMs: number;
    mailRetryAttempts: number;
    workerMaxAttempts: number;
    loadShedMaxInFlight: number;
    readBulkheadConcurrency: number;
    writeBulkheadConcurrency: number;
  };
  reservations: {
    active: number;
    purchased: number;
    expired: number;
    total: number;
  };
  queue: QueueStats;
  worker: {
    enabled: boolean;
    lastRunAt: string | null;
    processed: number;
    failed: number;
    dlq: number;
    lastError: string | null;
  };
  breaker: BreakerSnapshot;
  guards: {
    inFlight: number;
    maxInFlight: number;
    loadShedRejected: number;
    rateLimited: number;
    readPool: PoolSnapshot;
    writePool: PoolSnapshot;
  };
  mail: {
    available: boolean;
    mode: string;
    sent: number;
    lastModeChangeAt: string | null;
  };
}

export interface PoolSnapshot {
  active: number;
  queued: number;
  concurrency: number;
  rejected: number;
}

export interface MailMessageView {
  id: string;
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
  reservationId?: string;
  sentAt: string;
}

export interface OpsSnapshot {
  status: OpsStatus;
  jobs: JobView[];
  mail: {
    available: boolean;
    messages: MailMessageView[];
  };
}
