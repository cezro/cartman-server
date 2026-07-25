import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Guard that enforces JWT authentication on endpoints.
 *
 * Registered globally via APP_GUARD in app.module.ts, BEFORE RolesGuard —
 * APP_GUARD guards execute in registration order, and RolesGuard needs
 * `request.user` (set here by passport) to check roles. It previously was
 * controller-level only, which meant the global RolesGuard ran first and
 * rejected every @Roles route with 401 even for valid tokens.
 *
 * Routes marked with @Public() (see public.decorator.ts) skip the JWT
 * check entirely: health checks, the Supabase webhook (own secret-header
 * auth), and the intentionally-unauthenticated email OTP endpoints.
 *
 * Pre-existing controller-level @UseGuards(JwtAuthGuard) decorators are
 * harmless duplicates (the guard just runs twice) and are left in place.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    return super.canActivate(context);
  }

  handleRequest(err: any, user: any, info: any) {
    if (err || !user) {
      throw err || new UnauthorizedException(info?.message || 'Unauthorized');
    }
    return user;
  }
}
