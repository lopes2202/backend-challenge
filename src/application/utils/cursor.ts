import { ValidationError } from '../../domain/errors/domain-errors';

/** Codifica a sequence do ledger como cursor opaco em base64url. */
export function encodeCursor(sequence: bigint | number): string {
  const value = BigInt(sequence);
  if (value < 0n) {
    throw new ValidationError('sequence do cursor não pode ser negativa');
  }
  return Buffer.from(value.toString(10), 'utf8').toString('base64url');
}

/** Decodifica o cursor; lança `ValidationError` se não for um base64url de inteiro não negativo. */
export function decodeCursor(cursor: string): bigint {
  if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new ValidationError('Cursor inválido');
  }
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^\d+$/.test(decoded)) {
    throw new ValidationError('Cursor inválido');
  }
  return BigInt(decoded);
}

