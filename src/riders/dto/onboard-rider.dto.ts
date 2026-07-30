import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Body for POST /riders/onboard — the self-service "I want to be a rider"
 * payload sent by the rider app's onboarding screen after a Google sign-in
 * lands a session with no `riders` row.
 *
 * Mirrors the fields the email/password rider sign-up form already collects
 * (vehicle, plate, phone), so both routes reach the same end state. `vehicle`
 * and `plate_no` both default to "" in the schema and stay optional here to
 * match POST /riders' existing tolerance; `phone` is validated as E.164 PH
 * because profiles.phone is UNIQUE and feeds the OTP endpoints and the
 * customer's call button — a malformed value there breaks dispatch, not just
 * this request.
 */
export class OnboardRiderDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  vehicle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  plate_no?: string;

  @IsOptional()
  @Matches(/^\+639\d{9}$/, {
    message: 'phone must be a PH mobile number in E.164 form (+639XXXXXXXXX)',
  })
  phone?: string;
}
