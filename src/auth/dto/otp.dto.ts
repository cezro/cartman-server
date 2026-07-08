import {
  IsEmail,
  IsString,
  IsNotEmpty,
  Length,
  Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';

const PH_PHONE_MESSAGE =
  'Phone must be a Philippine mobile number (+639XXXXXXXXX)';

/**
 * Normalize a PH mobile number to E.164 (+639XXXXXXXXX).
 * Accepts 09171234567, 639171234567, +639171234567 with optional
 * spaces/dashes. Returns the input unchanged (minus whitespace/dashes)
 * if it doesn't match a recognizable PH mobile shape, so validation
 * can reject it with a clear message.
 */
function normalizePhPhone(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const stripped = value.replace(/[\s-]/g, '');

  if (/^09\d{9}$/.test(stripped)) {
    return `+63${stripped.slice(1)}`;
  }

  if (/^639\d{9}$/.test(stripped)) {
    return `+${stripped}`;
  }

  if (/^\+639\d{9}$/.test(stripped)) {
    return stripped;
  }

  return stripped;
}

const PH_PHONE_REGEX = /^\+639\d{9}$/;

export class SendOtpDto {
  @Transform(({ value }: { value: unknown }) => normalizePhPhone(value))
  @IsString()
  @IsNotEmpty()
  @Matches(PH_PHONE_REGEX, { message: PH_PHONE_MESSAGE })
  phone!: string;
}

export class VerifyOtpDto {
  @Transform(({ value }: { value: unknown }) => normalizePhPhone(value))
  @IsString()
  @IsNotEmpty()
  @Matches(PH_PHONE_REGEX, { message: PH_PHONE_MESSAGE })
  phone!: string;

  @IsString()
  @IsNotEmpty()
  @Length(6, 6, { message: 'OTP code must be exactly 6 digits' })
  code!: string;
}

export class SendEmailOtpDto {
  @IsEmail()
  @IsNotEmpty()
  email!: string;
}

export class VerifyEmailOtpDto {
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @IsString()
  @IsNotEmpty()
  @Length(6, 6, { message: 'OTP code must be exactly 6 digits' })
  code!: string;
}
