import {
  InsufficientFundsError,
  NegativeBalanceOnReversalError,
  ValidationError,
} from '../errors/domain-errors';
import type { Currency } from './currency';
import type { Money } from './money';

export interface OpenWalletParams {
  id: string;
  playerId: string;
  currency: Currency;
  initialBalance: Money;
  now: Date;
}

export interface RehydrateWalletParams {
  id: string;
  playerId: string;
  currency: Currency;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Aggregate Root da carteira.
 *
 * Invariantes:
 * - Saldo nunca é negativo (garantido por `Money` e pelas checagens de débito).
 * - `version` inicia em 1 (inclusive com saldo inicial > 0) e sobe +1 a cada mutação,
 *   servindo de base para controle de concorrência otimista.
 */
export class Wallet {
  readonly id: string;
  readonly playerId: string;
  readonly currency: Currency;
  readonly createdAt: Date;
  private _balance: Money;
  private _version: number;
  private _updatedAt: Date;

  private constructor(p: RehydrateWalletParams) {
    this.id = p.id;
    this.playerId = p.playerId;
    this.currency = p.currency;
    this._balance = p.balance;
    this._version = p.version;
    this.createdAt = p.createdAt;
    this._updatedAt = p.updatedAt;
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  static open(params: OpenWalletParams): Wallet {
    Wallet.assertIdentity(params.id, params.playerId);
    return new Wallet({
      id: params.id,
      playerId: params.playerId,
      currency: params.currency,
      balance: params.initialBalance,
      version: 1,
      createdAt: params.now,
      updatedAt: params.now,
    });
  }

  static rehydrate(params: RehydrateWalletParams): Wallet {
    Wallet.assertIdentity(params.id, params.playerId);
    if (!Number.isInteger(params.version) || params.version < 1) {
      throw new ValidationError('version da carteira deve ser inteiro >= 1');
    }
    return new Wallet(params);
  }

  canDebit(amount: Money): boolean {
    return this._balance.compare(amount) >= 0;
  }

  /** Débito comum (ex: BET). Falta de saldo gera `InsufficientFundsError`. */
  debit(amount: Money, now: Date): void {
    Wallet.assertPositive(amount);
    if (!this.canDebit(amount)) {
      throw new InsufficientFundsError();
    }
    this.apply(this._balance.subtract(amount), now);
  }

  /**
   * Débito decorrente de reversão de WIN/REFUND. Se deixaria saldo negativo,
   * falha com `NegativeBalanceOnReversalError` (código distinto de saldo insuficiente).
   */
  debitForReversal(amount: Money, now: Date): void {
    Wallet.assertPositive(amount);
    if (!this.canDebit(amount)) {
      throw new NegativeBalanceOnReversalError();
    }
    this.apply(this._balance.subtract(amount), now);
  }

  credit(amount: Money, now: Date): void {
    Wallet.assertPositive(amount);
    this.apply(this._balance.add(amount), now);
  }

  /** Aplica novo saldo, incrementa a versão e atualiza `updatedAt`. */
  private apply(newBalance: Money, now: Date): void {
    this._balance = newBalance;
    this._version += 1;
    this._updatedAt = now;
  }

  private static assertPositive(amount: Money): void {
    if (!amount.isPositive()) {
      throw new ValidationError('Operação na carteira exige amount estritamente positivo');
    }
  }

  private static assertIdentity(id: string, playerId: string): void {
    if (id.trim() === '') {
      throw new ValidationError('id da carteira não pode ser vazio');
    }
    if (playerId.trim() === '') {
      throw new ValidationError('playerId não pode ser vazio');
    }
  }
}

