import 'reflect-metadata';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { order_status, order_type, wallet_txn_type } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

// ── Admin Dashboard V2 status vocabularies (mirror the spec's enums) ─────
export const VERIFICATION_STATUSES = [
  'Pending',
  'Approved',
  'Rejected',
] as const;
export const TICKET_STATUSES = ['Open', 'In Progress', 'Closed'] as const;
export const USER_ROLES = ['customer', 'rider', 'merchant', 'admin'] as const;

// Coerces the 'true'/'false' string a query param arrives as into a real
// boolean before @IsBoolean() validates it. Anything else (including
// undefined, when the param is omitted) passes through unchanged so
// @IsOptional() can short-circuit as usual.
function toBoolean({ value }: { value: unknown }): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

/**
 * Shared query/body DTOs for the AdminModule. Kept as a single multi-class
 * file (precedent: src/merchants/dto/merchant.dto.ts) rather than one file
 * per class, since these are small and all admin-only.
 */

/** Query for GET /admin/orders. */
export class AdminOrdersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',') : value,
  )
  @IsIn(Object.values(order_status), { each: true })
  status?: order_status[];

  @IsOptional()
  @IsIn(Object.values(order_type))
  type?: order_type;

  @IsOptional()
  @IsUUID()
  rider_id?: string;

  @IsOptional()
  @IsUUID()
  customer_id?: string;

  @IsOptional()
  @IsUUID()
  merchant_id?: string;
}

/** Body for PATCH /admin/orders/:id/reassign. */
export class ReassignOrderDto {
  @IsNotEmpty()
  @IsUUID()
  rider_id!: string;
}

/** Query for GET /admin/riders. */
export class AdminRidersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  on_duty?: boolean;
}

/** Query for GET /admin/merchants. */
export class AdminMerchantsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  is_open?: boolean;
}

/** Query for GET /admin/ledger/transactions. */
export class AdminLedgerQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  rider_id?: string;

  @IsOptional()
  @IsUUID()
  order_id?: string;

  @IsOptional()
  @IsIn(Object.values(wallet_txn_type))
  type?: wallet_txn_type;
}

// ══ Admin Dashboard V2 ════════════════════════════════════════════════════

/** Nested block of POST /admin/config. */
export class PricingConfigDto {
  @IsOptional()
  @IsNumber()
  baseRate?: number;

  @IsOptional()
  @IsNumber()
  baseRadius?: number;

  @IsOptional()
  @IsNumber()
  surchargePerKm?: number;
}

/** Nested block of POST /admin/config. */
export class RiderConfigDto {
  @IsOptional()
  @IsNumber()
  strikeLimit?: number;

  @IsOptional()
  @IsBoolean()
  autoAssign?: boolean;
}

/** Nested block of POST /admin/config. */
export class MerchantConfigDto {
  @IsOptional()
  @IsNumber()
  proExposureMultiplier?: number;

  @IsOptional()
  @IsBoolean()
  allowAds?: boolean;
}

/** Body for POST /admin/config — every block optional (partial update). */
export class UpdateConfigDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => PricingConfigDto)
  pricingConfig?: PricingConfigDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => RiderConfigDto)
  riderConfig?: RiderConfigDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => MerchantConfigDto)
  merchantConfig?: MerchantConfigDto;
}

/** Query for GET /admin/users. */
export class AdminUsersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(USER_ROLES)
  role?: (typeof USER_ROLES)[number];
}

/** Query for GET /admin/verifications. */
export class AdminVerificationsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(VERIFICATION_STATUSES)
  status?: (typeof VERIFICATION_STATUSES)[number];

  /** One subject's review history — the rider-detail page's query. */
  @IsOptional()
  @IsUUID()
  user_id?: string;
}

/** Query for GET /admin/tickets. */
export class AdminTicketsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(TICKET_STATUSES)
  status?: (typeof TICKET_STATUSES)[number];
}

/** Body for PATCH /admin/tickets/:id/status. */
export class UpdateTicketStatusDto {
  @IsIn(TICKET_STATUSES)
  status!: (typeof TICKET_STATUSES)[number];
}
