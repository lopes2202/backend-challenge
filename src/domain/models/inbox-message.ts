import { ValidationError } from '../errors/domain-errors';

export interface InboxMessageProps {
  id: string;
  consumerName: string;
  messageId: string;
  receivedAt: Date;
}

/**
 * Registro de mensagem já consumida (Inbox). A unicidade de (consumerName, messageId)
 * garante processamento idempotente de mensagens duplicadas.
 */
export class InboxMessage {
  readonly id: string;
  readonly consumerName: string;
  readonly messageId: string;
  readonly receivedAt: Date;

  private constructor(p: InboxMessageProps) {
    if (p.consumerName.trim() === '' || p.messageId.trim() === '') {
      throw new ValidationError('consumerName e messageId não podem ser vazios');
    }
    this.id = p.id;
    this.consumerName = p.consumerName;
    this.messageId = p.messageId;
    this.receivedAt = p.receivedAt;
    Object.freeze(this);
  }

  static receive(params: InboxMessageProps): InboxMessage {
    return new InboxMessage(params);
  }

  static rehydrate(params: InboxMessageProps): InboxMessage {
    return new InboxMessage(params);
  }
}

