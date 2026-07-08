import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

/** Body for PATCH /merchants/:id/status. */
export class UpdateMerchantStatusDto {
  @IsBoolean()
  is_open!: boolean;
}

/**
 * Body for POST /merchants. No mobile call site exists yet (merchant
 * onboarding is an admin/merchant-panel concern, not built in
 * cartman-mobile) — fields are derived from the `merchants` Prisma model
 * (prisma/schema.prisma), which MerchantsService.createMerchant spreads
 * the body onto directly. Money fields (delivery_fee, min_order) are
 * centavos, same convention as orders.
 */
export class CreateMerchantDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  delivery_fee?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  min_order?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  eta_minutes?: number;

  @IsOptional()
  @IsBoolean()
  is_open?: boolean;

  @IsOptional()
  @IsString()
  image_url?: string;

  @IsOptional()
  @IsString()
  promo_text?: string;
}

/**
 * Shared body for POST /merchants/:id/menu-items and
 * PUT /merchants/:id/menu-items/:itemId. No mobile call site exists yet
 * (menu management is a merchant-panel concern) — fields derived from the
 * `menu_items` Prisma model. All optional on update (PUT sends partials in
 * practice today, matching the untyped `data: any` it replaces); `name` is
 * required for create since the column has no default.
 */
export class CreateMenuItemDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsBoolean()
  in_stock?: boolean;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  modifiers?: unknown[];
}

export class UpdateMenuItemDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsBoolean()
  in_stock?: boolean;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  modifiers?: unknown[];
}
