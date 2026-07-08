import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  AdminOrdersQueryDto,
  ReassignOrderDto,
  AdminRidersQueryDto,
  AdminMerchantsQueryDto,
  AdminLedgerQueryDto,
} from './admin.dto';

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

describe('ReassignOrderDto', () => {
  it('requires rider_id to be a UUID', async () => {
    const dto = plainToInstance(ReassignOrderDto, { rider_id: 'not-a-uuid' });
    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a missing rider_id', async () => {
    const dto = plainToInstance(ReassignOrderDto, {});
    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts a valid UUID rider_id', async () => {
    const dto = plainToInstance(ReassignOrderDto, {
      rider_id: '123e4567-e89b-12d3-a456-426614174000',
    });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });
});

describe('AdminRidersQueryDto', () => {
  it('coerces the string "true"/"false" on_duty query param to boolean', async () => {
    const dtoTrue = plainToInstance(AdminRidersQueryDto, { on_duty: 'true' });
    const dtoFalse = plainToInstance(AdminRidersQueryDto, {
      on_duty: 'false',
    });

    expect(await validate(dtoTrue)).toHaveLength(0);
    expect(await validate(dtoFalse)).toHaveLength(0);
    expect(dtoTrue.on_duty).toBe(true);
    expect(dtoFalse.on_duty).toBe(false);
  });

  it('rejects a non-boolean on_duty value', async () => {
    const dto = plainToInstance(AdminRidersQueryDto, { on_duty: 'maybe' });
    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
  });

  it('is optional', async () => {
    const dto = plainToInstance(AdminRidersQueryDto, {});
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.on_duty).toBeUndefined();
  });
});

describe('AdminMerchantsQueryDto', () => {
  it('coerces the string "true"/"false" is_open query param to boolean', async () => {
    const dto = plainToInstance(AdminMerchantsQueryDto, { is_open: 'true' });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.is_open).toBe(true);
  });

  it('rejects a non-boolean is_open value', async () => {
    const dto = plainToInstance(AdminMerchantsQueryDto, { is_open: 'nope' });
    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('AdminLedgerQueryDto', () => {
  it('accepts a valid wallet_txn_type', async () => {
    const dto = plainToInstance(AdminLedgerQueryDto, {
      type: 'debit_cod_order',
    });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('rejects an invalid wallet_txn_type', async () => {
    const dto = plainToInstance(AdminLedgerQueryDto, { type: 'not_a_type' });
    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-UUID rider_id or order_id', async () => {
    const dto = plainToInstance(AdminLedgerQueryDto, { rider_id: 'nope' });
    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts valid UUID rider_id/order_id filters', async () => {
    const dto = plainToInstance(AdminLedgerQueryDto, {
      rider_id: '123e4567-e89b-12d3-a456-426614174000',
      order_id: '223e4567-e89b-12d3-a456-426614174001',
    });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });
});
