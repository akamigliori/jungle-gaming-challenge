import { InvariantViolationError } from '../shared/domain-error';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date;
}

/** Registro de deduplicação de mensagem consumida, único por (messageId, consumerName). */
export class InboxMessage {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
  private _processedAt: Date | undefined;

  private constructor(s: InboxMessageState) {
    this.messageId = s.messageId;
    this.consumerName = s.consumerName;
    this.payloadHash = s.payloadHash;
    this.receivedAt = s.receivedAt;
    this._processedAt = s.processedAt;
  }

  static receive(p: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(p);
  }

  /** Reconstrói a mensagem persistida como está, sem validar. */
  static rehydrate(s: InboxMessageState): InboxMessage {
    return new InboxMessage(s);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvariantViolationError(`inbox message ${this.messageId} already processed`);
    }
    this._processedAt = at;
  }
}
