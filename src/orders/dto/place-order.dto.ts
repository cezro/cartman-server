import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
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
