import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { PaginationQueryDto } from './pagination-query.dto';

describe('PaginationQueryDto', () => {
  it('defaults limit to 20 and offset to 0 when neither is provided', async () => {
    const dto = plainToInstance(PaginationQueryDto, {});
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(20);
    expect(dto.offset).toBe(0);
  });

  it('accepts string query values (as Express/Nest hand them in) and coerces to number', async () => {
    const dto = plainToInstance(PaginationQueryDto, {
      limit: '50',
      offset: '10',
    });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(50);
    expect(dto.offset).toBe(10);
  });

  it('rejects limit above 100', async () => {
    const dto = plainToInstance(PaginationQueryDto, { limit: '101' });
    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects limit below 1', async () => {
    const dto = plainToInstance(PaginationQueryDto, { limit: '0' });
    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a negative offset', async () => {
    const dto = plainToInstance(PaginationQueryDto, { offset: '-1' });
    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects non-integer limit', async () => {
    const dto = plainToInstance(PaginationQueryDto, { limit: '5.5' });
    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
  });
});
