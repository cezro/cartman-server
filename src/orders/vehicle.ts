// What a rider drives, and which orders that lets them take.
//
// `riders.vehicle` is free text: the rider app writes 'motorcycle' |
// 'tricycle', but older and admin-made rows hold model names ('Honda Click
// 125i', 'Motor'). Anything that does not say tricycle is a motorcycle — the
// fleet has no third kind.
//
// This mirrors the database's `vehicle_class` and the
// `orders_enforce_required_vehicle` trigger (cartman-mobile
// 20261008000100_order_required_vehicle.sql). The two have to agree: if this
// side were looser, the feed would show a rider orders the trigger then
// refuses at claim time.

export type VehicleClass = 'motorcycle' | 'tricycle';

export function vehicleClass(vehicle: string | null | undefined): VehicleClass {
  return (vehicle ?? '').toLowerCase().includes('tricycle')
    ? 'tricycle'
    : 'motorcycle';
}

/**
 * Prisma `where` fragment for the orders a rider of [cls] may see and claim:
 * those that name no vehicle, and those that name theirs. An order a
 * motorcycle rider handed back as too big carries `required_vehicle =
 * 'tricycle'` (`rider_request_bigger_vehicle`), so it reaches tricycles only.
 */
export function claimableBy(cls: VehicleClass) {
  return { OR: [{ required_vehicle: null }, { required_vehicle: cls }] };
}
