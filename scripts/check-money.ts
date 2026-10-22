/**
 * Guarda contra dinheiro em ponto flutuante: falha se encontrar, em `src/`, conversões
 * numéricas que costumam transformar valores monetários em `number`. Exceções conhecidas
 * ficam listadas abaixo, com o motivo.
 */
const FORBIDDEN = ['parseFloat(', 'parseInt(', 'Number(', '.toFixed('];

const ALLOWED: { file: string; pattern: string; reason: string }[] = [
  {
    file: 'src/interfaces/http/wallets/ledger-cursor.ts',
    pattern: 'Number(',
    reason: 'versão da wallet no cursor da paginação, não dinheiro',
  },
  {
    file: 'src/domain/shared/money.ts',
    pattern: '.toFixed(',
    reason: 'formatação com escala fixa dentro do próprio Money (decimal.js)',
  },
];

const isAllowed = (file: string, pattern: string) =>
  ALLOWED.some((a) => a.file === file && a.pattern === pattern);

const violations: string[] = [];
for await (const file of new Bun.Glob('src/**/*.ts').scan('.')) {
  const lines = (await Bun.file(file).text()).split('\n');
  lines.forEach((line, index) => {
    for (const pattern of FORBIDDEN) {
      if (line.includes(pattern) && !isAllowed(file, pattern)) {
        violations.push(`${file}:${index + 1}: ${pattern}`);
      }
    }
  });
}

if (violations.length > 0) {
  console.error('Possible floating-point money handling found:');
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log('check:money ok');

export {};
