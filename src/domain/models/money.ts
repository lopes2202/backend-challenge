import Decimal from 'decimal.js';
import { ValidationError } from '../errors/domain-errors';
import { parseCurrency, type Currency } from './currency';

export interface MoneyProps {
  amount: string;
  currency: Currency;
}

/** Exatamente 2 casas decimais, sem sinal, sem separador de milhar. */
const AMOUNT_PATTERN = /^\d+\.\d{2}$/;

/** Máximo de NUMERIC(18,2): 16 dígitos inteiros + 2 decimais. */
const MAX_AMOUNT = new Decimal('9999999999999999.99');

/**
 * Valor monetário imutável, sempre não negativo, com 2 casas decimais.
 * Usa `decimal.js` internamente para evitar erros de ponto flutuante.
 */
export class Money {
  private constructor(private readonly value: Decimal) {}

  /** Cria a partir de string decimal estrita (`"25.00"`). Rejeita qualquer outro tipo. */
  static fromString(amount: string): Money {
    if (typeof amount !== 'string') {
      throw new ValidationError('Valor monetário deve ser uma string decimal, nunca number');
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new ValidationError(
        `Valor monetário inválido: esperado formato "0.00" (2 casas decimais), recebido "${amount}"`,
      );
    }
    return Money.fromDecimal(new Decimal(amount));
  }

  static fromProps(props: MoneyProps): Money {
    parseCurrency(props.currency);
    return Money.fromString(props.amount);
  }

  static zero(): Money {
    return new Money(new Decimal(0));
  }

  /** Exige valor estritamente maior que zero. */
  static positive(amount: string): Money {
    const money = Money.fromString(amount);
    if (!money.isPositive()) {
      throw new ValidationError('Valor monetário deve ser maior que zero');
    }
    return money;
  }

  /** Exige valor maior ou igual a zero (garantido pelo formato; explícito por clareza). */
  static nonNegative(amount: string): Money {
    return Money.fromString(amount);
  }

  private static fromDecimal(value: Decimal): Money {
    if (value.isNegative()) {
      throw new ValidationError('Valor monetário não pode ser negativo');
    }
    if (value.greaterThan(MAX_AMOUNT)) {
      throw new ValidationError('Valor monetário excede o limite de NUMERIC(18,2)');
    }
    return new Money(value);
  }

  add(other: Money): Money {
    return Money.fromDecimal(this.value.plus(other.value));
  }

  /** Subtração; resultado negativo não é permitido e lança `ValidationError`. */
  subtract(other: Money): Money {
    const result = this.value.minus(other.value);
    if (result.isNegative()) {
      throw new ValidationError('Subtração resultaria em valor negativo');
    }
    return Money.fromDecimal(result);
  }

  equals(other: Money): boolean {
    return this.value.equals(other.value);
  }

  /** Retorna -1, 0 ou 1. */
  compare(other: Money): -1 | 0 | 1 {
    return this.value.comparedTo(other.value) as -1 | 0 | 1;
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  /** Sempre com 2 casas decimais (ex: `"0.00"`). */
  toString(): string {
    return this.value.toFixed(2);
  }

  toProps(currency: Currency): MoneyProps {
    return { amount: this.toString(), currency };
  }
}
