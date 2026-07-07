import 'reflect-metadata';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { order_status, order_type } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

/**
 * Shared query/body DTOs for the AdminModule. Kept as a single multi-class
 * file (precedent: src/merchants/dto/merchant.dto.ts) rather than one file
 * per class, since these are small and all admin-only.
 */

/** Query for GET /admin/orders. */
export class AdminOrdersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Transform(({ value }) =>
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
