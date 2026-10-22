import type { Metrics } from '../../src/application/ports/metrics';

/** Métricas que não registram nada, para testes que não as conferem. */
export const noopMetrics: Metrics = {
  transactionRecorded: () => undefined,
  duplicateDetected: () => undefined,
  retryScheduled: () => undefined,
  messageDeadLettered: () => undefined,
  lockConflict: () => undefined,
  processingTimed: () => undefined,
  reconciliationChecked: () => undefined,
};
