/**
 * Tiny Server-Sent Events helpers for node:http.
 * Teaching stub — not a production gateway stream stack.
 */

export interface SseEvent {
  data: string;
  event?: string;
  id?: string;
}

/** Encode one SSE frame: optional event/id + data lines + blank line terminator. */
export function formatSseEvent(evt: SseEvent): string {
  const lines: string[] = [];
  if (evt.event) lines.push(`event: ${evt.event}`);
  if (evt.id) lines.push(`id: ${evt.id}`);
  // Split multi-line data per SSE spec (one "data:" prefix per line).
  const dataLines = evt.data.split('\n');
  for (const line of dataLines) {
    lines.push(`data: ${line}`);
  }
  lines.push('');
  return lines.join('\n') + '\n';
}

/** Split text into small token-ish chunks for mock streaming demos. */
export function chunkText(text: string, chunkSize = 12): string[] {
  if (!text) return [];
  const size = Math.max(1, chunkSize);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out;
}
