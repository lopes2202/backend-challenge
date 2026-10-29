import { FailureCode } from './failure-code';

/** Erro base do domínio. `failureCode` é opcional: só falhas de negócio mapeadas o possuem. */
export class DomainError extends Error {
  constructor(
    message: string,
    public readonly failureCode?: FailureCode,
  ) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Entrada inválida (formato, tipo ou intervalo). */
export class ValidationError extends DomainError {}

export class WalletNotFoundError extends DomainError {
  constructor(walletId: string) {
    super(`Carteira não encontrada: ${walletId}`);
  }
}

export class TransactionNotFoundError extends DomainError {
  constructor(reference: string) {
    super(`Transação não encontrada: ${reference}`);
  }
}

export class WalletAlreadyExistsError extends DomainError {
  constructor(walletId: string) {
    super(`Carteira já existe: ${walletId}`);
  }
}

/** Moeda da operação difere da moeda da carteira. */
export class WalletCurrencyMismatchError extends DomainError {
  constructor(walletCurrency: string, operationCurrency: string) {
    super(
      `Moeda da operação (${operationCurrency}) difere da moeda da carteira (${walletCurrency})`,
      FailureCode.CURRENCY_MISMATCH,
    );
  }
}

/** Carteira não pertence ao jogador informado. */
export class WalletPlayerMismatchError extends DomainError {
  constructor(walletId: string, playerId: string) {
    super(`Carteira ${walletId} não pertence ao jogador ${playerId}`);
  }
}

/** Mesma chave de idempotência reutilizada com payload diferente. */
export class IdempotencyConflictError extends DomainError {
  constructor(key: string) {
    super(`Conflito de idempotência: chave ${key} já usada com payload distinto`);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor(message = 'Saldo insuficiente') {
    super(message, FailureCode.INSUFFICIENT_FUNDS);
  }
}

/** Estorno deixaria o saldo negativo. */
export class NegativeBalanceOnReversalError extends DomainError {
  constructor(message = 'Estorno resultaria em saldo negativo') {
    super(message, FailureCode.NEGATIVE_BALANCE_ON_REVERSAL);
  }
}
