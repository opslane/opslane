import { describe, expect, it } from 'vitest';
import { scrubCredentialShapes, scrubSecrets } from '../harness/redact.js';

describe('scrubSecrets', () => {
  it('keeps the netrc password and URL credential rules', () => {
    expect(scrubSecrets('machine github.com\nlogin x-access-token\npassword hunter2'))
      .toBe('machine github.com\nlogin x-access-token\npassword [REDACTED]');
    expect(scrubSecrets('fatal: https://user:hunter2@git.example.com/repo.git'))
      .toBe('fatal: https://***@git.example.com/repo.git');
  });
});

describe('scrubCredentialShapes', () => {
  it('scrubs token shapes but leaves prose and URL paths alone', () => {
    expect(scrubCredentialShapes('clone with ghp_abcdefghijklmnop failed')).toBe('clone with [REDACTED] failed');
    expect(scrubCredentialShapes('Invalid password format')).toBe('Invalid password format');
    expect(scrubCredentialShapes('https://cdn.jsdelivr.net/npm/@vue/runtime-core@3.4.21/x.js'))
      .toBe('https://cdn.jsdelivr.net/npm/@vue/runtime-core@3.4.21/x.js');
  });
});
