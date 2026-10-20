/** Gera identificadores únicos (UUIDv7) para entidades e eventos. */
export interface IdGenerator {
  next(): string;
}

export const ID_GENERATOR = Symbol('ID_GENERATOR');
