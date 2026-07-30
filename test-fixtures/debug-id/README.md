# Debug-ID vectors

`vectors.json` is the append-only, cross-language contract for Opslane debug-ID
fingerprinting, in the same sense as the frozen fixtures under
`test-fixtures/wire/`. Existing cases and expected values must not be edited.

Inputs are stored as raw bytes encoded with base64 so the suite can represent
invalid UTF-8, byte-order marks, duplicate JSON keys, and other malformed input.
Expected canonical bytes, hashes, and debug IDs come from an independent
third-party RFC 8785 implementation, never from either Opslane implementation.

Both the TypeScript and Go suites read this file. Adding a case intentionally
breaks the other suite until both implementations agree on the same behavior.

Run `node build-vectors.mjs` after appending a case, then verify every expected
value independently before checking in the generated `vectors.json`.
