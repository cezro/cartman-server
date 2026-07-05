import { IsOptional, IsString } from 'class-validator';

/**
 * Body for POST /riders. No mobile call site exists yet for this endpoint
 * (grepped packages/core/lib/src/data/*.dart — riders are provisioned some
 * other way today), so fields are derived from RidersService.createRider,
 * which spreads the body straight onto the `riders` Prisma model. Both
 * columns default in the schema (`vehicle` "", `plate_no` ""), so both stay
 * optional here to match current tolerance for an empty body.
 */
export class CreateRiderDto {
  @IsOptional()
  @IsString()
  vehicle?: string;

  @IsOptional()
  @IsString()
  plate_no?: string;
}
