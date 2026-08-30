import { describe, expect, it } from 'vitest';
import { DependencyInstallError, MachineUnavailableError } from '../errors.js';

describe('error classes', () => {
  it('MachineUnavailableError carries the state it was classified with', () => {
    const e = new MachineUnavailableError('gone', 'gone');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('MachineUnavailableError');
    expect(e.state).toBe('gone');
  });
  it('DependencyInstallError carries scrubbed output', () => {
    const e = new DependencyInstallError('install failed', 'ERESOLVE could not resolve');
    expect(e.output).toContain('ERESOLVE');
  });
});
