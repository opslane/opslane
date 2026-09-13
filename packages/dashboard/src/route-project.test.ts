import { describe, expect, it } from 'vitest';
import { routeNeedsProject } from './route-project';

describe('routeNeedsProject', () => {
  it('lets an operator without a selected project open the admin dashboard', () => {
    expect(routeNeedsProject('admin')).toBe(false);
    expect(routeNeedsProject('invite-accept')).toBe(false);
  });

  it('allows projectless organizations to approve an agent setup', () => {
    expect(routeNeedsProject('agent-approve')).toBe(false);
  });

  it('still requires a project for tenant-scoped routes', () => {
    expect(routeNeedsProject('issues')).toBe(true);
    expect(routeNeedsProject('sessions')).toBe(true);
  });
});
