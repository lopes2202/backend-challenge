import { ValidationError } from '../errors/domain-errors';
import type { Currency } from './currency';
import type { Money, MoneyProps } from './money';

export enum LedgerDirection {
  CREDIT = 'CREDIT',
  DEBIT = 'DEBIT',
}

interface LedgerEntryBase {
  id: string;
  walletId: string;
  transactionId: string;
  entryType: string;
  direction: LedgerDirection;
  amount: Money;
  currency: Currency;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type CreateLedgerEntryParams = LedgerEntryBase;

export interface RehydrateLedgerEntryParams extends LedgerEntryBase {
  sequence: bigint | number | null;
}

/**
 * Lançamento imutável do ledger (append-only).
 *
 * Invariantes:
 * - `amount` é estritamente positivo; o sentido é dado por `direction`.
 * - CREDIT: `balanceBefore + amount == balanceAfter`.
 * - DEBIT: `balanceBefore - amount == balanceAfter` (nunca negativo).
 * - `sequence` é nulo até a persistência e só é preenchido na reidratação.
 */
export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly entryType: string;
  readonly direction: LedgerDirection;
  readonly amount: Money;
  readonly currency: Currency;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly sequence: bigint | number | null;
  readonly createdAt: Date;

  private constructor(params: RehydrateLedgerEntryParams) {
    WalletLedgerEntry.assertInvariants(params);
    this.id = params.id;
    this.walletId = params.walletId;
    this.transactionId = params.transactionId;
    this.entryType = params.entryType;
    this.direction = params.direction;
    this.amount = params.amount;
    this.currency = params.currency;
    this.balanceBefore = params.balanceBefore;
    this.balanceAfter = params.balanceAfter;
    this.sequence = params.sequence;
    this.createdAt = params.createdAt;
    // Imutabilidade em runtime.
    Object.freeze(this);
  }

  /** Cria um lançamento novo (ainda sem `sequence`, atribuída pelo banco). */
  static create(params: CreateLedgerEntryParams): WalletLedgerEntry {
    return new WalletLedgerEntry({ ...params, sequence: null });
  }

  /** Reconstrói um lançamento persistido, revalidando as invariantes. */
  static rehydrate(params: RehydrateLedgerEntryParams): WalletLedgerEntry {
    return new WalletLedgerEntry(params);
  }

  get money(): MoneyProps {
    return this.amount.toProps(this.currency);
  }

  private static assertInvariants(p: LedgerEntryBase): void {
    if (!p.amount.isPositive()) {
      throw new ValidationError('Lançamento do ledger exige amount estritamente positivo');
    }
    const equationHolds =
      p.direction === LedgerDirection.CREDIT
        ? p.balanceBefore.add(p.amount).equals(p.balanceAfter)
        : p.balanceBefore.subtract(p.amount).equals(p.balanceAfter);
    if (!equationHolds) {
      throw new ValidationError(
        'Equação do ledger violada: balanceBefore ± amount deve ser igual a balanceAfter',
      );
    }
  }
}

