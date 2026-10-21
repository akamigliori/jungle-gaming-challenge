import type { IdGenerator } from '../../application/ports/id-generator';

/** UUIDv7 (ordenável pelo tempo) gerado pelo runtime do Bun. */
export class UuidV7IdGenerator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
