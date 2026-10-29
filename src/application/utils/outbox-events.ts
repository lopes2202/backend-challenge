import { OutboxMessage, type JsonValue } from '../../domain/models/outbox-message';
import type { IntegrationEvent } from '../../domain/events/wager-events';
import type { IdGeneratorPort, TransactionalContext } from '../ports';

/** Converte o envelope do evento em JSON puro (Date vira ISO, bigint vira string). */
export function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object') {
    const out: { [key: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = toJsonValue(v);
    }
    return out;
  }
  return value as string | number | boolean;
}

/**
 * Grava o evento no Outbox usando o contexto transacional: a mensagem entra na MESMA
 * transação SQL do agregado, garantindo publicação at-least-once sem dual-write.
 */
export async function enqueueEvent(
  ctx: TransactionalContext,
  ids: IdGeneratorPort,
  aggregateType: string,
  event: IntegrationEvent<unknown>,
): Promise<void> {
  // toJSON() monta o envelope (payload vira "data", data vira ISO)
  const payload = toJsonValue(event.toJSON()) as { [key: string]: JsonValue };
  await ctx.outbox.add(
    OutboxMessage.create({
      id: ids.next(),
      eventType: event.eventType,
      aggregateType,
      aggregateId: event.aggregateId,
      payload,
      createdAt: event.occurredAt,
    }),
  );
}

