import { describe, expect, test } from 'bun:test';
import { ValidationError } from '../../../src/domain/errors/domain-errors';
import { parseCurrency } from '../../../src/domain/models/currency';
import { WagerTransactionType } from '../../../src/domain/models/wager-transaction';
import { parseWagerTransactionCommand } from '../../../src/application/dto/wager-transaction-command';
import { parseCreateWalletCommand } from '../../../src/application/use-cases/create-wallet.use-case';
import { canonicalJsonHash } from '../../../src/application/utils/canonical-json-hash';
import { decodeCursor, encodeCursor } from '../../../src/application/utils/cursor';

const body = (overrides: Record<string, unknown> = {}) => ({
  providerId: 'prov',
  externalTransactionId: 'ext1',
  playerId: 'p1',
  walletId: 'w1',
  roundId: 'r1',
  kind: 'BET',
  money: { amount: '10.00', currency: 'BRL' },
  ...overrides,
});

describe('canonicalJsonHash', () => {
  test('ordem das chaves não altera o hash (recursivo)', () => {
    const a = { x: 1, y: { b: 2, a: [1, { d: 4, c: 3 }] } };
    const b = { y: { a: [1, { c: 3, d: 4 }], b: 2 }, x: 1 };
    expect(canonicalJsonHash(a)).toBe(canonicalJsonHash(b));
    expect(canonicalJsonHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('valores diferentes geram hashes diferentes', () => {
    expect(canonicalJsonHash({ a: 1 })).not.toBe(canonicalJsonHash({ a: 2 }));
    expect(canonicalJsonHash([1, 2])).not.toBe(canonicalJsonHash([2, 1]));
  });
});

describe('cursor', () => {
  test('encode/decode round-trip com number e bigint', () => {
    expect(decodeCursor(encodeCursor(42))).toBe(42n);
    expect(decodeCursor(encodeCursor(9007199254740993n))).toBe(9007199254740993n);
  });

  test('cursor inválido lança ValidationError', () => {
    for (const bad of ['', '***', Buffer.from('abc').toString('base64url'), Buffer.from('-1').toString('base64url')]) {
      expect(() => decodeCursor(bad)).toThrow(ValidationError);
    }
    expect(() => encodeCursor(-1)).toThrow(ValidationError);
  });
});

describe('parseCreateWalletCommand', () => {
  test('aceita payload válido', () => {
    const cmd = parseCreateWalletCommand({
      playerId: 'p1',
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    expect(cmd.playerId).toBe('p1');
    expect(cmd.currency).toBe(parseCurrency('BRL'));
    expect(cmd.initialBalance.toString()).toBe('100.00');
  });

  test('rejeita playerId vazio, saldo malformado, number e moeda inválida', () => {
    const ok = { amount: '1.00', currency: 'BRL' };
    expect(() => parseCreateWalletCommand({ playerId: '', initialBalance: ok })).toThrow(ValidationError);
    expect(() =>
      parseCreateWalletCommand({ playerId: 'p', initialBalance: { amount: '1', currency: 'BRL' } }),
    ).toThrow(ValidationError);
    expect(() =>
      parseCreateWalletCommand({ playerId: 'p', initialBalance: { amount: 1.0, currency: 'BRL' } }),
    ).toThrow(ValidationError);
    expect(() =>
      parseCreateWalletCommand({ playerId: 'p', initialBalance: { amount: '1.00', currency: 'br' } }),
    ).toThrow(ValidationError);
    expect(() => parseCreateWalletCommand(null)).toThrow(ValidationError);
  });
});

describe('parseWagerTransactionCommand', () => {
  test('HTTP: usa header, gameId default "unknown" e aceita kind ou type', () => {
    const viaKind = parseWagerTransactionCommand(body(), { source: 'HTTP', idempotencyKey: 'k1' });
    expect(viaKind.gameId).toBe('unknown');
    expect(viaKind.idempotencyKey).toBe('k1');
    expect(viaKind.type).toBe(WagerTransactionType.BET);

    const { kind: _kind, ...rest } = body();
    const viaType = parseWagerTransactionCommand({ ...rest, type: 'BET' }, { source: 'HTTP', idempotencyKey: 'k1' });
    expect(viaType.payloadHash).toBe(viaKind.payloadHash);
  });

  test('HTTP sem Idempotency-Key lança ValidationError', () => {
    expect(() => parseWagerTransactionCommand(body(), { source: 'HTTP' })).toThrow(ValidationError);
    expect(() => parseWagerTransactionCommand(body(), { source: 'HTTP', idempotencyKey: '  ' })).toThrow(
      ValidationError,
    );
  });

  test('SQS: chave padrão provider:externalTransactionId e inbox repassado', () => {
    const cmd = parseWagerTransactionCommand(body(), {
      source: 'SQS',
      inbox: { consumerName: 'c', messageId: 'm1' },
    });
    expect(cmd.idempotencyKey).toBe('prov:ext1');
    expect(cmd.inbox).toEqual({ consumerName: 'c', messageId: 'm1' });
  });

  test('payloadHash independe da ordem das chaves e muda com o valor', () => {
    const ctx = { source: 'SQS' as const };
    const a = parseWagerTransactionCommand(body(), ctx);
    const reordered = Object.fromEntries(Object.entries(body()).reverse());
    expect(parseWagerTransactionCommand(reordered, ctx).payloadHash).toBe(a.payloadHash);
    const other = parseWagerTransactionCommand(body({ money: { amount: '11.00', currency: 'BRL' } }), ctx);
    expect(other.payloadHash).not.toBe(a.payloadHash);
  });

  test('REFUND/ROLLBACK exigem referenceExternalTransactionId', () => {
    const ctx = { source: 'SQS' as const };
    expect(() => parseWagerTransactionCommand(body({ kind: 'REFUND' }), ctx)).toThrow(ValidationError);
    const cmd = parseWagerTransactionCommand(
      body({ kind: 'ROLLBACK', referenceExternalTransactionId: 'ext0' }),
      ctx,
    );
    expect(cmd.referenceExternalTransactionId).toBe('ext0');
  });

  test('rejeita tipo inválido, OPENING, kind/type divergentes e amount zero (exceto LOSS)', () => {
    const ctx = { source: 'SQS' as const };
    expect(() => parseWagerTransactionCommand(body({ kind: 'XYZ' }), ctx)).toThrow(ValidationError);
    expect(() => parseWagerTransactionCommand(body({ kind: 'OPENING' }), ctx)).toThrow(ValidationError);
    expect(() => parseWagerTransactionCommand(body({ type: 'WIN' }), ctx)).toThrow(ValidationError);
    const zero = { amount: '0.00', currency: 'BRL' };
    expect(() => parseWagerTransactionCommand(body({ money: zero }), ctx)).toThrow(ValidationError);
    expect(parseWagerTransactionCommand(body({ kind: 'LOSS', money: zero }), ctx).amount.isZero()).toBe(true);
  });

  test('rejeita money com number e campos obrigatórios ausentes', () => {
    const ctx = { source: 'SQS' as const };
    expect(() =>
      parseWagerTransactionCommand(body({ money: { amount: 10, currency: 'BRL' } }), ctx),
    ).toThrow(ValidationError);
    const { roundId: _r, ...withoutRound } = body();
    expect(() => parseWagerTransactionCommand(withoutRound, ctx)).toThrow(ValidationError);
  });
});
