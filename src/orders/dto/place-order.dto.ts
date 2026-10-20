import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * One line item in a food/grocery order body. Mirrors what
 * cartman-mobile's `_merchantOrderBody` sends — see
 * SupabaseOrderRepository.place() in
 * packages/core/lib/src/data/supabase_repositories.dart. `modifiers` is the
 * customer's chosen dish options, `[{group, name, price}]`, omitted when none
 * were chosen. Its entries are deliberately not validated here: a malformed or
 * stale choice must answer 409 from OrdersService (./modifiers), because the
 * app treats a 400 as "unknown key" and retries without the choices.
 */
export class OrderItemDto {
  @IsUUID()
  menu_item_id!: string;

  @IsNumber()
  @IsPositive()
  qty!: number;

  @IsOptional()
  @IsArray()
  modifiers?: unknown[];
}

/** Body for POST /orders/food and POST /orders/grocery. */
export class PlaceMerchantOrderDto {
  @IsUUID()
  merchant_id!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];

  // The cart's "note for the restaurant" — stored on orders.notes so the
  // panel's order drawer shows it.
  @IsOptional()
  @IsString()
  notes?: string;

  // I3b — how the rider hands it over. The client omits both keys entirely
  // when the customer left the default, so an order that says nothing still
  // means hand_to_me (the DB column is NOT NULL with that default).
  //
  // Until these were listed here the global ValidationPipe's `whitelist: true`
  // stripped them silently — the client sent them, the server dropped them,
  // and the customer's choice evaporated with no error on either side.
  @IsOptional()
  @IsIn(['hand_to_me', 'leave_at_door', 'meet_at_gate', 'meet_outside'])
  dropoff_instruction?:
    'hand_to_me' | 'leave_at_door' | 'meet_at_gate' | 'meet_outside';

  @IsOptional()
  @IsString()
  dropoff_note?: string;

  // I2 — a genuine per-order drop-off, so ordering from school and delivering
  // home no longer has to promote that address to default. Optional: when the
  // client omits them OrdersService falls back to the customer's default
  // address, which is what every food order relies on today.
  @IsOptional()
  @IsLatitude()
  dropoff_lat?: number;

  @IsOptional()
  @IsLongitude()
  dropoff_lng?: number;

  @IsOptional()
  @IsString()
  dropoff_text?: string;
}

/** Body for POST /orders/errand. */
export class PlaceErrandOrderDto {
  // Structured pabili payload built by the mobile flow —
  // {items[], store?, budget_centavos, instructions?} — stored as-is on
  // orders.errand_payload; orders.notes stays the human-readable rider
  // summary.
  @IsOptional()
  @IsObject()
  errand_payload?: Record<string, unknown> | null;

  @IsOptional()
  @IsString()
  notes?: string;

  // Where the rider hands over the pabili. Required by OrdersService (same
  // manual guard as courier/ride) — optional here so the service's clearer
  // error message is the one clients surface.
  @IsOptional()
  @IsLatitude()
  dropoff_lat?: number;

  @IsOptional()
  @IsLongitude()
  dropoff_lng?: number;

  @IsOptional()
  @IsString()
  dropoff_text?: string;
}

/** Body for POST /orders/courier and POST /orders/ride. */
export class PlacePickupDropoffOrderDto {
  @IsLatitude()
  pickup_lat!: number;

  @IsLongitude()
  pickup_lng!: number;

  @IsOptional()
  @IsString()
  pickup_text?: string;

  @IsLatitude()
  dropoff_lat!: number;

  @IsLongitude()
  dropoff_lng!: number;

  @IsOptional()
  @IsString()
  dropoff_text?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  // Only used by /orders/courier — OrdersService.placeCourierOrder reads
  // recipient_name/recipient_phone; placeRideOrder ignores them. Optional so
  // the same DTO covers both endpoints without rejecting the ride body.
  @IsOptional()
  @IsString()
  recipient_name?: string;

  @IsOptional()
  @IsString()
  recipient_phone?: string;

  // Courier only, like the recipient: the largest package size declared in
  // the booking, stored as orders.package_size for the rider. Does not change
  // the fare.
  @IsOptional()
  @IsIn(['small', 'medium', 'large'])
  package_size?: 'small' | 'medium' | 'large';

  // Courier only: `{item_photo_url}`, the parcel photo the customer attaches
  // so the rider can recognise it at pickup. Same column and shape-free
  // contract as the errand body's errand_payload.
  @IsOptional()
  @IsObject()
  errand_payload?: Record<string, unknown> | null;
}

/** One stop in a multi-stop order (cartman-server-endpoints.md §1). */
export class OrderStopDto {
  @IsInt()
  @Min(0)
  seq!: number;

  // Matches the DB contract for order_stops.kind ('pickup' | 'buy' |
  // 'deliver', 20260630000100_schema.sql) — 'buy' is the Multi-Stop
  // Builder's Pabili task tile.
  @IsIn(['pickup', 'buy', 'deliver'])
  kind!: 'pickup' | 'buy' | 'deliver';

  @IsOptional()
  @IsString()
  label?: string;

  @IsLatitude()
  lat!: number;

  @IsLongitude()
  lng!: number;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown> | null;
}

/**
 * Body for POST /orders/multi-stop. ≥2 stops; seq contiguity from 0 is a
 * cross-field rule, so OrdersService checks it rather than the DTO.
 */
export class PlaceMultiStopOrderDto {
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => OrderStopDto)
  stops!: OrderStopDto[];

  @IsOptional()
  @IsString()
  notes?: string;

  // Sent by the client for interface parity with the contract body; the DB
  // column defaults to cod when omitted.
  @IsOptional()
  @IsIn(['cod', 'gcash', 'maya', 'card', 'cart_credits'])
  payment?: 'cod' | 'gcash' | 'maya' | 'card' | 'cart_credits';
}

/**
 * Body for PATCH /orders/:id/cancel and /orders/:id/reject. Both clients may
 * send no body at all — `reason` is the only (optional) field; the service
 * trims it and stores empty as null.
 */
export class CancelOrderDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

/**
 * Body for POST /orders/:id/rating (cartman-server-endpoints.md §Ratings).
 * Each score is an optional 1..5 int; "at least one score" is a cross-field
 * rule, so OrdersService checks it rather than the DTO (same split as
 * multi-stop seq contiguity).
 */
export class RateOrderDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  merchant_stars?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rider_stars?: number;

  // Trimmed by the service; blank stored as null (nullif(trim(…)) parity
  // with the rate_order RPC).
  @IsOptional()
  @IsString()
  comment?: string;
}

/** Body for PATCH /orders/:id/status. */
export class UpdateOrderStatusDto {
  @IsString()
  @IsIn([
    'accepted',
    'arrived_at_merchant',
    'picked_up',
    'in_transit',
    'delivered',
  ])
  status!:
    | 'accepted'
    | 'arrived_at_merchant'
    | 'picked_up'
    | 'in_transit'
    | 'delivered';
}
