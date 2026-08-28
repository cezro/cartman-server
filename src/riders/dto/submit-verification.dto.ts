import { IsIn, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

/**
 * Document types a rider may file. Closed rather than free text because the
 * value is what the admin queue sorts and labels by — a typo there is a review
 * that never gets looked at under the heading someone is scanning for.
 */
export const RIDER_DOCUMENT_TYPES = [
  'Rider ID',
  'Driver License',
  'OR/CR',
  'Barangay Clearance',
] as const;

/**
 * Body for POST /riders/me/verification — the rider attaching a document to
 * their own open review.
 *
 * `document_url` points at an object already uploaded through
 * `POST /storage/upload`; this route stores the reference and does not accept
 * the file itself, so a large or malicious upload is rejected by the storage
 * route's own limits rather than here.
 *
 * Validated as a URL because the admin dashboard renders it as an `<img src>`
 * and falls back to a placeholder for anything that is not `http`-prefixed —
 * an unvalidated string would reach an admin as a silently blank document
 * pane, which reads as "nothing submitted" rather than as an error.
 */
export class SubmitVerificationDto {
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  document_url!: string;

  @IsOptional()
  @IsString()
  @IsIn(RIDER_DOCUMENT_TYPES)
  document_type?: (typeof RIDER_DOCUMENT_TYPES)[number];
}
