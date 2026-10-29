import { createHash } from 'node:crypto';

/** Ordena chaves de objetos recursivamente; arrays preservam a ordem dos elementos. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalize(source[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Hash SHA-256 (hex) da forma canônica do JSON. Payloads com as mesmas propriedades em
 * ordem diferente geram o mesmo hash, base da validação de idempotência
 * (mesma chave + hash diferente => conflito).
 */
export function canonicalJsonHash(value: unknown): string {
  const json = JSON.stringify(canonicalize(value)) ?? 'null';
  return createHash('sha256').update(json).digest('hex');
}

