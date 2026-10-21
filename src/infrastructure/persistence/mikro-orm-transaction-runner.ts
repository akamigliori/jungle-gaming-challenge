import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type { TransactionRunner } from '../../application/ports/transaction-runner';

/**
 * Abre a transação no `EntityManager` global. O MikroORM propaga o contexto da transação
 * por AsyncLocalStorage, então os repositórios (que usam o mesmo `EntityManager` global)
 * executam seus comandos dentro dela sem receber nada explicitamente.
 */
@Injectable()
export class MikroOrmTransactionRunner implements TransactionRunner {
  constructor(private readonly em: EntityManager) {}

  run<T>(work: () => Promise<T>): Promise<T> {
    return this.em.transactional(() => work());
  }
}
