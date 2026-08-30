import { describe, expect, it, vi } from 'vitest';
import { CommandExitError, SandboxError, SandboxNotFoundError, TimeoutError } from 'e2b';
import { classifyFailure, isCommandFailure } from '../machine-state.js';

const exitErr = (exitCode: number) =>
  new CommandExitError({ exitCode, stdout: '', stderr: '', error: undefined } as never);
const never = () => Promise.reject(new Error('probe should not have run'));

describe('isCommandFailure', () => {
  it('is true when the command ran and returned a code', () => {
    expect(isCommandFailure(exitErr(1))).toBe(true);
  });
  it('is false for a transport failure', () => {
    expect(isCommandFailure(new SandboxError('2: [unknown] terminated'))).toBe(false);
  });
});

describe('classifyFailure', () => {
  it('reports alive for a command exit without probing', async () => {
    expect(await classifyFailure(exitErr(1), never)).toBe('alive');
  });
  it('reports gone for a missing sandbox without probing', async () => {
    expect(await classifyFailure(new SandboxNotFoundError('gone'), never)).toBe('gone');
  });
  it('reports gone when the probe says not running', async () => {
    expect(await classifyFailure(new SandboxError('2: [unknown] terminated'), async () => false)).toBe('gone');
  });
  it('reports unknown when the probe says running, because the machine answered but the operation did not', async () => {
    expect(await classifyFailure(new SandboxError('2: [unknown] terminated'), async () => true)).toBe('unknown');
  });
  it('reports unknown when the probe itself fails, never gone', async () => {
    const probe = vi.fn(async () => { throw new Error('probe unreachable'); });
    expect(await classifyFailure(new SandboxError('2: [unknown] terminated'), probe)).toBe('unknown');
  });
  it('reports unknown for a command deadline, so a slow suite is not a dead machine', async () => {
    expect(await classifyFailure(new TimeoutError("exceeding 'timeoutMs'"), async () => true)).toBe('unknown');
  });
});
