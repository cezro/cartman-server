import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseJwtKeys } from './supabase-jwt-keys';

interface JwtPayload {
  sub: string;
  aud: string;
  role: string;
  email?: string;
  phone?: string;
  iat: number;
  exp: number;
}

export interface AuthenticatedUser {
  id: string;
  role: string;
  email?: string;
  phone?: string;
}

/**
 * Validates Supabase-issued JWTs (supporting HS256 symmetric and ES256/RS256 JWKS asymmetric keys).
 * Extracts user ID (sub) and looks up the profile role from the DB.
 *
 * Key selection is per-token (SupabaseJwtKeys): legacy HS256 projects and
 * the test fixtures verify with SUPABASE_JWT_SECRET; newer projects sign
 * ES256 and verify against the project JWKS.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    const keys = new SupabaseJwtKeys(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_JWT_SECRET || 'secret',
    );
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      algorithms: [
        'HS256',
        'RS256',
        'ES256',
        'HS384',
        'HS512',
        'RS384',
        'RS512',
        'ES384',
        'ES512',
      ],
      secretOrKeyProvider: (
        _req: unknown,
        rawJwt: string,
        done: (err: Error | null, key?: string) => void,
      ) => {
        keys.keyFor(rawJwt).then(
          (key) => done(null, key),
          (err: Error) => done(err),
        );
      },
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const profile = await this.prisma.profiles.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true },
    });

    if (!profile) {
      throw new UnauthorizedException('User profile not found');
    }

    return {
      id: profile.id,
      role: profile.role,
      email: payload.email,
      phone: payload.phone,
    };
  }
}
