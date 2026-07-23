import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';

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

const keyCache = new Map<string, string>();

async function getSecretOrPublicKey(
  request: any,
  rawJwtToken: string,
  done: (err: any, secret?: string) => void,
) {
  try {
    const decoded = jwt.decode(rawJwtToken, { complete: true });
    const header = decoded?.header;

    if (!header || !header.alg) {
      return done(new UnauthorizedException('Invalid JWT header'));
    }

    if (header.alg === 'HS256' || header.alg === 'HS384' || header.alg === 'HS512') {
      return done(null, process.env.SUPABASE_JWT_SECRET || 'secret');
    }

    // For ES256 / RS256 asymmetric keys issued by Supabase
    const kid = header.kid;
    if (kid && keyCache.has(kid)) {
      return done(null, keyCache.get(kid));
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    if (!supabaseUrl) {
      return done(null, process.env.SUPABASE_JWT_SECRET || 'secret');
    }

    const jwksUrl = `${supabaseUrl.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`;
    const res = await fetch(jwksUrl);
    if (!res.ok) {
      throw new Error(`Failed to fetch JWKS from ${jwksUrl}: ${res.statusText}`);
    }

    const jwks = await res.json();
    const matchingKey = (jwks.keys || []).find((k: any) => k.kid === kid) || jwks.keys?.[0];

    if (!matchingKey) {
      throw new Error(`No matching JWK key found for kid: ${kid}`);
    }

    const publicKeyPem = crypto
      .createPublicKey({ key: matchingKey, format: 'jwk' })
      .export({ type: 'spki', format: 'pem' })
      .toString();

    if (kid) {
      keyCache.set(kid, publicKeyPem);
    }

    done(null, publicKeyPem);
  } catch (err: any) {
    done(err);
  }
}

/**
 * Validates Supabase-issued JWTs (supporting HS256 symmetric and ES256/RS256 JWKS asymmetric keys).
 * Extracts user ID (sub) and looks up the profile role from the DB.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKeyProvider: getSecretOrPublicKey,
      algorithms: ['HS256', 'RS256', 'ES256', 'HS384', 'HS512', 'RS384', 'RS512', 'ES384', 'ES512'],
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
