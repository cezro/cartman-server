import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AdminOrdersQueryDto } from './admin.dto';

describe('AdminOrdersQueryDto', () => {
  it('splits a CSV status query param into an array', async () => {
    const dto = plainToInstance(AdminOrdersQueryDto, {
      status: 'pending,ready_for_pickup,delivered',
    });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.status).toEqual(['pending', 'ready_for_pickup', 'delivered']);
  });

  it('accepts a single status value with no comma', async () => {
    const dto = plainToInstance(AdminOrdersQueryDto, { status: 'delivered' });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.status).toEqual(['delivered']);
  });

  it('rejects a status value that is not in the order_status enum', async () => {
    const dto = plainToInstance(AdminOrdersQueryDto, {
      status: 'pending,not_a_real_status',
    });
    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an invalid order type', async () => {
    const dto = plainToInstance(AdminOrdersQueryDto, { type: 'not_a_type' });
    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts a valid order type', async () => {
    const dto = plainToInstance(AdminOrdersQueryDto, { type: 'food' });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('rejects a non-UUID rider_id/customer_id/merchant_id', async () => {
    const dto = plainToInstance(AdminOrdersQueryDto, { rider_id: 'nope' });
    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts valid UUID filters alongside inherited pagination defaults', async () => {
    const dto = plainToInstance(AdminOrdersQueryDto, {
      rider_id: '123e4567-e89b-12d3-a456-426614174000',
      customer_id: '223e4567-e89b-12d3-a456-426614174001',
      merchant_id: '323e4567-e89b-12d3-a456-426614174002',
    });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(20);
    expect(dto.offset).toBe(0);
  });
});
