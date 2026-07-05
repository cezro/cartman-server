// Prisma returns bigint columns (`cart_points`, `wallet_centavos`) as JS
// BigInt, which Nest's default JSON serializer cannot stringify — this is
// what caused /auth/me (and, before this fix, GET /profiles/me too) to 500
// on every live call. Centavo/points values are far under
// Number.MAX_SAFE_INTEGER, so converting to Number at the response boundary
// is safe. Mirrors the serializeOrder() precedent in
// src/orders/serialize-order.ts (Number, not String, for consistency).
// Shared by AuthController.getMe and ProfilesService.getProfile so both
// `/auth/me` and `/profiles/me` return the same wire shape for a profile row.
export function serializeProfile<T extends Record<string, any>>(profile: T): T {
  const out: Record<string, any> = { ...profile };
  for (const field of ['cart_points', 'wallet_centavos'] as const) {
    if (typeof out[field] === 'bigint') out[field] = Number(out[field]);
  }
  return out as T;
}
