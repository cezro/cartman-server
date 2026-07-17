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
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * One line item in a food/grocery order body. Mirrors what
 * cartman-mobile's `_merchantOrderBody` sends (menu_item_id, qty) — see
 * SupabaseOrderRepository.place() in
 * packages/core/lib/src/data/supabase_repositories.dart. `modifiers` is not
 * sent by the mobile client today but OrdersService.placeMerchantOrder
 * already reads `item.modifiers`, so it stays optional here rather than
 * being dropped.
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
}

/** Body for POST /orders/errand. */
export class PlaceErrandOrderDto {
  // Mobile currently always sends `null` (see the OrderType.errand branch in
  // supabase_repositories.dart) — the Pabili flow folds store/items/budget
  // into `notes` instead of a structured payload. Kept loosely typed
  // (object or null) since OrdersService just stores it as-is.
  @IsOptional()
  @IsObject()
  errand_payload?: Record<string, unknown> | null;

  @IsOptional()
  @IsString()
  notes?: string;
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
}

/** One stop in a multi-stop order (cartman-server-endpoints.md §1). */
export class OrderStopDto {
  @IsInt()
  @Min(0)
  seq!: number;

  @IsIn(['pickup', 'deliver'])
  kind!: 'pickup' | 'deliver';

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
