// Prisma returns bigint centavo columns as JS BigInt, which Nest's default
// JSON serializer cannot stringify. Centavo amounts are far under
// Number.MAX_SAFE_INTEGER, so converting at the response boundary is safe.
// Shared by OrdersService and FeedService — both return order rows to
// mobile clients over the same wire shape.
export function serializeOrder<T extends Record<string, any>>(order: T): T {
  const moneyFields = [
    'subtotal',
    'delivery_fee',
    'discount',
    'total',
    'delivery_payout',
  ] as const;
  const out: Record<string, any> = { ...order };
  for (const field of moneyFields) {
    if (typeof out[field] === 'bigint') out[field] = Number(out[field]);
  }
  if (Array.isArray(out.order_items)) {
    out.order_items = out.order_items.map((item: Record<string, any>) =>
      typeof item.unit_price === 'bigint'
        ? { ...item, unit_price: Number(item.unit_price) }
        : item,
    );
  }
  return out as T;
}
