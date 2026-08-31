import { describe, expect, it, vi, beforeEach } from 'vitest';

const emit = vi.fn();
vi.mock('../usage-events.js', () => ({ emitUsageEvent: emit, incidentUrlFor: () => '' }));

const { alertRestrictedMachineFailure } = await import('../restricted-machine-alert.js');

describe('alertRestrictedMachineFailure', () => {
  beforeEach(() => emit.mockClear());

  const net = { denyOut: ['0.0.0.0/0'], allowOut: ['registry.npmjs.org', 'github.com'], rules: {} };

  it('says nothing when the machine had no policy, because nothing could have been blocked', () => {
    alertRestrictedMachineFailure({ network: undefined, phase: 'install', jobId: 'j', projectId: 'p', detail: 'boom' });
    expect(emit).not.toHaveBeenCalled();
  });

  it('fires once, carrying the phase and the allowlist a reader needs', () => {
    alertRestrictedMachineFailure({ network: net, phase: 'install', jobId: 'j1', projectId: 'p1', detail: 'ENOTFOUND cdn.example.com' });
    expect(emit).toHaveBeenCalledTimes(1);
    const [event, props] = emit.mock.calls[0]!;
    expect(event).toBe('fix_restricted_machine_failed');
    expect(props).toMatchObject({ job_id: 'j1', project_id: 'p1', phase: 'install' });
    expect(props['allow_out']).toBe('registry.npmjs.org,github.com');
    expect(props['detail']).toContain('cdn.example.com');
  });

  it('fires for every phase, not just install, which is the whole point', () => {
    for (const phase of ['clone', 'setup', 'install', 'test', 'build'] as const) {
      alertRestrictedMachineFailure({ network: net, phase, jobId: 'j', projectId: 'p', detail: 'x' });
    }
    expect(emit).toHaveBeenCalledTimes(5);
    expect(emit.mock.calls.map((c) => c[1]['phase'])).toEqual(['clone', 'setup', 'install', 'test', 'build']);
  });

  it('never puts a credential in the payload', () => {
    alertRestrictedMachineFailure({
      network: net, phase: 'clone', jobId: 'j', projectId: 'p',
      detail: 'fatal: https://x:ghp_AAAABBBBCCCCDDDD@github.com/o/r failed, key sk-ant-api03-SECRET',
    });
    const detail = emit.mock.calls[0]![1]['detail']!;
    expect(detail).not.toContain('ghp_AAAABBBBCCCCDDDD');
    expect(detail).not.toContain('sk-ant-api03-SECRET');
  });

  it('caps the detail, because this goes to Slack', () => {
    alertRestrictedMachineFailure({ network: net, phase: 'test', jobId: 'j', projectId: 'p', detail: 'y'.repeat(5000) });
    expect(emit.mock.calls[0]![1]['detail']!.length).toBeLessThanOrEqual(800);
  });
});
