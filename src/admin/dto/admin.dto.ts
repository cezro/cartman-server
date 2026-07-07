import 'reflect-metadata';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { order_status, order_type, wallet_txn_type } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

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
