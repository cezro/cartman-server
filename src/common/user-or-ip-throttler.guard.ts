import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate-limit bucket key = the authenticated user's id when present, else the
 * client IP.
 *
 * Keying authenticated traffic by user (not IP) matters for a PH mobile app:
 * carriers put many subscribers behind carrier-grade NAT, so an IP-only quota
 * would let strangers sharing one carrier NAT IP throttle each other. IP is
 * the fallback only for the handful of @Public routes (health, the dormant
 * email-OTP pair) where no user is attached.
 *
 * Requires this guard to run AFTER JwtAuthGuard (which populates req.user) —
 * see the APP_GUARD ordering in app.module.ts. `req.ip` is the real client IP
 * because main.ts sets `trust proxy` (Render terminates TLS at a proxy).
 */
@Injectable()
export class UserOrIpThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    const user = req.user as { id?: string } | undefined;
    const ip = req.ip as string;
    return Promise.resolve(user?.id ?? ip);
  }
}
