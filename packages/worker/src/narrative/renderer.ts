import type { SessionChunkEnvelope } from '@opslane/shared';

export interface TimelineLine {
  text: string;
  selector: string | null;
  route: string;
  atMs: number | null;
  kind?: 'idle';
  /** For a request line: when the request went out. A stretch the user spent waiting on it is not idle time. */
  waitingSince?: number;
}

/** No user interaction for longer than this is the user being away, not the
 * app being slow. */
export const IDLE_THRESHOLD_MS = 60_000;

export interface RenderedTimeline {
  lines: TimelineLine[];
  text: string;
  truncated: boolean;
  startTs: number;
}

export interface RenderOptions {
  maxInputEvents?: number;
  maxNodes?: number;
  maxMutations?: number;
  maxLines?: number;
  maxBytes?: number;
}

const DEFAULTS: Required<RenderOptions> = {
  maxInputEvents: 200_000,
  maxNodes: 60_000,
  maxMutations: 150_000,
  maxLines: 700,
  maxBytes: 65_536,
};
const FEEDBACK_RE = /error|fail|invalid|required|success|saved|created|deleted|sorry|try again|warning|cannot|unable|no .*found|not found|match/i;
const NOISE_URL_RE = /rum\?|launchnotes|cloudfront|sentry|posthog|intercom|\/api\/v1\/events|\/api\/v1\/sessions/i;

const sanitize = (value: string): string => value
  .replace(/[\u0000-\u001f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
  .slice(0, 200);

interface MirrorNode {
  tag: string;
  attrs: Record<string, string>;
  parentId: number | null;
  childIds: number[];
  text: string;
}

export function renderTimeline(
  envelopes: SessionChunkEnvelope[],
  opts: RenderOptions = {},
): RenderedTimeline {
  const options = { ...DEFAULTS, ...opts };
  let truncated = false;
  let events = envelopes.flatMap((envelope) => envelope.events as Array<Record<string, unknown>>);
  if (events.length > options.maxInputEvents) {
    events = events.slice(0, options.maxInputEvents);
    truncated = true;
  }
  // A non-numeric outer timestamp would make the sort comparator return NaN
  // and the order implementation-defined; such an event cannot be placed, so
  // it is dropped rather than allowed to poison startTs and every relative stamp.
  events = events.filter((event) => Number.isFinite(Number(event['timestamp'])));
  events.sort((a, b) => Number(a['timestamp']) - Number(b['timestamp']));
  const startTs = Number(events[0]?.['timestamp'] ?? 0);
  const endTs = Number(events[events.length - 1]?.['timestamp'] ?? startTs);
  const relative = (timestamp: number): string => `t+${((timestamp - startTs) / 1_000).toFixed(1)}s`;

  const nodes = new Map<number, MirrorNode>();
  let mutationBudget = options.maxMutations;
  const addNode = (node: Record<string, unknown>, parentId: number | null): void => {
    if (nodes.size >= options.maxNodes) {
      truncated = true;
      return;
    }
    const id = node['id'];
    if (typeof id !== 'number') return;
    const children = Array.isArray(node['childNodes'])
      ? node['childNodes'].filter((child): child is Record<string, unknown> => typeof child === 'object' && child !== null)
      : [];
    nodes.set(id, {
      tag: typeof node['tagName'] === 'string' ? node['tagName'] : node['type'] === 3 ? '#text' : '#node',
      attrs: typeof node['attributes'] === 'object' && node['attributes'] !== null
        ? node['attributes'] as Record<string, string>
        : {},
      parentId,
      childIds: children.flatMap((child) => typeof child['id'] === 'number' ? [child['id']] : []),
      text: node['type'] === 3 && typeof node['textContent'] === 'string' ? node['textContent'] : '',
    });
    for (const child of children) addNode(child, id);
  };
  const collectText = (id: number, depth = 0, budget = { count: 0 }): string[] => {
    if (depth > 4 || budget.count > 6) return [];
    const node = nodes.get(id);
    if (!node) return [];
    if (node.tag === '#text' && node.text.trim()) {
      budget.count += 1;
      return [node.text.trim()];
    }
    return node.childIds.flatMap((childId) => collectText(childId, depth + 1, budget));
  };
  const label = (id: number): string => {
    const node = nodes.get(id);
    if (!node) return `#${id}`;
    const text = collectText(id).join(' ').replace(/\s+/g, ' ').slice(0, 80);
    const aria = node.attrs['aria-label'] ?? node.attrs['placeholder'] ?? node.attrs['title'] ?? '';
    const classes = (node.attrs['class'] ?? '').split(/\s+/).slice(0, 2).join('.');
    const base = `${node.tag.toLowerCase()}${node.attrs['id'] ? `#${node.attrs['id']}` : classes ? `.${classes}` : ''}`;
    const visibleLabel = text || aria;
    return visibleLabel ? `${base} "${sanitize(visibleLabel)}"` : base;
  };

  const lines: TimelineLine[] = [];
  let route = '';
  const push = (text: string, selector: string | null, atMs: number | null, extra: Pick<TimelineLine, 'waitingSince'> = {}): void => {
    lines.push({ text: sanitize(text), selector, route, atMs, ...extra });
  };
  let lastUrl = '';
  const openRequests = new Map<string, { method: string; url: string; at: number }>();
  const inputCounts = new Map<number, { count: number; first: number }>();
  const userActivityMs: number[] = [];
  // A malformed or foreign chunk can carry a non-numeric timestamp; NaN would
  // slip past the gap-size comparison and fabricate an idle marker.
  const recordActivity = (ts: number): void => {
    if (Number.isFinite(ts)) userActivityMs.push(ts);
  };
  let scrollCount = 0;
  let lastScrollFlush = 0;
  const flushInputs = (): void => {
    for (const [id, aggregate] of inputCounts) {
      if (aggregate.count >= 2) {
        push(`${relative(aggregate.first)} typed in ${label(id)} (${aggregate.count} keystrokes)`, null, aggregate.first);
      }
    }
    inputCounts.clear();
  };
  const shortUrl = (url: string): string => url.replace(/^https?:\/\/[^/]+/, '').slice(0, 100);

  for (const event of events) {
    const type = Number(event['type']);
    const timestamp = Number(event['timestamp']);
    const data = typeof event['data'] === 'object' && event['data'] !== null
      ? event['data'] as Record<string, unknown>
      : undefined;
    if (type === 2) {
      nodes.clear();
      const root = data?.['node'];
      if (typeof root === 'object' && root !== null) addNode(root as Record<string, unknown>, null);
      continue;
    }
    if (type === 4) {
      const href = typeof data?.['href'] === 'string' ? data['href'] : '';
      const path = href.replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '');
      if (path && path !== lastUrl) {
        flushInputs();
        route = path;
        push(`${relative(timestamp)} PAGE ${path}`, null, timestamp);
        lastUrl = path;
      }
      continue;
    }
    if (type === 5 && data?.['tag'] === 'opslane.telemetry') {
      const payload = data['payload'];
      if (typeof payload !== 'object' || payload === null) continue;
      const item = payload as Record<string, unknown>;
      const kind = item['kind'];
      const at = Number(item['at']);
      if (kind === 'click') {
        recordActivity(at);
        flushInputs();
        const selector = typeof item['selector'] === 'string' ? item['selector'] : '';
        push(`${relative(at)} CLICK ${selector}${item['cursor'] ? ` [cursor:${String(item['cursor'])}]` : ''}`, selector, at);
      } else if (kind === 'request_start') {
        const url = typeof item['url'] === 'string' ? item['url'] : '';
        const requestId = typeof item['requestId'] === 'string' ? item['requestId'] : '';
        if (requestId && !NOISE_URL_RE.test(url)) {
          openRequests.set(requestId, { method: String(item['method'] ?? ''), url, at });
        }
      } else if (kind === 'request_end') {
        const requestId = typeof item['requestId'] === 'string' ? item['requestId'] : '';
        const request = openRequests.get(requestId);
        if (request) {
          openRequests.delete(requestId);
          const status = Number(item['status']);
          const slow = at - request.at > 1_000 ? ` SLOW ${((at - request.at) / 1_000).toFixed(1)}s` : '';
          if (request.method !== 'GET' || status >= 400 || slow) {
            push(`${relative(at)} ${request.method} ${shortUrl(request.url)} -> ${status}${slow}`, null, at, { waitingSince: request.at });
          }
        }
      } else if (kind === 'form_submit') {
        recordActivity(at);
        flushInputs();
        const selector = typeof item['selector'] === 'string' ? item['selector'] : '';
        push(`${relative(at)} FORM SUBMIT ${selector}`, selector, at);
      }
      continue;
    }
    if (type !== 3 || !data) continue;
    const source = Number(data['source']);
    if (source === 0) {
      if (mutationBudget-- <= 0) {
        truncated = true;
        continue;
      }
      const removes = Array.isArray(data['removes']) ? data['removes'] as Array<Record<string, unknown>> : [];
      for (const removed of removes) {
        const id = Number(removed['id']);
        const node = nodes.get(id);
        if (node?.parentId != null) {
          const parent = nodes.get(node.parentId);
          if (parent) parent.childIds = parent.childIds.filter((childId) => childId !== id);
        }
        nodes.delete(id);
      }
      const appeared: string[] = [];
      const adds = Array.isArray(data['adds']) ? data['adds'] as Array<Record<string, unknown>> : [];
      for (const addition of adds) {
        const added = addition['node'];
        if (typeof added !== 'object' || added === null) continue;
        const node = added as Record<string, unknown>;
        const parentId = Number(addition['parentId']);
        addNode(node, parentId);
        const parent = nodes.get(parentId);
        const nodeId = Number(node['id']);
        if (parent && !parent.childIds.includes(nodeId)) parent.childIds.push(nodeId);
        if (node['type'] === 3 && typeof node['textContent'] === 'string' && node['textContent'].trim()) {
          appeared.push(node['textContent'].trim());
        }
      }
      const texts = Array.isArray(data['texts']) ? data['texts'] as Array<Record<string, unknown>> : [];
      for (const changed of texts) {
        const id = Number(changed['id']);
        const value = typeof changed['value'] === 'string' ? changed['value'] : '';
        const node = nodes.get(id);
        if (node) node.text = value;
        if (value.trim()) appeared.push(value.trim());
      }
      const attributes = Array.isArray(data['attributes']) ? data['attributes'] as Array<Record<string, unknown>> : [];
      for (const changed of attributes) {
        const node = nodes.get(Number(changed['id']));
        if (node && typeof changed['attributes'] === 'object' && changed['attributes'] !== null) {
          Object.assign(node.attrs, changed['attributes']);
        }
      }
      const significant = appeared.join(' ').replace(/\s+/g, ' ').trim();
      if (significant && FEEDBACK_RE.test(significant)) {
        push(`${relative(timestamp)} UI TEXT APPEARED: "${sanitize(significant).slice(0, 160)}"`, null, timestamp);
      }
    } else if (source === 2 && data['type'] === 2 && typeof data['id'] === 'number') {
      recordActivity(timestamp);
      push(`${relative(timestamp)}   -> target: ${label(data['id'])}`, null, timestamp);
    } else if (source === 5 && typeof data['id'] === 'number') {
      recordActivity(timestamp);
      const aggregate = inputCounts.get(data['id']) ?? { count: 0, first: timestamp };
      aggregate.count += 1;
      inputCounts.set(data['id'], aggregate);
    } else if (source === 3) {
      recordActivity(timestamp);
      scrollCount += 1;
      if (timestamp - lastScrollFlush > 5_000 && scrollCount > 3) {
        push(`${relative(timestamp)} (scrolling, ${scrollCount} scroll events)`, null, timestamp);
        scrollCount = 0;
        lastScrollFlush = timestamp;
      }
    }
  }
  flushInputs();

  // A line's own stamp comes from the SDK payload, which the client controls.
  // Only a finite stamp inside the session's event window may reorder lines
  // or measure a silence; anything else keeps its slot and is inert. The
  // slack covers a payload stamped a moment after its carrying event.
  const PLAUSIBLE_SLACK_MS = 5_000;
  const plausibleAt = (line: TimelineLine): line is TimelineLine & { atMs: number } =>
    line.atMs !== null && Number.isFinite(line.atMs)
    && line.atMs >= startTs - PLAUSIBLE_SLACK_MS && line.atMs <= endTs + PLAUSIBLE_SLACK_MS;

  // Lines are pushed in event order except typed-input aggregates, which are
  // flushed later with their first timestamp. Order plausible stamps by time;
  // every other line keeps its slot. The comparator only ever compares two
  // finite numbers, so it stays transitive.
  const chronological = (batch: TimelineLine[]): TimelineLine[] => {
    const entries = batch.map((line, index) => ({ line, index })).filter((entry) => plausibleAt(entry.line));
    const sorted = [...entries].sort((a, b) => (a.line.atMs! - b.line.atMs!) || (a.index - b.index));
    const out = [...batch];
    entries.forEach((entry, position) => { out[entry.index] = sorted[position]!.line; });
    return out;
  };

  // A silence starts at a user action. Inside it, every rendered line that
  // lands more than the threshold after the previous line or action gets a
  // marker for that quiet stretch, whatever kind of line it is: a page that
  // refreshes itself half an hour after the last click is still a user who
  // walked away. Two exceptions keep the marker honest. A response to a
  // request that was already in flight when the stretch began is time the
  // user spent waiting, not away, so it gets no marker and counts as attended.
  // And the action that ends a silence still gets a marker for the whole
  // unattended span when nothing inside it earned one, so frequent background
  // updates cannot hide a long absence.
  const withIdleMarkers = (batch: TimelineLine[]): TimelineLine[] => {
    const activity = [...new Set(userActivityMs)]
      .filter((at) => at >= startTs - PLAUSIBLE_SLACK_MS && at <= endTs + PLAUSIBLE_SLACK_MS)
      .sort((a, b) => a - b);
    const out: TimelineLine[] = [];
    let activityIndex = 0;
    let lastActivity: number | null = null;
    let attended: number | null = null;
    let previousLine: number | null = null;
    let markedSinceActivity = false;
    const marker = (from: number, to: number): TimelineLine => {
      const gapSeconds = Math.round((to - from) / 1_000);
      return {
        text: sanitize(`${relative(from)} [user idle ${Math.floor(gapSeconds / 60)}m ${gapSeconds % 60}s — away from the app]`),
        selector: null,
        route: out[out.length - 1]?.route ?? '',
        atMs: from,
        kind: 'idle',
      };
    };
    for (const line of batch) {
      if (!plausibleAt(line)) {
        out.push(line);
        continue;
      }
      const at = line.atMs;
      while (activityIndex < activity.length && activity[activityIndex]! < at) {
        lastActivity = activity[activityIndex]!;
        markedSinceActivity = false;
        activityIndex++;
      }
      if (lastActivity !== null) {
        const stretchStart = Math.max(lastActivity, previousLine ?? lastActivity);
        const endsSilence = activity[activityIndex] === at;
        const unattendedSince = Math.max(lastActivity, attended ?? lastActivity);
        if (endsSilence && !markedSinceActivity && at - unattendedSince > IDLE_THRESHOLD_MS) {
          out.push(marker(unattendedSince, at));
          markedSinceActivity = true;
        } else if (!endsSilence && at - stretchStart > IDLE_THRESHOLD_MS) {
          if (line.waitingSince !== undefined && line.waitingSince <= stretchStart + PLAUSIBLE_SLACK_MS) {
            attended = at;
          } else {
            out.push(marker(stretchStart, at));
            markedSinceActivity = true;
          }
        }
      }
      previousLine = at;
      out.push(line);
    }
    return out;
  };

  // Markers are inserted after the line-count cut so they never displace real
  // trailing evidence; long gap-riddled sessions are exactly where late-session
  // abandonment lines live. A marker whose successor was cut simply drops.
  let output = chronological(lines);
  if (output.length > options.maxLines) {
    output = output.slice(0, options.maxLines);
    truncated = true;
  }
  output = withIdleMarkers(output);
  const render = (batch: TimelineLine[]): string => batch.map((line, index) => `L${index + 1} ${line.text}`).join('\n');
  let text = render(output);
  // Markers are narration aids and can be regenerated; evidence cannot. When
  // the byte budget is exceeded, markers go first, then real lines from the end.
  if (Buffer.byteLength(text, 'utf8') > options.maxBytes && output.some((line) => line.kind === 'idle')) {
    output = output.filter((line) => line.kind !== 'idle');
    text = render(output);
  }
  while (Buffer.byteLength(text, 'utf8') > options.maxBytes && output.length > 1) {
    truncated = true;
    output = output.slice(0, Math.max(1, output.length - 50));
    text = render(output);
  }
  return { lines: output, text, truncated, startTs };
}
