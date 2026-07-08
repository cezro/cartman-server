import {
  serializeAdminRider,
  serializeAdminMerchant,
  serializeAdminLedgerTxn,
} from './serialize-admin';

// A Prisma Decimal instance behaves like this for our purposes: no numeric
// coercion, only toString(). Number(x) on such an object goes through
// valueOf() (inherited, non-primitive) then toString(), same as the real
// Decimal class.
function fakeDecimal(value: string) {
  return { toString: () => value } as unknown as number;
}

describe('serializeAdminRider', () => {
  it('converts Decimal rating/acceptance_rate to Number', () => {
    const result = serializeAdminRider({
      id: 'r1',
      rating: fakeDecimal('4.75'),
      acceptance_rate: fakeDecimal('0.9'),
    });

    expect(result.rating).toBe(4.75);
    expect(typeof result.rating).toBe('number');
    expect(result.acceptance_rate).toBe(0.9);
  });

  it('converts a BigInt net_cash to Number', () => {
    const result = serializeAdminRider({ id: 'r1', net_cash: -300000n });

    expect(result.net_cash).toBe(-300000);
    expect(typeof result.net_cash).toBe('number');
  });

  it('leaves other fields untouched', () => {
    const result = serializeAdminRider({
      id: 'r1',
      full_name: 'Pedro',
      is_active: true,
    });

    expect(result.full_name).toBe('Pedro');
    expect(result.is_active).toBe(true);
  });
});

describe('serializeAdminMerchant', () => {
  it('converts delivery_fee/min_order BigInt fields to Number', () => {
    const result = serializeAdminMerchant({
      id: 'm1',
      delivery_fee: 3000n,
      min_order: 15000n,
    });

    expect(result.delivery_fee).toBe(3000);
    expect(result.min_order).toBe(15000);
  });

  it('converts Decimal rating to Number', () => {
    const result = serializeAdminMerchant({
      id: 'm1',
      rating: fakeDecimal('4.2'),
    });

    expect(result.rating).toBe(4.2);
  });
});

describe('serializeAdminLedgerTxn', () => {
  it('converts BigInt id and amount to string (ledger wire-shape convention)', () => {
    const result = serializeAdminLedgerTxn({ id: 42n, amount: 5000n });

    expect(result.id).toBe('42');
    expect(typeof result.id).toBe('string');
    expect(result.amount).toBe('5000');
    expect(typeof result.amount).toBe('string');
  });

  it('leaves non-BigInt fields untouched', () => {
    const created = new Date('2026-07-05T00:00:00.000Z');
    const result = serializeAdminLedgerTxn({
      id: 1n,
      amount: 100n,
      type: 'credit_remittance',
      created_at: created,
    });

    expect(result.type).toBe('credit_remittance');
    expect(result.created_at).toBe(created);
  });
});
