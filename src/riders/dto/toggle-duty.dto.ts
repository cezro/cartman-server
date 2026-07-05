import { IsBoolean } from 'class-validator';

/**
 * Body for PATCH /riders/me/duty and PATCH /riders/:id/activate. Mirrors
 * `_api.patch('/riders/me/duty', body: {'is_active': active})` in
 * SupabaseRiderDispatchRepository.setDuty (packages/core/lib/src/data/
 * supabase_repositories.dart).
 */
export class ToggleDutyDto {
  @IsBoolean()
  is_active!: boolean;
}
