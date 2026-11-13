'use client';

import { useEffect, useRef, useState } from 'react';
import { forceLogin, getToken } from './auth';
import { getConfig } from './config';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The service is not running or not reachable (as opposed to refusing the request). */
  get isUnavailable(): boolean {
    return this.status === 0 || this.status === 502 || this.status === 503 || this.status === 504;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
}

/** Calls the API gateway with the signed-in user's token. Every screen gets its data through here. */
export async function api<T = any>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<T> {
  const token = await getToken();
  let response: Response;
  try {
    response = await fetch(`${getConfig().gatewayUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'The API gateway could not be reached.');
  }
  if (response.status === 401) {
    forceLogin();
    throw new ApiError(401, 'unauthenticated', 'Your session has ended. Signing in again…');
  }
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const e = parsed?.error ?? {};
    throw new ApiError(response.status, e.code ?? 'error', e.message ?? `Request failed (${response.status})`, e.details, e.correlation_id);
  }
  return parsed as T;
}

/** Downloads a file through the gateway (attachments, exports). */
export async function download(path: string, fallbackName: string): Promise<void> {
  const token = await getToken();
  const response = await fetch(`${getConfig().gatewayUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new ApiError(response.status, 'download_failed', `Download failed (${response.status})`);
  const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export interface LiveEvent {
  type: string;
  aggregate_id: string;
  occurred_at: string;
  payload: any;
}

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'unavailable';

/**
 * Subscribes to the gateway's Server-Sent Events stream. `fetch` is used
 * instead of EventSource so the token travels in a header, not in the URL.
 */
export function useEventStream(onEvent: (event: LiveEvent) => void, enabled = true): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let stopped = false;

    async function connect(): Promise<void> {
      let attempt = 0;
      while (!stopped) {
        try {
          const token = await getToken();
          const response = await fetch(`${getConfig().gatewayUrl}/api/stream/events`, {
            headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
            signal: controller.signal,
          });
          if (response.status === 403) {
            setStatus('unavailable');
            return;
          }
          if (!response.ok || !response.body) throw new Error(`stream responded ${response.status}`);
          setStatus('live');
          attempt = 0;
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value;
            let end: number;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const data = frame.split('\n').find((l) => l.startsWith('data: '));
              const name = frame.split('\n').find((l) => l.startsWith('event: '))?.slice(7);
              if (!data || name === 'ready') continue;
              try {
                handler.current(JSON.parse(data.slice(6)));
              } catch {
                // ignore a malformed frame
              }
            }
          }
        } catch {
          if (stopped) return;
        }
        if (stopped) return;
        setStatus('reconnecting');
        attempt += 1;
        await new Promise((r) => setTimeout(r, Math.min(15_000, 1_000 * 2 ** Math.min(attempt, 4))));
      }
    }

    void connect();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [enabled]);

  return status;
}
