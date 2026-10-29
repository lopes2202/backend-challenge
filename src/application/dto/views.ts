import type { MoneyProps } from '../../domain/models/money';
import type { Wallet } from '../../domain/models/wallet';
import type { WalletLedgerEntry } from '../../domain/models/wallet-ledger-entry';
import type { WagerTransaction } from '../../domain/models/wager-transaction';

export interface WalletView {
  id: string;
  walletId: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TransactionView {
  id: string;
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  type: string;
  money: MoneyProps;
  status: string;
  failureCode: string | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  balance: MoneyProps;
  idempotentReplay: boolean;
  createdAt: string;
  resolvedAt: string | null;
}

export interface LedgerEntryView {
  entryId: string;
  walletId: string;
  transactionId: string;
  type: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  sequence: string;
  createdAt: string;
}

export interface LedgerPageView {
  walletId: string;
  entries: LedgerEntryView[];
  nextCursor: string | null;
}

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
  checkedAt: string;
}

export function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    walletId: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toProps(wallet.currency),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

/** `kind` e `type` carregam o mesmo valor (compatibilidade com o contrato da especificação). */
export function toTransactionView(tx: WagerTransaction, idempotentReplay: boolean): TransactionView {
  return {
    id: tx.id,
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.type,
    type: tx.type,
    money: tx.amount.toProps(tx.currency),
    status: tx.status,
    failureCode: tx.failureCode,
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    referenceTransactionId: tx.referenceTransactionId,
    balance: tx.balanceAfter.toProps(tx.currency),
    idempotentReplay,
    createdAt: tx.createdAt.toISOString(),
    resolvedAt: tx.resolvedAt?.toISOString() ?? null,
  };
}

export function toLedgerEntryView(entry: WalletLedgerEntry): LedgerEntryView {
  return {
    entryId: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    type: entry.entryType,
    direction: entry.direction,
    money: entry.money,
    balanceBefore: entry.balanceBefore.toProps(entry.currency),
    balanceAfter: entry.balanceAfter.toProps(entry.currency),
    sequence: (entry.sequence ?? '').toString(),
    createdAt: entry.createdAt.toISOString(),
  };
}

