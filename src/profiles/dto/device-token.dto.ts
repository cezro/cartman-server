import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * Body for POST /profiles/me/device-tokens (C-4.2).
 * `platform` defaults server-side (see ProfilesService) when omitted.
 */
export class RegisterDeviceTokenDto {
  @IsString()
  @IsNotEmpty()
  token!: string;

  @IsOptional()
  @IsIn(['android', 'ios'])
  platform?: 'android' | 'ios';
}
