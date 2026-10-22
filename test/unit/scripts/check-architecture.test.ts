import { describe, expect, test } from 'bun:test';
import { findViolations } from '../../../scripts/check-architecture';

const file = (path: string, source: string) => ({ path, source });

describe('check-architecture', () => {
  test('domínio importando apenas o próprio domínio e decimal.js é aceito', () => {
    const violations = findViolations([
      file(
        'src/domain/wallet/wallet.ts',
        "import { Money } from '../shared/money';\nimport Decimal from 'decimal.js';",
      ),
    ]);
    expect(violations).toEqual([]);
  });

  test.each([
    ['framework', "import { Injectable } from '@nestjs/common';", '@nestjs/common'],
    ['ORM', "import { EntityManager } from '@mikro-orm/postgresql';", '@mikro-orm/postgresql'],
    ['node:*', "import { createHash } from 'node:crypto';", 'node:crypto'],
    [
      'camada de aplicação',
      "import type { Clock } from '../../application/ports/clock';",
      '../../application/ports/clock',
    ],
    [
      'infraestrutura',
      "export { x } from '../../infrastructure/config/config';",
      '../../infrastructure/config/config',
    ],
  ])('domínio importando %s é violação', (_name, source, specifier) => {
    expect(findViolations([file('src/domain/wallet/wallet.ts', source)])).toEqual([
      `src/domain/wallet/wallet.ts: ${specifier}`,
    ]);
  });

  test('aplicação pode importar domínio, aplicação e node:crypto', () => {
    const violations = findViolations([
      file(
        'src/application/wager/payload-hash.ts',
        "import { createHash } from 'node:crypto';\nimport { Money } from '../../domain/shared/money';\nimport type { Clock } from '../ports/clock';",
      ),
    ]);
    expect(violations).toEqual([]);
  });

  test.each([
    [
      'infraestrutura',
      "import { isTransientDbError } from '../../infrastructure/persistence/pg-errors';",
    ],
    ['interfaces', "import { statusFor } from '../../interfaces/http/error-status-map';"],
    ['framework', "import { Injectable } from '@nestjs/common';"],
    ['import dinâmico', "const m = await import('../../infrastructure/sqs/sqs.client');"],
  ])('aplicação importando %s é violação', (_name, source) => {
    expect(findViolations([file('src/application/wager/use-case.ts', source)])).toHaveLength(1);
  });

  test('camadas externas não são verificadas', () => {
    const violations = findViolations([
      file(
        'src/infrastructure/sqs/sqs.client.ts',
        "import { SQSClient } from '@aws-sdk/client-sqs';",
      ),
    ]);
    expect(violations).toEqual([]);
  });
});
