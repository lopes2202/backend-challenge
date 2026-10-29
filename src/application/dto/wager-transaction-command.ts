import { ValidationError } from '../../domain/errors/domain-errors';
import { parseCurrency, type Currency } from '../../domain/models/currency';
import { Money } from '../../domain/models/money';
import { WagerTransactionType } from '../../domain/models/wager-transaction';
import { canonicalJsonHash } from '../utils/canonical-json-hash';

export type CommandSource = 'HTTP' | 'SQS';

/** Identificação da mensagem SQS, usada na deduplicação via Inbox. */
export interface InboxInfo {
  consumerName: string;
  messageId: string;
}

export interface WagerTransactionCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  type: WagerTransactionType;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  currency: Currency;
  amount: Money;
  referenceExternalTransactionId: string | null;
  source: CommandSource;
  correlationId: string | null;
  inbox?: InboxInfo;
}

export interface ParseContext {
  source: CommandSource;
  /** Header `Idempotency-Key` (HTTP). Obrigatório no HTTP; no SQS há fallback. */
  idempotencyKey?: string | null;
  correlationId?: string | null;
  inbox?: InboxInfo;
}

/** Tipos aceitos de fora; OPENING é interno (criação de carteira). */
const EXTERNAL_TYPES: readonly string[] = [
  WagerTransactionType.BET,
  WagerTransactionType.WIN,
  WagerTransactionType.LOSS,
  WagerTransactionType.REFUND,
  WagerTransactionType.ROLLBACK,
];

export function requireString(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`Campo "${field}" é obrigatório e deve ser string não vazia`);
  }
  return value;
}

export function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`Campo "${field}" deve ser um objeto`);
  }
  return value as Record<string, unknown>;
}

/** Valida `{ amount, currency }` e devolve o par tipado. */
export function parseMoneyInput(value: unknown, field: string): { amount: Money; currency: Currency } {
  const obj = requireObject(value, field);
  return {
    amount: Money.fromString(obj['amount'] as string),
    currency: parseCurrency(obj['currency']),
  };
}

/**
 * Valida o payload de entrada (HTTP ou SQS) e calcula o `payloadHash` sobre os campos de negócio.
 * O hash permite distinguir replay legítimo (mesma chave, mesmo hash) de conflito (hash diferente).
 */
export function parseWagerTransactionCommand(
  body: unknown,
  context: ParseContext,
): WagerTransactionCommand {
  const raw = requireObject(body, 'body');

  const providerId = requireString(raw, 'providerId');
  const externalTransactionId = requireString(raw, 'externalTransactionId');
  const playerId = requireString(raw, 'playerId');
  const walletId = requireString(raw, 'walletId');
  const roundId = requireString(raw, 'roundId');

  // Aceita `kind` ou `type`; se ambos vierem, precisam coincidir.
  const kindRaw = raw['kind'] ?? raw['type'];
  if (raw['kind'] !== undefined && raw['type'] !== undefined && raw['kind'] !== raw['type']) {
    throw new ValidationError('Campos "kind" e "type" divergentes');
  }
  if (typeof kindRaw !== 'string' || !EXTERNAL_TYPES.includes(kindRaw)) {
    throw new ValidationError(`Tipo de transação inválido; esperado um de ${EXTERNAL_TYPES.join(', ')}`);
  }
  const type = kindRaw as WagerTransactionType;

  let gameId = 'unknown';
  if (raw['gameId'] !== undefined && raw['gameId'] !== null) {
    gameId = requireString(raw, 'gameId');
  }

  const { amount, currency } = parseMoneyInput(raw['money'], 'money');
  if (type !== WagerTransactionType.LOSS && !amount.isPositive()) {
    throw new ValidationError(`Transação ${type} exige money.amount maior que zero`);
  }

  let referenceExternalTransactionId: string | null = null;
  if (raw['referenceExternalTransactionId'] !== undefined && raw['referenceExternalTransactionId'] !== null) {
    referenceExternalTransactionId = requireString(raw, 'referenceExternalTransactionId');
  }
  if (
    (type === WagerTransactionType.REFUND || type === WagerTransactionType.ROLLBACK) &&
    referenceExternalTransactionId === null
  ) {
    throw new ValidationError(`Transação ${type} exige referenceExternalTransactionId`);
  }

  // Idempotency-Key: obrigatória no HTTP; no SQS cai para `${providerId}:${externalTransactionId}`.
  let idempotencyKey = context.idempotencyKey?.trim() ?? '';
  if (idempotencyKey === '') {
    if (context.source === 'HTTP') {
      throw new ValidationError('Header Idempotency-Key é obrigatório');
    }
    idempotencyKey = `${providerId}:${externalTransactionId}`;
  }

  const payloadHash = canonicalJsonHash({
    providerId,
    externalTransactionId,
    playerId,
    walletId,
    roundId,
    gameId,
    kind: type,
    money: { amount: amount.toString(), currency },
    referenceExternalTransactionId,
  });

  const command: WagerTransactionCommand = {
    providerId,
    externalTransactionId,
    idempotencyKey,
    payloadHash,
    type,
    walletId,
    playerId,
    roundId,
    gameId,
    currency,
    amount,
    referenceExternalTransactionId,
    source: context.source,
    correlationId: context.correlationId ?? null,
  };
  if (context.inbox) {
    command.inbox = context.inbox;
  }
  return command;
}

