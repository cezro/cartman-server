import { formatPeso } from './peso';

describe('formatPeso', () => {
  it('writes pesos and two-digit centavos', () => {
    expect(formatPeso(50000n)).toBe('₱500.00');
    expect(formatPeso(37550n)).toBe('₱375.50');
    expect(formatPeso(5n)).toBe('₱0.05');
    expect(formatPeso(0n)).toBe('₱0.00');
  });

  it('groups thousands, as the apps do', () => {
    expect(formatPeso(200000n)).toBe('₱2,000.00');
    expect(formatPeso(123456789n)).toBe('₱1,234,567.89');
  });
});
