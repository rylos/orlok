import type { ApiError } from "@orlok/shared";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.message);
    this.name = "ApiRequestError";
  }
}

function isApiError(value: unknown): value is ApiError {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { code?: unknown; message?: unknown };
  return typeof candidate.code === "string" && typeof candidate.message === "string";
}

// Told when the server no longer knows the session: the person was disabled, signed out from
// another device, or the session expired. The app then goes back to sign-in instead of letting
// every action fail on a page that still looks signed in.
let sessionEnded: (() => void) | null = null;
export function onSessionEnded(listener: () => void) {
  sessionEnded = listener;
}

async function errorFrom(res: Response) {
  const data: unknown = await res.json().catch(() => null);
  const error = new ApiRequestError(
    res.status,
    isApiError(data) ? data : { code: "internal_error", message: "Unexpected server response" },
  );
  if (error.status === 401 && error.body.code === "unauthenticated") {
    sessionEnded?.();
  }
  return error;
}

export async function apiFetch<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const hasBody = options.body !== undefined;
  const res = await fetch(`/api${path}`, {
    method,
    // Also on body-less POST/DELETE: the CSRF check treats requests without a Content-Type as
    // form posts and rejects them when the browser sends no Origin (plain http on a LAN address).
    headers: hasBody || method !== "GET" ? { "Content-Type": "application/json" } : undefined,
    body: hasBody ? JSON.stringify(options.body) : undefined,
    credentials: "same-origin",
  });

  if (!res.ok) {
    throw await errorFrom(res);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

// POSTs files as multipart form data.
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    body: form,
    credentials: "same-origin",
  });
  if (!res.ok) {
    throw await errorFrom(res);
  }
  return (await res.json()) as T;
}

// POSTs a JSON body and calls onEvent for every server-sent event (one JSON object per event).
export async function streamApi<T>(
  path: string,
  body: unknown,
  onEvent: (event: T) => void,
  signal?: AbortSignal,
) {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    credentials: "same-origin",
    signal,
  });
  await readEvents(res, onEvent);
}

// Follows an event stream that is already running on the server (R-CHAT-13). A 204 means there
// is nothing to follow any more.
export async function followApi<T>(
  path: string,
  onEvent: (event: T) => void,
  signal?: AbortSignal,
) {
  const res = await fetch(`/api${path}`, {
    headers: { Accept: "text/event-stream" },
    credentials: "same-origin",
    signal,
  });
  if (res.status === 204) {
    return;
  }
  await readEvents(res, onEvent);
}

async function readEvents<T>(res: Response, onEvent: (event: T) => void) {
  if (!res.ok || !res.body) {
    throw await errorFrom(res);
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += value;
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) {
          onEvent(JSON.parse(line.slice(5).trim()) as T);
        }
      }
    }
  }
}
