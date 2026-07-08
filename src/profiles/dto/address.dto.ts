import {
  IsBoolean,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

/**
 * Body for POST /profiles/me/addresses. Mirrors
 * SupabaseAddressRepository.create() in
 * packages/core/lib/src/data/supabase_repositories.dart:
 * `{label, text_address, lat, lng, is_default}`.
 */
export class CreateAddressDto {
  @IsString()
  @IsNotEmpty()
  label!: string;

  @IsString()
  @IsNotEmpty()
  text_address!: string;

  @IsLatitude()
  lat!: number;

  @IsLongitude()
  lng!: number;

  @IsOptional()
  @IsBoolean()
  is_default?: boolean;
}

/**
 * Body for PUT /profiles/me/addresses/:id. Mirrors
 * SupabaseAddressRepository.update(), which sends only the fields that
 * changed (Dart's `?label` null-shorthand drops unset keys entirely) — every
 * field here is optional to match.
 */
export class UpdateAddressDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  label?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  text_address?: string;

  @IsOptional()
  @IsLatitude()
  lat?: number;

  @IsOptional()
  @IsLongitude()
  lng?: number;

  @IsOptional()
  @IsBoolean()
  is_default?: boolean;
}
