import { Injectable, Logger } from '@nestjs/common';
import { createSign } from 'node:crypto';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export interface FcmSendResult {
  ok: boolean;
  /** True when FCM says the token is dead (UNREGISTERED / NOT_FOUND) — the
   * caller should prune it from device_tokens. */
  unregistered: boolean;
}

/**
 * FCM HTTP v1 transport (cartman-server-endpoints.md §7) with no
 * firebase-admin dependency: the service-account OAuth2 JWT-bearer exchange
 * is hand-rolled with node:crypto + fetch. Credentials live in server env
 * (FCM_PROJECT_ID / FCM_CLIENT_EMAIL / FCM_PRIVATE_KEY) — never in an app
 * bundle. WebhooksService owns *who* gets notified; this class only mints
 * tokens and sends single messages.
 */
@Injectable()
export class FcmService {
  private readonly logger = new Logger(FcmService.name);
  private cachedToken: { value: string; expiresAtMs: number } | null = null;

  isConfigured(): boolean {
    return Boolean(
      process.env.FCM_PROJECT_ID &&
      process.env.FCM_CLIENT_EMAIL &&
      process.env.FCM_PRIVATE_KEY,
    );
  }

  async sendToToken(
    token: string,
    notification: { title: string; body: string },
    data?: Record<string, string>,
  ): Promise<FcmSendResult> {
    const accessToken = await this.getAccessToken();

    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${process.env.FCM_PROJECT_ID}/messages:send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: { token, notification, ...(data ? { data } : {}) },
        }),
      },
    );

    if (res.ok) return { ok: true, unregistered: false };

    const body = (await res.json().catch(() => ({}))) as {
      error?: { status?: string; details?: Array<{ errorCode?: string }> };
    };
    const status = body.error?.status;
    const errorCode = body.error?.details?.find((d) => d.errorCode)?.errorCode;
    const unregistered =
      res.status === 404 ||
      status === 'NOT_FOUND' ||
      errorCode === 'UNREGISTERED';

    if (!unregistered) {
      this.logger.warn(
        `FCM send failed: HTTP ${res.status} ${status ?? ''} ${errorCode ?? ''}`,
      );
    }
    return { ok: false, unregistered };
  }

  // OAuth2 service-account flow: sign a JWT with the service account's RSA
  // key, exchange it for a ~1h access token, cache with a 60s safety margin.
  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && now < this.cachedToken.expiresAtMs) {
      return this.cachedToken.value;
    }

    const iat = Math.floor(now / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(
      JSON.stringify({
        iss: process.env.FCM_CLIENT_EMAIL,
        scope: FCM_SCOPE,
        aud: OAUTH_TOKEN_URL,
        iat,
        exp: iat + 3600,
      }),
    );
    const signingInput = `${header}.${claims}`;
    const signature = createSign('RSA-SHA256')
      .update(signingInput)
      // Env editors (Render dashboard etc.) often store the PEM with literal
      // \n sequences — normalize before signing; a real multi-line PEM is
      // untouched.
      .sign((process.env.FCM_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'));
    const assertion = `${signingInput}.${base64url(signature)}`;

    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`FCM OAuth token exchange failed: HTTP ${res.status}`);
    }
    const tokenBody = (await res.json()) as {
      access_token: string;
      expires_in?: number;
    };

    this.cachedToken = {
      value: tokenBody.access_token,
      expiresAtMs: now + ((tokenBody.expires_in ?? 3600) - 60) * 1000,
    };
    return tokenBody.access_token;
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
