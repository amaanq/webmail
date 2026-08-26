import { describe, it, expect } from 'vitest';
import { restoreErrorEvicts, __authErrorsForTest } from '../auth-store';

// Restoring an account must only evict it (and delete its cookies) when the
// auth endpoint positively rejected the stored session. One Stalwart outage
// used to wipe every signed-in account because unknown errors defaulted to
// eviction.
describe('restore error eviction policy', () => {
  const { TransientAuthError, DefinitiveAuthError } = __authErrorsForTest;

  it('keeps accounts on outages and unknown failures', () => {
    expect(restoreErrorEvicts(new TransientAuthError('Session restore failed', 502))).toBe(false);
    expect(restoreErrorEvicts(new TypeError('fetch failed'))).toBe(false);
    expect(restoreErrorEvicts(new Error('Failed to get session: 502'))).toBe(false);
    expect(restoreErrorEvicts(new DOMException('timeout', 'TimeoutError'))).toBe(false);
  });

  it('evicts only on a positive rejection', () => {
    expect(restoreErrorEvicts(new DefinitiveAuthError('Session cookie missing', 404))).toBe(true);
    expect(restoreErrorEvicts(new DefinitiveAuthError('Token refresh failed', 401))).toBe(true);
  });
});
