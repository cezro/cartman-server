// "Today" across the server means the Philippines calendar day (Asia/Manila,
// UTC+8 fixed — no DST). Manila has no DST, so "Manila midnight" is always
// UTC-minus-8-hours from the naive local wall clock, i.e. computed by taking
// the current instant, shifting it forward 8 hours to read Manila's local
// Y/M/D, then constructing that same Y/M/D at 00:00 UTC and shifting BACK 8
// hours to get the UTC instant of Manila midnight. Concretely:
//   manilaNow = now + 8h
//   manilaMidnightUtc = Date.UTC(manilaNow.Y, manilaNow.M, manilaNow.D) - 8h
//
// Lifted out of LedgerService.getEarningsToday (behavioral no-op there) so
// AdminService's "_today" stats can share the exact same boundary logic.
export function manilaMidnightUtc(now: Date = new Date()): Date {
  const manilaOffsetMs = 8 * 60 * 60 * 1000;
  const manilaNow = new Date(now.getTime() + manilaOffsetMs);
  return new Date(
    Date.UTC(
      manilaNow.getUTCFullYear(),
      manilaNow.getUTCMonth(),
      manilaNow.getUTCDate(),
    ) - manilaOffsetMs,
  );
}
