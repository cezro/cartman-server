import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';

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
 * Validates Supabase-issued JWTs.
 * Extracts user ID (sub) and looks up the profile role from the DB.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.SUPABASE_JWT_SECRET || 'secret',
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
