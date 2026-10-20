import { IsISO8601, IsOptional } from 'class-validator';

/**
 * Query for GET /riders/me/history.
 *
 * Without `since` the route returns the rider's 20 most recent deliveries —
 * the list the history screens show. With it, every delivery earned on or
 * after that instant, which is what the rider app's "Last 7 days" chart sums:
 * a busy rider passes 20 deliveries well inside a week, and a chart summed
 * from the capped list undercounts their earnings.
 */
export class DeliveryHistoryQueryDto {
  @IsOptional()
  @IsISO8601()
  since?: string;
}
