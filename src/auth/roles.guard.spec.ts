import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';

function buildContext(
  requiredRoles: string[] | undefined,
  user?: { role: string },
) {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(requiredRoles),
  } as unknown as Reflector;

  const context = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;

  return { reflector, context };
}

describe('RolesGuard', () => {
  it('allows any authenticated user when no @Roles() decorator is present', () => {
    const { reflector, context } = buildContext(undefined, {
      role: 'customer',
    });
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows a user whose role matches one of the required roles', () => {
    const { reflector, context } = buildContext(['rider', 'admin'], {
      role: 'rider',
    });
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects a user whose role does not match', () => {
    const { reflector, context } = buildContext(['admin'], {
      role: 'customer',
    });
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(context)).toBe(false);
  });

  // Regression: RolesGuard is registered globally (APP_GUARD in
  // app.module.ts) but JwtAuthGuard is only applied per-controller via
  // @UseGuards() — global guards run before controller-level guards, so on
  // an unauthenticated request `request.user` is undefined when this guard
  // runs. Before this fix that crashed with a 500 ("Cannot read properties
  // of undefined (reading 'role')") instead of a clean 401 — reproduced by
  // test/app.e2e-spec.ts's "401 JSON shape" block.
  it('throws UnauthorizedException (not a TypeError) when request.user is absent on a @Roles()-guarded route', () => {
    const { reflector, context } = buildContext(['customer'], undefined);
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });
});
