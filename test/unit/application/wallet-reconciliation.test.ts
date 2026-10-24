import { describe, expect, test } from 'bun:test';
import type { WalletLedgerSnapshot } from '../../../src/application/ports/wallet-ledger-reader';
import { buildReport, findIssues } from '../../../src/application/wallet/wallet-reconciliation';

const consistent: WalletLedgerSnapshot = {
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  currency: 'BRL',
  storedBalance: '975.00',
  calculatedBalance: '975.00',
  difference: '0.00',
  ledgerBalance: '975.00',
  matchesLastEntry: true,
  matchesLedgerSum: true,
  version: 3,
  ledgerVersion: 3,
  entries: 3,
  brokenLinks: 0,
  versionGaps: 0,
  journalGaps: 0,
};

describe('findIssues', () => {
  test('consistent snapshot has no issues', () => {
    expect(findIssues(consistent)).toEqual([]);
  });

  test('empty ledger of a zero-balance wallet is consistent at version 1', () => {
    const empty = {
      ...consistent,
      storedBalance: '0.00',
      calculatedBalance: '0.00',
      ledgerBalance: null,
      version: 1,
      ledgerVersion: null,
      entries: 0,
    };
    expect(findIssues(empty)).toEqual([]);
  });

  test('reports each divergence with its own stable code', () => {
    const broken: WalletLedgerSnapshot = {
      ...consistent,
      storedBalance: '1000.00',
      difference: '25.00',
      matchesLastEntry: false,
      matchesLedgerSum: false,
      version: 5,
      brokenLinks: 1,
      versionGaps: 2,
    };
    expect(findIssues(broken)).toEqual([
      'BALANCE_DIFFERS_FROM_LAST_ENTRY',
      'BALANCE_DIFFERS_FROM_LEDGER_SUM',
      'VERSION_DIFFERS_FROM_LEDGER',
      'LEDGER_CHAIN_BROKEN',
      'LEDGER_VERSION_GAP',
    ]);
  });

  test('a ledger entry without a journal counterparty → DOUBLE_ENTRY_GAP', () => {
    expect(findIssues({ ...consistent, journalGaps: 1 })).toEqual(['DOUBLE_ENTRY_GAP']);
  });
});

describe('buildReport', () => {
  test('keeps money as strings and flags consistency', () => {
    const report = buildReport(consistent, new Date('2026-10-22T12:00:00.000Z'));
    expect(report).toEqual({
      walletId: consistent.walletId,
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      ledgerBalance: { amount: '975.00', currency: 'BRL' },
      version: 3,
      ledgerVersion: 3,
      checkedEntries: 3,
      consistent: true,
      issues: [],
      checkedAt: '2026-10-22T12:00:00.000Z',
    });
  });

  test('a negative difference is carried as a string', () => {
    const report = buildReport(
      { ...consistent, storedBalance: '970.00', difference: '-5.00', matchesLedgerSum: false },
      new Date(0),
    );
    expect(report.consistent).toBe(false);
    expect(report.difference).toEqual({ amount: '-5.00', currency: 'BRL' });
  });
});
