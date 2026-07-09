import { Injectable } from '@nestjs/common';
import { createClient, type User } from '@supabase/supabase-js';

/**
 * Thin injectable wrapper over the Supabase service-role admin API
 * (`auth.admin.*`). Isolated here so the auth-override admin routes depend on
 * a small, mockable surface in unit tests rather than instantiating the real
 * client (precedent: storage.service.ts creates the same service-role client
 * inline — we do NOT refactor that; this is a separate seam for auth ops).
 *
 * SECURITY: SUPABASE_SERVICE_ROLE_KEY is a full-access key — it is read from
 * env and handed straight to createClient. It is never logged, echoed, or
 * returned in any response.
 */
@Injectable()
export class SupabaseAdminService {
  private readonly client: ReturnType<typeof createClient>;

  constructor() {
    this.client = createClient(
      process.env.SUPABASE_URL || 'http://localhost:54321',
      process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy_key',
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
  }

  /** Lifts a Supabase auth ban/lock (or applies one) on a user. */
  updateUserById(
    id: string,
    attributes: { ban_duration?: string },
  ): Promise<{
    data: { user: User | null };
    error: { message: string } | null;
  }> {
    return this.client.auth.admin.updateUserById(id, attributes);
  }

  /** Fetches an auth user (for their email) by id. */
  getUserById(id: string): Promise<{
    data: { user: User | null };
    error: { message: string } | null;
  }> {
    return this.client.auth.admin.getUserById(id);
  }

  /** Generates a password-recovery action link for the given email. */
  generateLink(params: { type: 'recovery'; email: string }): Promise<{
    data: { properties: { action_link: string } | null };
    error: { message: string } | null;
  }> {
    return this.client.auth.admin.generateLink(params);
  }
}
