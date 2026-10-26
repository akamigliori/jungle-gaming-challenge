import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type {
  SubmissionFailureInput,
  SubmissionFailureRepository,
} from '../ports/submission-failure.repository';
import type { TransactionRunner } from '../ports/transaction-runner';

export interface RecordSubmissionFailureDeps {
  transactionRunner: TransactionRunner;
  failures: SubmissionFailureRepository;
  ids: IdGenerator;
  clock: Clock;
}

/**
 * Grava a recusa numa transação **própria e best-effort**: roda depois que a transação de negócio
 * falhou, para que a linha de auditoria não seja desfeita com ela. Se a gravação falhar (o banco é
 * o próprio problema), o erro é engolido e o erro original segue para o cliente — a auditoria nunca
 * muda a resposta.
 */
export class RecordSubmissionFailureUseCase {
  constructor(private readonly deps: RecordSubmissionFailureDeps) {}

  async execute(input: SubmissionFailureInput): Promise<void> {
    try {
      await this.deps.transactionRunner.run(async () => {
        await this.deps.failures.insert({
          ...input,
          id: this.deps.ids.next(),
          createdAt: this.deps.clock.now(),
        });
      });
    } catch {
      // best-effort: o erro original é o que importa para o cliente
    }
  }
}
