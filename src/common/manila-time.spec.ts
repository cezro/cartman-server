import { manilaMidnightUtc } from './manila-time';

describe('manilaMidnightUtc', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("Manila midday (2026-07-05T04:00:00Z == 12:00 Manila) resolves to that Manila day's midnight in UTC", () => {
    const now = new Date('2026-07-05T04:00:00.000Z');
    const result = manilaMidnightUtc(now);
    expect(result.toISOString()).toBe('2026-07-04T16:00:00.000Z');
  });

  it("23:30 UTC (== 07:30 Manila the next day) resolves to that next Manila day's midnight", () => {
    const now = new Date('2026-07-04T23:30:00.000Z');
    const result = manilaMidnightUtc(now);
    // 2026-07-04T23:30Z is already 2026-07-05 in Manila time, so the
    // boundary is 2026-07-05T00:00 Manila == 2026-07-04T16:00:00Z.
    expect(result.toISOString()).toBe('2026-07-04T16:00:00.000Z');
  });

  it('exactly 16:00 UTC (== Manila midnight) is a fixed point — returns itself', () => {
    const now = new Date('2026-07-05T16:00:00.000Z');
    const result = manilaMidnightUtc(now);
    expect(result.toISOString()).toBe('2026-07-05T16:00:00.000Z');
  });

  it('defaults to the current instant when no argument is passed', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-05T04:00:00.000Z'));

    const result = manilaMidnightUtc();
    expect(result.toISOString()).toBe('2026-07-04T16:00:00.000Z');
  });
});
