import type { IntegrationEvent } from '../events/integration-event';
import { InvariantViolationError } from '../shared/domain-error';

export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 300_000;

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  private _attempts: number;
  private _nextAttemptAt: Date | undefined;
  private _publishedAt: Date | undefined;

  private constructor(s: OutboxMessageState) {
    this.id = s.id;
    this.aggregateId = s.aggregateId;
    this.eventType = s.eventType;
    this.payload = s.payload;
    this.occurredAt = s.occurredAt;
    this._attempts = s.attempts;
    this._nextAttemptAt = s.nextAttemptAt;
    this._publishedAt = s.publishedAt;
  }

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON() as unknown as Record<string, unknown>,
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: event.occurredAt,
    });
  }

  /** Reconstrói a mensagem persistida como está, sem validar. */
  static rehydrate(s: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(s);
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      this._nextAttemptAt !== undefined &&
      this._nextAttemptAt.getTime() <= now.getTime()
    );
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvariantViolationError(`outbox message ${this.id} already published`);
    }
    this._publishedAt = at;
  }

  /** Incrementa attempts e define nextAttemptAt com backoff exponencial e equal jitter. */
  scheduleRetry(now: Date, random: () => number = Math.random): void {
    this._attempts += 1;
    const exponential = Math.min(RETRY_BASE_MS * 2 ** (this._attempts - 1), RETRY_MAX_MS);
    const delay = exponential * (0.5 + random() * 0.5);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
