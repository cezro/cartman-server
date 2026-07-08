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

    // JwtAuthGuard is registered as a global APP_GUARD BEFORE this guard
    // (see app.module.ts — APP_GUARD guards run in registration order), so
    // by the time a @Roles route reaches here passport has either set
    // request.user or already rejected the request with 401. This branch
    // is defense-in-depth: it can only trip on a wiring mistake (e.g. a
    // @Roles route also marked @Public(), which skips authentication and
    // leaves no user to role-check). Throwing 401 — rather than returning
    // false, which Nest turns into 403 — keeps the "not authenticated at
    // all" status shape consistent with JwtAuthGuard's own rejections.
    if (!user) {
      throw new UnauthorizedException();
    }

    return requiredRoles.includes(user.role);
  }
}
