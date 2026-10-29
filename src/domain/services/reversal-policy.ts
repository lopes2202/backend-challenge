import { FailureCode } from '../errors/failure-code';
import type { Currency } from '../models/currency';
import type { Money } from '../models/money';
import { LedgerDirection } from '../models/wallet-ledger-entry';
import { WagerTransactionType, type WagerTransaction } from '../models/wager-transaction';

export interface ReversalRequest {
  type: WagerTransactionType.REFUND | WagerTransactionType.ROLLBACK;
  providerId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  currency: Currency;
  amount: Money;
}

export type ReversalDecision =
  | { outcome: 'NOT_YET_AVAILABLE' }
  | { outcome: 'REJECT'; failureCode: FailureCode }
  | { outcome: 'OK'; direction: LedgerDirection; reference: WagerTransaction };

const reject = (failureCode: FailureCode): ReversalDecision => ({ outcome: 'REJECT', failureCode });

/**
 * Avalia se um REFUND/ROLLBACK pode ser aplicado sobre a transação de referência.
 *
 * Ordem das checagens (a primeira que falhar decide):
 * 1. Referência ausente ou pendente: NOT_YET_AVAILABLE (permite chegada fora de ordem).
 * 2. Referência rejeitada ou de outro provider/player/wallet/round: REFERENCE_NOT_FOUND.
 * 3. Tipo inválido: INVALID_REFERENCE_KIND (REFUND só reverte BET; ROLLBACK reverte BET/WIN/REFUND).
 * 4. Moeda diferente: CURRENCY_MISMATCH. Valor diferente: AMOUNT_MISMATCH.
 * 5. Já revertida: REFERENCE_ALREADY_REVERSED.
 *
 * Direção do lançamento: reverter BET devolve saldo (CREDIT); reverter WIN/REFUND retira (DEBIT).
 */
export function evaluateReversal(
  request: ReversalRequest,
  reference: WagerTransaction | null,
  alreadyReversed: boolean,
): ReversalDecision {
  if (!reference || reference.isPending()) {
    return { outcome: 'NOT_YET_AVAILABLE' };
  }
  if (reference.isRejected()) {
    return reject(FailureCode.REFERENCE_NOT_FOUND);
  }
  if (
    reference.providerId !== request.providerId ||
    reference.playerId !== request.playerId ||
    reference.walletId !== request.walletId ||
    reference.roundId !== request.roundId
  ) {
    return reject(FailureCode.REFERENCE_NOT_FOUND);
  }

  const kind = reference.type;
  const kindAllowed =
    request.type === WagerTransactionType.REFUND
      ? kind === WagerTransactionType.BET
      : kind === WagerTransactionType.BET ||
        kind === WagerTransactionType.WIN ||
        kind === WagerTransactionType.REFUND;
  if (!kindAllowed) {
    return reject(FailureCode.INVALID_REFERENCE_KIND);
  }

  if (reference.currency !== request.currency) {
    return reject(FailureCode.CURRENCY_MISMATCH);
  }
  if (!reference.amount.equals(request.amount)) {
    return reject(FailureCode.AMOUNT_MISMATCH);
  }
  if (alreadyReversed) {
    return reject(FailureCode.REFERENCE_ALREADY_REVERSED);
  }

  const direction =
    kind === WagerTransactionType.BET ? LedgerDirection.CREDIT : LedgerDirection.DEBIT;
  return { outcome: 'OK', direction, reference };
}

