import type { JournalEntry } from '../../domain/wallet/journal-entry';

/** Journal de partidas dobradas (contrapartida da casa), append-only. */
export interface JournalRepository {
  append(entry: JournalEntry): Promise<void>;
}

export const JOURNAL_REPOSITORY = Symbol('JOURNAL_REPOSITORY');
