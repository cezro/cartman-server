import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { SendOtpDto, VerifyOtpDto } from './otp.dto';

describe('SendOtpDto phone normalization', () => {
  it('normalizes 0917 123 4567 (with spaces) to +639171234567', async () => {
    const dto = plainToInstance(SendOtpDto, { phone: '0917 123 4567' });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.phone).toBe('+639171234567');
  });

  it('normalizes 639171234567 to +639171234567', async () => {
    const dto = plainToInstance(SendOtpDto, { phone: '639171234567' });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.phone).toBe('+639171234567');
  });

  it('normalizes 0917-123-4567 (with dashes) to +639171234567', async () => {
    const dto = plainToInstance(SendOtpDto, { phone: '0917-123-4567' });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.phone).toBe('+639171234567');
  });

  it('leaves an already-normalized +639171234567 unchanged', async () => {
    const dto = plainToInstance(SendOtpDto, { phone: '+639171234567' });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.phone).toBe('+639171234567');
  });

  it('rejects garbage input like 12345', async () => {
    const dto = plainToInstance(SendOtpDto, { phone: '12345' });
    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
    expect(
      errors.some((e) =>
        Object.values(e.constraints ?? {}).some((msg) =>
          msg.includes('Phone must be a Philippine mobile number'),
        ),
      ),
    ).toBe(true);
  });

  it('rejects a non-PH international number like +4479...', async () => {
    const dto = plainToInstance(SendOtpDto, { phone: '+447911123456' });
    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
    expect(
      errors.some((e) =>
        Object.values(e.constraints ?? {}).some((msg) =>
          msg.includes('Phone must be a Philippine mobile number'),
        ),
      ),
    ).toBe(true);
  });
});

describe('VerifyOtpDto phone normalization', () => {
  it('normalizes phone the same way as SendOtpDto', async () => {
    const dto = plainToInstance(VerifyOtpDto, {
      phone: '0917 123 4567',
      code: '123456',
    });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.phone).toBe('+639171234567');
  });
});
