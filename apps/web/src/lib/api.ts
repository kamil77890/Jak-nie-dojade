import type {
  CreateReservationInput,
  CreateReservationResponse,
  EventDetailResponse,
  EventSummary,
  JobView,
  MailMessageView,
  OpsSnapshot,
  OpsStatus,
  PurchaseResponse,
} from "@pas/shared";

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "";

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly retryAfter?: number,
  ) {
    super(`${status} ${code}`);
    this.name = "ApiRequestError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiRequestError(0, "NETWORK_ERROR");
  }

  const raw = await response.text();
  let body: unknown = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const errorBody = body as { error?: string; retryAfter?: number } | null;
    const headerRetryAfter = Number(response.headers.get("retry-after"));
    const retryAfter =
      errorBody?.retryAfter ??
      (Number.isFinite(headerRetryAfter) && headerRetryAfter > 0 ? headerRetryAfter : undefined);
    throw new ApiRequestError(
      response.status,
      errorBody?.error ?? "INTERNAL_ERROR",
      retryAfter,
    );
  }

  return body as T;
}

export function getEvents(): Promise<EventSummary[]> {
  return request<EventSummary[]>("/api/events");
}

export function getEvent(eventId: string): Promise<EventDetailResponse> {
  return request<EventDetailResponse>(`/api/events/${encodeURIComponent(eventId)}`);
}

export function createReservation(
  input: CreateReservationInput,
): Promise<CreateReservationResponse> {
  return request<CreateReservationResponse>("/api/reservations", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function purchaseReservation(reservationId: string): Promise<PurchaseResponse> {
  return request<PurchaseResponse>(
    `/api/reservations/${encodeURIComponent(reservationId)}/purchase`,
    { method: "POST" },
  );
}

export function getOpsSnapshot(): Promise<OpsSnapshot> {
  return request<OpsSnapshot>("/api/ops/snapshot");
}

export function getOpsStatus(): Promise<OpsStatus> {
  return request<OpsStatus>("/api/ops/status");
}

export function getOpsJobs(): Promise<JobView[]> {
  return request<JobView[]>("/api/ops/jobs?limit=25");
}

export interface MailMessagesResponse {
  available: boolean;
  messages: MailMessageView[];
}

export function getMailMessages(): Promise<MailMessagesResponse> {
  return request<MailMessagesResponse>("/api/ops/mail/messages");
}

export interface MailModeResponse {
  mode: string;
  sent: number;
  lastModeChangeAt: string | null;
  delayMs?: number;
}

export function setMailMode(mode: string): Promise<MailModeResponse> {
  return request<MailModeResponse>("/api/ops/mail/control", {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
}

export function resetMailbox(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/api/ops/mail/reset", { method: "POST" });
}

export function retryJob(jobId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/ops/jobs/${encodeURIComponent(jobId)}/retry`, {
    method: "POST",
  });
}
