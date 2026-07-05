import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';

/**
 * Guard that checks if the authenticated user's role matches
 * the roles specified by the @Roles() decorator.
 * If no roles are specified on the handler, access is granted to any authenticated user.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No @Roles() decorator — allow any authenticated user
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const { user } = context
      .switchToHttp()
      .getRequest<{ user?: { role: string } }>();

    // RolesGuard is registered globally (APP_GUARD) but JwtAuthGuard is only
    // applied per-controller via @UseGuards() — global guards run before
    // controller-level ones, so on an unauthenticated request `user` is not
    // set yet here. Without this check that read as a crash (500, "Cannot
    // read properties of undefined") instead of the 401 an unauthenticated
    // request should get. Returning `false` would produce Nest's default
    // 403 Forbidden, which is the wrong status for "not authenticated at
    // all" — throw 401 explicitly so the two guards agree on one shape.
    if (!user) {
      throw new UnauthorizedException();
    }

    return requiredRoles.includes(user.role);
  }
}
