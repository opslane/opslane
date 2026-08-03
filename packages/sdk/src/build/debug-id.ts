export type DebugIdRejectReason =
  | 'bom'
  | 'invalid_utf8'
  | 'duplicate_key'
  | 'depth_exceeded'
  | 'trailing_data'
  | 'invalid_unicode'
  | 'non_finite_number'
  | 'bad_version'
  | 'indexed_map'
  | 'bad_field_type'
  | 'sources_content_mismatch'
  | 'invalid_json';

export class DebugIdError extends Error {
  readonly reason: DebugIdRejectReason;

  constructor(reason: DebugIdRejectReason) {
    super(`Source map cannot be fingerprinted: ${reason}`);
    this.name = 'DebugIdError';
    this.reason = reason;
  }
}

export interface DebugIdResult {
  debugId: string;
  contentSha256: string;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonArray
  | JsonObject;

interface JsonArray {
  kind: 'array';
  values: JsonValue[];
}

interface JsonObject {
  kind: 'object';
  entries: Array<[string, JsonValue]>;
}

class StrictJsonParser {
  private offset = 0;

  constructor(private readonly source: string) {}

  parse(): JsonValue {
    this.skipWhitespace();
    const value = this.parseValue(1);
    this.skipWhitespace();
    if (this.offset !== this.source.length) {
      throw new DebugIdError('trailing_data');
    }
    return value;
  }

  private parseValue(depth: number): JsonValue {
    if (depth > 64) {
      throw new DebugIdError('depth_exceeded');
    }

    const character = this.source[this.offset];
    if (character === '{') return this.parseObject(depth);
    if (character === '[') return this.parseArray(depth);
    if (character === '"') return this.parseString();
    if (character === 't') return this.parseLiteral('true', true);
    if (character === 'f') return this.parseLiteral('false', false);
    if (character === 'n') return this.parseLiteral('null', null);
    if (character === '-' || (character >= '0' && character <= '9')) {
      return this.parseNumber();
    }
    throw new DebugIdError('invalid_json');
  }

  private parseObject(depth: number): JsonObject {
    this.offset++;
    this.skipWhitespace();
    const entries: Array<[string, JsonValue]> = [];
    const names = new Set<string>();

    if (this.consume('}')) return { kind: 'object', entries };

    while (true) {
      if (this.source[this.offset] !== '"') {
        throw new DebugIdError('invalid_json');
      }
      const name = this.parseString();
      if (names.has(name)) {
        throw new DebugIdError('duplicate_key');
      }
      names.add(name);
      this.skipWhitespace();
      this.expect(':');
      this.skipWhitespace();
      entries.push([name, this.parseValue(depth + 1)]);
      this.skipWhitespace();
      if (this.consume('}')) break;
      this.expect(',');
      this.skipWhitespace();
    }

    return { kind: 'object', entries };
  }

  private parseArray(depth: number): JsonArray {
    this.offset++;
    this.skipWhitespace();
    const values: JsonValue[] = [];

    if (this.consume(']')) return { kind: 'array', values };

    while (true) {
      values.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      if (this.consume(']')) break;
      this.expect(',');
      this.skipWhitespace();
    }

    return { kind: 'array', values };
  }

  private parseString(): string {
    const start = this.offset;
    this.offset++;

    while (this.offset < this.source.length) {
      const code = this.source.charCodeAt(this.offset);
      if (code === 0x22) {
        this.offset++;
        let value: string;
        try {
          value = JSON.parse(this.source.slice(start, this.offset)) as string;
        } catch {
          throw new DebugIdError('invalid_json');
        }
        this.assertValidUnicode(value);
        return value;
      }
      if (code < 0x20) {
        throw new DebugIdError('invalid_json');
      }
      if (code === 0x5c) {
        this.offset++;
        const escape = this.source[this.offset];
        if (
          escape !== '"' &&
          escape !== '\\' &&
          escape !== '/' &&
          escape !== 'b' &&
          escape !== 'f' &&
          escape !== 'n' &&
          escape !== 'r' &&
          escape !== 't' &&
          escape !== 'u'
        ) {
          throw new DebugIdError('invalid_json');
        }
        if (escape === 'u') {
          const hex = this.source.slice(this.offset + 1, this.offset + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new DebugIdError('invalid_json');
          }
          this.offset += 4;
        }
      }
      this.offset++;
    }

    throw new DebugIdError('invalid_json');
  }

  private assertValidUnicode(value: string): void {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (
          index + 1 >= value.length ||
          next < 0xdc00 ||
          next > 0xdfff
        ) {
          throw new DebugIdError('invalid_unicode');
        }
        index++;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw new DebugIdError('invalid_unicode');
      }
    }
  }

  private parseNumber(): number {
    const rest = this.source.slice(this.offset);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (!match) {
      throw new DebugIdError('invalid_json');
    }

    this.offset += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      throw new DebugIdError('non_finite_number');
    }
    return value;
  }

  private parseLiteral<T extends boolean | null>(literal: string, value: T): T {
    if (!this.source.startsWith(literal, this.offset)) {
      throw new DebugIdError('invalid_json');
    }
    this.offset += literal.length;
    return value;
  }

  private skipWhitespace(): void {
    while (
      this.source[this.offset] === ' ' ||
      this.source[this.offset] === '\n' ||
      this.source[this.offset] === '\r' ||
      this.source[this.offset] === '\t'
    ) {
      this.offset++;
    }
  }

  private consume(character: string): boolean {
    if (this.source[this.offset] !== character) return false;
    this.offset++;
    return true;
  }

  private expect(character: string): void {
    if (!this.consume(character)) {
      throw new DebugIdError('invalid_json');
    }
  }
}

function isArray(value: JsonValue | undefined): value is JsonArray {
  return typeof value === 'object' && value !== null && value.kind === 'array';
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && value.kind === 'object';
}

function getMember(object: JsonObject, name: string): JsonValue | undefined {
  return object.entries.find(([key]) => key === name)?.[1];
}

function validateSourceMap(value: JsonValue): asserts value is JsonObject {
  if (!isObject(value)) {
    throw new DebugIdError('bad_field_type');
  }
  if (getMember(value, 'version') !== 3) {
    throw new DebugIdError('bad_version');
  }
  if (getMember(value, 'sections') !== undefined) {
    throw new DebugIdError('indexed_map');
  }

  const sources = getMember(value, 'sources');
  const names = getMember(value, 'names');
  const mappings = getMember(value, 'mappings');
  const sourcesContent = getMember(value, 'sourcesContent');
  if (
    !isArray(sources) ||
    !sources.values.every((entry) => typeof entry === 'string') ||
    !isArray(names) ||
    !names.values.every((entry) => typeof entry === 'string') ||
    typeof mappings !== 'string'
  ) {
    throw new DebugIdError('bad_field_type');
  }
  if (sourcesContent !== undefined) {
    if (
      !isArray(sourcesContent) ||
      !sourcesContent.values.every((entry) => typeof entry === 'string')
    ) {
      throw new DebugIdError('bad_field_type');
    }
    if (sources.values.length !== sourcesContent.values.length) {
      throw new DebugIdError('sources_content_mismatch');
    }
  }
}

function canonicalize(value: JsonValue, root = false): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (isArray(value)) {
    return `[${value.values.map((entry) => canonicalize(entry)).join(',')}]`;
  }

  const entries = root
    ? value.entries.filter(([name]) => name !== 'debugId')
    : value.entries;
  const sorted = [...entries].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${sorted
    .map(
      ([name, entry]) =>
        `${JSON.stringify(name)}:${canonicalize(entry)}`,
    )
    .join(',')}}`;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

export async function computeDebugId(
  bytes: Uint8Array,
): Promise<DebugIdResult> {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    throw new DebugIdError('bom');
  }

  let source: string;
  try {
    source = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    throw new DebugIdError('invalid_utf8');
  }

  const value = new StrictJsonParser(source).parse();
  validateSourceMap(value);
  const canonicalBytes = new TextEncoder().encode(canonicalize(value, true));
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', canonicalBytes),
  );
  const contentSha256 = toHex(digest);
  const idHex = contentSha256.slice(0, 32);

  return {
    contentSha256,
    debugId: `${idHex.slice(0, 8)}-${idHex.slice(8, 12)}-${idHex.slice(
      12,
      16,
    )}-${idHex.slice(16, 20)}-${idHex.slice(20, 32)}`,
  };
}
