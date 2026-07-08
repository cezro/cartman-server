import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route (or whole controller) as reachable without a bearer token.
 * Honored by the globally-registered JwtAuthGuard (see app.module.ts) —
 * without this marker, every route requires a valid Supabase JWT.
 *
 * Use sparingly: health checks, webhooks with their own auth scheme, and
 * intentionally-public auth endpoints only.
 */
export const Public = (): ReturnType<typeof SetMetadata> =>
  SetMetadata(IS_PUBLIC_KEY, true);
