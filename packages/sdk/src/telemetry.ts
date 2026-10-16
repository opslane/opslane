import { deriveSelector } from './selector';

// Wire-compatible mirror: shared/src/types.ts exports SessionTelemetryEvent.
// Keep both unions in sync; the browser SDK intentionally does not depend on shared.
export type TelemetryEvent =
  | { kind: 'click'; clickId: string; selector: string; cursor: string; at: number }
  | { kind: 'request_start'; requestId: string; clickId: string | null; method: string; url: string; at: number }
  | { kind: 'request_end'; requestId: string; status: number; at: number }
  | { kind: 'form_submit'; selector: string; at: number };

type Sink = (event: TelemetryEvent) => void;

let sink: Sink | null = null;
let installed = false;
let counter = 0;
let activeClickId: string | null = null;

export function setTelemetrySink(next: Sink | null): void {
  sink = next;
}

export function emitTelemetry(event: TelemetryEvent): void {
  try {
    sink?.(event);
  } catch {
    // SDK must never throw.
  }
}

function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}`;
}

export function nextRequestId(prefix: 'f' | 'x' | 'm' = 'm'): string {
  return nextId(prefix);
}

export function currentClickId(): string | null {
  return activeClickId;
}

function onClick(event: Event): void {
  try {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const clickId = nextId('c');
    activeClickId = clickId;
    let cursor = '';
    try {
      cursor = getComputedStyle(target).cursor || '';
    } catch {
      // Detached nodes may reject style lookup.
    }
    emitTelemetry({ kind: 'click', clickId, selector: deriveSelector(target), cursor, at: Date.now() });
    queueMicrotask(() => {
      setTimeout(() => {
        if (activeClickId === clickId) activeClickId = null;
      }, 0);
    });
  } catch {
    // SDK must never throw.
  }
}

function onSubmit(event: Event): void {
  try {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    emitTelemetry({ kind: 'form_submit', selector: deriveSelector(target), at: Date.now() });
  } catch {
    // SDK must never throw.
  }
}

export function installInteractionTelemetry(): void {
  if (installed || typeof document === 'undefined') return;
  document.addEventListener('click', onClick, true);
  document.addEventListener('submit', onSubmit, true);
  installed = true;
}

export function uninstallInteractionTelemetry(): void {
  if (typeof document === 'undefined') return;
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('submit', onSubmit, true);
  installed = false;
  activeClickId = null;
}
