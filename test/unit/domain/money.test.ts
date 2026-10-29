import { describe, expect, test } from 'bun:test';
import { ValidationError } from '../../../src/domain/errors/domain-errors';
import { parseCurrency } from '../../../src/domain/models/currency';
import { Money } from '../../../src/domain/models/money';

describe('Money', () => {
  test('soma sem erro de ponto flutuante (0.10 + 0.20 == 0.30)', () => {
    const result = Money.fromString('0.10').add(Money.fromString('0.20'));
    expect(result.toString()).toBe('0.30');
    expect(result.equals(Money.fromString('0.30'))).toBe(true);
  });

  test('rejeita number nativo em tempo de execução', () => {
    expect(() => Money.fromString(10.5 as unknown as string)).toThrow(ValidationError);
    expect(() => Money.fromString(0 as unknown as string)).toThrow(ValidationError);
  });

  test.each(['10', '10.5', '10.123', '1,50', '-5.00', 'NaN'])(
    'rejeita string malformada "%s"',
    (input) => {
      expect(() => Money.fromString(input)).toThrow(ValidationError);
    },
  );

  test('rejeita valor acima do limite de NUMERIC(18,2)', () => {
    expect(() => Money.fromString('10000000000000000.00')).toThrow(ValidationError);
    expect(Money.fromString('9999999999999999.99').toString()).toBe('9999999999999999.99');
  });

  test('subtract não permite resultado negativo', () => {
    expect(() => Money.fromString('1.00').subtract(Money.fromString('1.01'))).toThrow(
      ValidationError,
    );
    expect(Money.fromString('1.00').subtract(Money.fromString('0.01')).toString()).toBe('0.99');
  });

  test('positive, nonNegative, zero, compare e isZero', () => {
    expect(() => Money.positive('0.00')).toThrow(ValidationError);
    expect(Money.positive('0.01').isPositive()).toBe(true);
    expect(Money.nonNegative('0.00').isZero()).toBe(true);
    expect(Money.zero().toString()).toBe('0.00');
    expect(Money.fromString('2.00').compare(Money.fromString('1.00'))).toBe(1);
    expect(Money.fromString('1.00').compare(Money.fromString('2.00'))).toBe(-1);
    expect(Money.fromString('1.00').compare(Money.fromString('1.00'))).toBe(0);
  });

  test('serializa para MoneyProps e reconstrói via fromProps', () => {
    const currency = parseCurrency('BRL');
    const props = Money.fromString('25.00').toProps(currency);
    expect(props).toEqual({ amount: '25.00', currency: parseCurrency('BRL') });
    expect(Money.fromProps(props).equals(Money.fromString('25.00'))).toBe(true);
  });
});

describe('Currency', () => {
  test('aceita ISO-4217 e rejeita inválidas', () => {
    expect(parseCurrency('USD')).toBe(parseCurrency('USD'));
    for (const bad of ['usd', 'US', 'USDT', '', 'U1D', 123]) {
      expect(() => parseCurrency(bad)).toThrow(ValidationError);
    }
  });
});
