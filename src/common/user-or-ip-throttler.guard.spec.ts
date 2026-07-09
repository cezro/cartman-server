import { UserOrIpThrottlerGuard } from './user-or-ip-throttler.guard';

// getTracker is the only method we override; construct the guard with stub
// deps (they're unused by getTracker) and call the protected method directly.
function makeGuard(): UserOrIpThrottlerGuard {
  return new UserOrIpThrottlerGuard(
    { throttlers: [] },
    {} as never,
    {} as never,
  );
}

describe('UserOrIpThrottlerGuard.getTracker', () => {
  it('keys by the authenticated user id when req.user is set', async () => {
    const guard = makeGuard();
    const tracker = await (
      guard as unknown as {
        getTracker(req: Record<string, unknown>): Promise<string>;
      }
    ).getTracker({ user: { id: 'user-123' }, ip: '10.0.0.9' });

    expect(tracker).toBe('user-123');
  });

  it('falls back to the client IP when no user is attached (public routes)', async () => {
    const guard = makeGuard();
    const tracker = await (
      guard as unknown as {
        getTracker(req: Record<string, unknown>): Promise<string>;
      }
    ).getTracker({ ip: '203.0.113.7' });

    expect(tracker).toBe('203.0.113.7');
  });

  it('prefers the user id even when an IP is also present', async () => {
    const guard = makeGuard();
    const tracker = await (
      guard as unknown as {
        getTracker(req: Record<string, unknown>): Promise<string>;
      }
    ).getTracker({ user: { id: 'rider-1' }, ip: '203.0.113.7' });

    expect(tracker).toBe('rider-1');
  });
});
