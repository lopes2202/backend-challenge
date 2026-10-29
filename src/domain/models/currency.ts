import { ValidationError } from '../errors/domain-errors';

/** Código de moeda ISO-4217 (3 letras maiúsculas). */
export type Currency = string & { readonly __brand: 'Currency' };

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Valida e retorna o código de moeda; lança `ValidationError` se inválido. */
export function parseCurrency(value: unknown): Currency {
  if (typeof value !== 'string' || !CURRENCY_PATTERN.test(value)) {
    throw new ValidationError(
      `Moeda inválida: esperado código ISO-4217 de 3 letras maiúsculas (ex: "BRL")`,
    );
  }
  return value as Currency;
}
