import { Logger } from '@nestjs/common';

/** How long one send may take before it counts as a failure and is retried. */
const PUSH_SEND_TIMEOUT_MS = 10_000;

/** One queued notification, in the shape `push-send` expects as its body. */
export interface PushPayload {
  user_id: string;
  title: string;
  body: string | null;
  data: unknown;
}

/**
 * Success means **`push-send` accepted the row**, not that a handset buzzed.
 * The function answers 200 with `sent: 0` when the Firebase credentials are
 * missing or the user has no device tokens, and that is deliberately a success
 * here: retrying it would never start working, and the outbox would fill with
 * rows nothing can drain. Delivery to the device is FCM's problem and is
 * visible in `push-send`'s own response, not in this queue.
 */
export type SendResult = { ok: true } | { ok: false; error: string };

/** The seam the drainer depends on, so its tests never touch the network. */
export interface PushSender {
  send(payload: PushPayload): Promise<SendResult>;
}

/**
 * Injection token for [PushSender]. An interface has no runtime identity, so
 * the module binds this symbol to a client — or to `null` when the environment
 * has no service-role key, which is what lets the app boot without one.
 */
export const PUSH_SENDER = Symbol('PUSH_SENDER');

/**
 * Posts one queued notification to the `push-send` Edge Function.
 *
 * The service-role key is required because `push-send` reads `device_tokens`
 * for an arbitrary user — this codebase already holds that key, which is the
 * whole reason the drainer lives here rather than as pg_cron + pg_net (a key
 * in a migration is a key in git; see 20260810000200's header).
 */
export class PushSendClient implements PushSender {
  private readonly logger = new Logger(PushSendClient.name);
  private readonly endpoint: string;

  constructor(
    supabaseUrl: string,
    private readonly serviceRoleKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    // A URL pasted from a dashboard very often carries a trailing slash, and
    // `//functions/v1/push-send` 404s.
    this.endpoint = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/push-send`;
  }

  async send(payload: PushPayload): Promise<SendResult> {
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(PUSH_SEND_TIMEOUT_MS),
    });

    if (!res.ok) {
      // push-send's own `{ error }` distinguishes a malformed row from a dead
      // function, which the status alone cannot. Truncated because this lands
      // in `last_error` — a column an admin reads — and a proxy's HTML error
      // page should not become a 5KB cell.
      const detail = await res.text().catch(() => '');
      const error = `push-send ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
      this.logger.warn(error);
      return { ok: false, error };
    }

    return { ok: true };
  }
}
