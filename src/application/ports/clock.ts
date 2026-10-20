/** Fonte do horário atual; injetada para que os testes controlem o tempo. */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('CLOCK');
