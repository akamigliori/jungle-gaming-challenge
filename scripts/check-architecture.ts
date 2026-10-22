/**
 * Guarda da regra de dependência: o núcleo (domain e application) nunca importa as camadas
 * externas nem frameworks. Falha listando cada import proibido.
 */
import { dirname, join, normalize } from 'node:path';

interface LayerRule {
  layer: string;
  /** Camadas (pastas de src/) que esta camada pode importar por caminho relativo. */
  allowedLayers: string[];
  /** Pacotes externos permitidos, com o motivo. */
  allowedPackages: Record<string, string>;
}

const RULES: LayerRule[] = [
  {
    layer: 'domain',
    allowedLayers: ['domain'],
    allowedPackages: { 'decimal.js': 'aritmética decimal exata dentro de Money' },
  },
  {
    layer: 'application',
    allowedLayers: ['domain', 'application'],
    allowedPackages: { 'node:crypto': 'SHA-256 do hash canônico do payload' },
  },
];

const IMPORT_PATTERN = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

export interface SourceFile {
  path: string;
  source: string;
}

/** Devolve `arquivo: import` para cada dependência que fere a regra da camada do arquivo. */
export function findViolations(files: SourceFile[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const rule = RULES.find((r) => file.path.startsWith(`src/${r.layer}/`));
    if (!rule) continue;
    for (const [, specifier] of file.source.matchAll(IMPORT_PATTERN)) {
      if (specifier !== undefined && !isAllowed(file.path, specifier, rule)) {
        violations.push(`${file.path}: ${specifier}`);
      }
    }
  }
  return violations;
}

function isAllowed(filePath: string, specifier: string, rule: LayerRule): boolean {
  if (!specifier.startsWith('.')) return specifier in rule.allowedPackages;
  const target = normalize(join(dirname(filePath), specifier));
  return rule.allowedLayers.some((layer) => target.startsWith(`src/${layer}/`));
}

async function main(): Promise<void> {
  const files: SourceFile[] = [];
  for await (const path of new Bun.Glob('src/{domain,application}/**/*.ts').scan('.')) {
    files.push({ path, source: await Bun.file(path).text() });
  }
  const violations = findViolations(files);
  if (violations.length > 0) {
    console.error('Forbidden imports in the core layers:');
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  console.log(`check:architecture ok (${files.length} files)`);
}

if (import.meta.main) await main();
