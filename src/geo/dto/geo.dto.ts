// class-transformer's @Type() relies on Reflect.getMetadata, which Nest's
// bootstrap chain loads transitively — but these DTOs are also exercised
// directly in unit specs with no Nest module tree in the import graph, so the
// polyfill must be pulled in explicitly here (same reason as
// common/dto/pagination-query.dto.ts).
import 'reflect-metadata';
import { Type } from 'class-transformer';
import {
  IsLatitude,
  IsLongitude,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * `GET /geo/search` — forward geocode, driven by type-ahead in the customer
 * app's address form.
 */
export class GeoSearchQueryDto {
  /**
   * Minimum 3 characters: below that the upstream returns near-noise and every
   * keystroke would be a billable request for a result nobody picks.
   */
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  q!: string;

  /**
   * Caller's current fix, forwarded upstream as `proximity` so local results
   * outrank distant same-name ones. Without it a search for "SM City" returns
   * Manila before Iloilo. Optional but strongly encouraged — the client sends
   * it whenever a GPS fix exists.
   *
   * Both must be supplied together; GeoService ignores a lone lat or lng.
   */
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  lat?: number;

  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  lng?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  limit: number = 5;
}

/** `GET /geo/reverse` — coords → address, for "use my location" and map taps. */
export class GeoReverseQueryDto {
  @Type(() => Number)
  @IsLatitude()
  lat!: number;

  @Type(() => Number)
  @IsLongitude()
  lng!: number;
}

/**
 * The shape the mobile app consumes. Deliberately *not* the upstream provider's
 * schema — swapping Mapbox for another geocoder must be a server deploy, not an
 * app-store release.
 */
export interface GeoPlace {
  /** Primary line, e.g. "SM City Iloilo". */
  label: string;
  /** Secondary line, e.g. "Benigno Aquino Ave, Mandurriao, Iloilo City". */
  address: string;
  lat: number;
  lng: number;
}
