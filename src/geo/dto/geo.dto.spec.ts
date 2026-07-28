import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { GeoReverseQueryDto, GeoSearchQueryDto } from './geo.dto';

describe('GeoSearchQueryDto', () => {
  it('accepts a 3-character query and defaults limit to 5', async () => {
    const dto = plainToInstance(GeoSearchQueryDto, { q: 'iso' });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(5);
  });

  it('rejects a query shorter than 3 characters', async () => {
    // Below 3 the upstream returns near-noise, so every keystroke would be a
    // billable request for a result nobody picks.
    const dto = plainToInstance(GeoSearchQueryDto, { q: 'sm' });
    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a missing query', async () => {
    const dto = plainToInstance(GeoSearchQueryDto, {});
    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
  });

  it('coerces string lat/lng/limit as Express hands them in', async () => {
    const dto = plainToInstance(GeoSearchQueryDto, {
      q: 'sm city',
      lat: '10.7128',
      lng: '122.5474',
      limit: '8',
    });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.lat).toBe(10.7128);
    expect(dto.lng).toBe(122.5474);
    expect(dto.limit).toBe(8);
  });

  it('allows lat/lng to be omitted entirely', async () => {
    const dto = plainToInstance(GeoSearchQueryDto, { q: 'sm city' });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects an out-of-range latitude', async () => {
    const dto = plainToInstance(GeoSearchQueryDto, { q: 'sm city', lat: '91' });
    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a limit above 10', async () => {
    const dto = plainToInstance(GeoSearchQueryDto, {
      q: 'sm city',
      limit: '11',
    });
    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('GeoReverseQueryDto', () => {
  it('accepts and coerces a valid coordinate pair', async () => {
    const dto = plainToInstance(GeoReverseQueryDto, {
      lat: '10.7128',
      lng: '122.5474',
    });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.lat).toBe(10.7128);
    expect(dto.lng).toBe(122.5474);
  });

  it('requires both lat and lng', async () => {
    const errors = await validate(
      plainToInstance(GeoReverseQueryDto, { lat: '10.7128' }),
    );

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an out-of-range longitude', async () => {
    const errors = await validate(
      plainToInstance(GeoReverseQueryDto, { lat: '10.7', lng: '181' }),
    );

    expect(errors.length).toBeGreaterThan(0);
  });
});
