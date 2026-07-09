// Two money conventions coexist across the admin surface:
//  - General admin reads (stats, orders, riders, merchants) return Number
//    centavos, matching the serializeOrder/serializeProfile precedent
//    (src/orders/serialize-order.ts, src/common/serialize-profile.ts) — the
//    dashboard consumes these as plain JSON numbers.
//  - Ledger routes keep the EXISTING string-centavos wire shape that
//    LedgerController already returns to mobile (its own .toString()
//    mapping on id/amount) — the admin ledger list mirrors that shape
//    rather than inventing a third convention.

/**
 * Serializes a riders row merged with computed fields (active_orders,
 * net_cash, wallet_locked, last_location) for GET /admin/riders. Converts
 * Prisma Decimal columns (rating, acceptance_rate) and any BigInt fields
 * (net_cash) to Number.
 */
export function serializeAdminRider<T extends Record<string, any>>(
  rider: T,
): T {
  const out: Record<string, any> = { ...rider };
  if (out.rating !== undefined && out.rating !== null) {
    out.rating = Number(out.rating);
  }
  if (out.acceptance_rate !== undefined && out.acceptance_rate !== null) {
    out.acceptance_rate = Number(out.acceptance_rate);
  }
  if (typeof out.net_cash === 'bigint') {
    out.net_cash = Number(out.net_cash);
  }
  return out as T;
}

/**
 * Serializes a merchants row (+ computed active_orders) for
 * GET /admin/merchants. Converts BigInt money columns (delivery_fee,
 * min_order) and the Decimal rating column to Number.
 */
export function serializeAdminMerchant<T extends Record<string, any>>(
  merchant: T,
): T {
  const out: Record<string, any> = { ...merchant };
  for (const field of ['delivery_fee', 'min_order'] as const) {
    if (typeof out[field] === 'bigint') out[field] = Number(out[field]);
  }
  if (out.rating !== undefined && out.rating !== null) {
    out.rating = Number(out.rating);
  }
  return out as T;
}

/**
 * Serializes a rider_wallet_transactions row for GET
 * /admin/ledger/transactions. Converts BigInt id/amount to string — the
 * existing ledger wire-shape convention (see LedgerController).
 */
export function serializeAdminLedgerTxn<T extends Record<string, any>>(
  txn: T,
): T {
  const out: Record<string, any> = { ...txn };
  if (typeof out.id === 'bigint') out.id = out.id.toString();
  if (typeof out.amount === 'bigint') out.amount = out.amount.toString();
  return out as T;
}

/**
 * Serializes the global_config singleton for GET/POST /admin/config.
 * Converts the Prisma Decimal columns (base_rate, base_radius,
 * surcharge_per_km, pro_exposure_multiplier) to Number — Decimal, like
 * BigInt, is not JSON-serializable by Nest's default serializer. The Int and
 * Boolean columns and the updated_at timestamp pass through unchanged.
 */
export function serializeGlobalConfig<T extends Record<string, any>>(
  config: T,
): T {
  const out: Record<string, any> = { ...config };
  for (const field of [
    'base_rate',
    'base_radius',
    'surcharge_per_km',
    'pro_exposure_multiplier',
  ] as const) {
    if (out[field] !== undefined && out[field] !== null) {
      out[field] = Number(out[field]);
    }
  }
  return out as T;
}
