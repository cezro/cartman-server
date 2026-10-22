import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateTransactionDto } from './create-transaction.dto';

describe('CreateTransactionDto', () => {
  const body = {
    rider_id: '11111111-1111-4111-8111-111111111111',
    type: 'credit_remittance',
    amount: 200000,
  };

  it('accepts a whole, positive centavo amount', async () => {
    expect(
      await validate(plainToInstance(CreateTransactionDto, body)),
    ).toHaveLength(0);
  });

  // The sign comes from `type`: a negative remittance would deepen the very
  // lockout it is meant to clear.
  it.each([-200000, 0, 1999.5])('refuses amount %p', async (amount) => {
    const errors = await validate(
      plainToInstance(CreateTransactionDto, { ...body, amount }),
    );
    expect(errors.map((e) => e.property)).toContain('amount');
  });
});
