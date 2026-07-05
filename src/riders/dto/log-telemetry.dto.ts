import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';

/**
 * One GPS fix. Mirrors ApiRiderLocationRepository.flush()'s batch shape
 * (packages/core/lib/src/data/rider_location_repository.dart):
 * `{lat, lng, order_id?, recorded_at}` — recorded_at is always sent by the
 * mobile client (ISO 8601, `DateTime.now().toIso8601String()`) but
 * RidersService.logTelemetry already defaults it server-side if absent, so
 * it stays optional here to match.
 */
export class TelemetryLocationDto {
  @IsLatitude()
  lat!: number;

  @IsLongitude()
  lng!: number;

  @IsOptional()
  @IsUUID()
  order_id?: string;

  @IsOptional()
  @IsDateString()
  recorded_at?: string;
}

/** Body for POST /riders/me/telemetry. */
export class LogTelemetryDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TelemetryLocationDto)
  locations!: TelemetryLocationDto[];
}
