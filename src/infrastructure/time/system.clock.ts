import type { Clock } from '../../application/ports/clock';

/** Relógio real do sistema. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
