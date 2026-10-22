/**
 * Teste de carga contra as instâncias já no ar (`docker compose --profile app up -d --build --wait`).
 * Não há meta de vazão: o objetivo é medir latência, vazão e conflitos sob disputa e, principalmente,
 * provar que nada se perdeu: toda wallet criada precisa passar na reconciliação e fechar com o saldo
 * que as respostas da API dizem que ela deve ter.
 *
 * Variáveis: `LOAD_TARGETS` (URLs separadas por vírgula, padrão as três instâncias do Compose),
 * `LOAD_DURATION_S`, `LOAD_CONCURRENCY`, `LOAD_WALLETS`, `LOAD_HOT_WALLETS`, `LOAD_HOT_RATIO`,
 * `LOAD_DRAIN_TIMEOUT_S`. Com `--json` o resumo vai para o stdout em JSON e o texto para o stderr.
 * Dinheiro trafega como string; o saldo esperado é calculado em centavos (`bigint`).
 */
import { cpus, totalmem } from 'node:os';

const TARGETS = (
  process.env.LOAD_TARGETS ?? 'http://localhost:3001,http://localhost:3002,http://localhost:3003'
)
  .split(',')
  .map((target) => target.trim())
  .filter(Boolean);
const DURATION_S = envInt('LOAD_DURATION_S', 60);
const CONCURRENCY = envInt('LOAD_CONCURRENCY', 32);
const WALLETS = envInt('LOAD_WALLETS', 200);
const HOT_WALLETS = Math.min(envInt('LOAD_HOT_WALLETS', 5), WALLETS - 1);
const HOT_RATIO = envRatio('LOAD_HOT_RATIO', 0.3);
const DRAIN_TIMEOUT_S = envInt('LOAD_DRAIN_TIMEOUT_S', 180);
const JSON_OUTPUT = process.argv.includes('--json');

const CURRENCY = 'BRL';
const PROVIDER_ID = 'load-provider';
const INITIAL_BALANCE = '1000000.00';
const INSUFFICIENT_AMOUNT = '900000000.00';
const SETUP_CONCURRENCY = 16;
const DRAIN_POLL_MS = 250;
const OUTBOX_SAMPLE_MS = 1000;
const MAX_BET_UNITS = 20;
const CENTS = 100n;

// Mistura de tráfego (probabilidades acumuladas, avaliadas nesta ordem).
const SHARE_INSUFFICIENT = 0.03;
const SHARE_REPLAY = 0.12;
const SHARE_FOLLOW_UP = 0.2;
const FOLLOW_UP_WIN_RATIO = 0.6;

const runId = crypto.randomUUID().slice(0, 8);

type Kind = 'BET' | 'WIN' | 'REFUND';
type Scenario = 'bet' | 'win' | 'refund' | 'replay' | 'insufficient';

interface WagerRequest {
  walletId: string;
  externalTransactionId: string;
  kind: Kind;
  amount: string;
  reference?: string;
}

interface Sample {
  scenario: Scenario;
  hot: boolean;
  status: number; // 0 = erro de rede
  latencyMs: number;
  expected: boolean;
}

interface WalletState {
  id: string;
  playerId: string;
  expectedCents: bigint;
  uncertain: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = +raw;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function envRatio(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = +raw;
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new Error(`${name} must be in [0, 1]`);
  return value;
}

function log(text = ''): void {
  (JSON_OUTPUT ? console.error : console.log)(text);
}

const toCents = (amount: string): bigint => BigInt(amount.replace('.', ''));
const fromCents = (cents: bigint): string => {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const text = `${abs / CENTS}.${(abs % CENTS).toString().padStart(2, '0')}`;
  return negative ? `-${text}` : text;
};
const randomInt = (maxExclusive: number): number => Math.floor(Math.random() * maxExclusive);

let roundRobin = 0;
const nextTarget = (): string => TARGETS[roundRobin++ % TARGETS.length] as string;

async function call(target: string, method: string, path: string, body?: unknown, headers = {}) {
  const response = await fetch(`${target}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // resposta que não é JSON (ex.: /metrics) fica como texto
  }
  // biome-ignore lint/suspicious/noExplicitAny: resposta JSON arbitrária inspecionada pelo script
  return { status: response.status, body: parsed as any };
}

// ---------- métricas ----------

type Totals = Record<string, number>;
interface Scrape {
  totals: Totals;
  outboxPending: number;
  outboxLagSeconds: number;
}

/** Soma, entre as instâncias, as linhas de cada família de métrica (ignora os buckets). */
async function scrape(): Promise<Scrape> {
  const totals: Totals = {};
  let outboxPending = Number.NaN;
  let outboxLagSeconds = Number.NaN;
  for (const target of TARGETS) {
    const { body } = await call(target, 'GET', '/metrics');
    for (const line of String(body).split('\n')) {
      if (!line.startsWith('wagering_') || line.includes('_bucket')) continue;
      const split = line.lastIndexOf(' ');
      const name = line.slice(0, split).replace(/\{.*\}/, '');
      const value = +line.slice(split + 1);
      // os gauges da outbox vêm do banco: o valor é o mesmo em todas as instâncias
      if (name === 'wagering_outbox_pending') outboxPending = value;
      else if (name === 'wagering_outbox_lag_seconds') outboxLagSeconds = value;
      else totals[name] = (totals[name] ?? 0) + value;
    }
  }
  return { totals, outboxPending, outboxLagSeconds };
}

const delta = (after: Totals, before: Totals, name: string): number =>
  (after[name] ?? 0) - (before[name] ?? 0);

// ---------- preparação ----------

async function createWallets(): Promise<WalletState[]> {
  const wallets: WalletState[] = [];
  let next = 0;
  const worker = async () => {
    while (next < WALLETS) {
      next += 1;
      const playerId = crypto.randomUUID();
      const reply = await call(nextTarget(), 'POST', '/wallets', {
        playerId,
        initialBalance: { amount: INITIAL_BALANCE, currency: CURRENCY },
      });
      if (reply.status !== 201) throw new Error(`POST /wallets answered ${reply.status}`);
      wallets.push({
        id: reply.body.id,
        playerId,
        expectedCents: toCents(INITIAL_BALANCE),
        uncertain: 0,
      });
    }
  };
  await Promise.all(Array.from({ length: SETUP_CONCURRENCY }, worker));
  return wallets;
}

// ---------- tráfego ----------

function buildBody(request: WagerRequest, playerId: string) {
  return {
    providerId: PROVIDER_ID,
    externalTransactionId: request.externalTransactionId,
    playerId,
    walletId: request.walletId,
    roundId: `round-${runId}`,
    gameId: 'load-game',
    kind: request.kind,
    money: { amount: request.amount, currency: CURRENCY },
    ...(request.reference && { referenceExternalTransactionId: request.reference }),
  };
}

async function runTraffic(
  wallets: WalletState[],
): Promise<{ samples: Sample[]; elapsedS: number }> {
  const samples: Sample[] = [];
  const byId = new Map(wallets.map((wallet) => [wallet.id, wallet]));
  const hotIds = new Set(wallets.slice(0, HOT_WALLETS).map((wallet) => wallet.id));
  const deadline = performance.now() + DURATION_S * 1000;
  let sequence = 0;

  const pickWallet = (): WalletState => {
    const hot = HOT_WALLETS > 0 && Math.random() < HOT_RATIO;
    const index = hot ? randomInt(HOT_WALLETS) : HOT_WALLETS + randomInt(WALLETS - HOT_WALLETS);
    return wallets[index] as WalletState;
  };

  const virtualUser = async () => {
    // BETs processadas deste usuário ainda sem WIN/REFUND, e a última requisição processada (para replay)
    const open: { walletId: string; id: string; amount: string }[] = [];
    let last: WagerRequest | undefined;

    while (performance.now() < deadline) {
      const roll = Math.random();
      let scenario: Scenario = 'bet';
      if (roll < SHARE_INSUFFICIENT) scenario = 'insufficient';
      else if (roll < SHARE_REPLAY && last) scenario = 'replay';
      else if (roll < SHARE_FOLLOW_UP && open.length > 0) {
        scenario = Math.random() < FOLLOW_UP_WIN_RATIO ? 'win' : 'refund';
      }

      let request: WagerRequest;
      if (scenario === 'replay') {
        request = last as WagerRequest;
      } else if (scenario === 'win' || scenario === 'refund') {
        const followedUp = open.pop() as (typeof open)[number];
        request = {
          walletId: followedUp.walletId,
          externalTransactionId: `${scenario}-${runId}-${sequence++}`,
          kind: scenario === 'win' ? 'WIN' : 'REFUND',
          amount: scenario === 'win' ? `${1 + randomInt(MAX_BET_UNITS * 2)}.50` : followedUp.amount,
          reference: followedUp.id,
        };
      } else {
        const wallet = pickWallet();
        request = {
          walletId: wallet.id,
          externalTransactionId: `bet-${runId}-${sequence++}`,
          kind: 'BET',
          amount:
            scenario === 'insufficient'
              ? INSUFFICIENT_AMOUNT
              : `${1 + randomInt(MAX_BET_UNITS)}.00`,
        };
      }

      const wallet = byId.get(request.walletId) as WalletState;
      const expectedStatus = scenario === 'insufficient' ? 422 : 201;
      const startedAt = performance.now();
      let status = 0;
      let body: { idempotentReplay?: boolean } = {};
      try {
        const reply = await call(
          nextTarget(),
          'POST',
          '/wagering/transactions',
          buildBody(request, wallet.playerId),
          { 'idempotency-key': `${PROVIDER_ID}:${request.externalTransactionId}` },
        );
        status = reply.status;
        body = reply.body ?? {};
      } catch {
        status = 0;
      }
      const latencyMs = performance.now() - startedAt;

      const replayOk = scenario !== 'replay' || body.idempotentReplay === true;
      samples.push({
        scenario,
        hot: hotIds.has(request.walletId),
        status,
        latencyMs,
        expected: status === expectedStatus && replayOk,
      });

      if (status === 0 || status >= 500) {
        wallet.uncertain += 1; // não sabemos se foi aplicada
      } else if (status === 201 && scenario !== 'replay') {
        const cents = toCents(request.amount);
        wallet.expectedCents += request.kind === 'BET' ? -cents : cents;
        if (request.kind === 'BET') {
          open.push({
            walletId: request.walletId,
            id: request.externalTransactionId,
            amount: request.amount,
          });
        }
        last = request;
      }
    }
  };

  const startedAt = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, virtualUser));
  return { samples, elapsedS: (performance.now() - startedAt) / 1000 };
}

// ---------- análise ----------

function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const index = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, index)] as number;
}

function latencySummary(samples: Sample[]) {
  const sorted = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    count: sorted.length,
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    p99Ms: round(percentile(sorted, 99)),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
  };
}

async function waitForOutboxDrain(): Promise<{
  seconds: number;
  drained: boolean;
  pendingAtEnd: number;
}> {
  const startedAt = performance.now();
  const timeoutAt = startedAt + DRAIN_TIMEOUT_S * 1000;
  for (;;) {
    const { outboxPending } = await scrape();
    if (outboxPending === 0) {
      return { seconds: (performance.now() - startedAt) / 1000, drained: true, pendingAtEnd: 0 };
    }
    if (performance.now() > timeoutAt) {
      return { seconds: DRAIN_TIMEOUT_S, drained: false, pendingAtEnd: outboxPending };
    }
    await Bun.sleep(DRAIN_POLL_MS);
  }
}

interface WalletVerdict {
  reconciled: number;
  inconsistent: string[];
  negative: string[];
  balanceMismatch: string[];
  uncertainWallets: number;
}

async function verifyWallets(wallets: WalletState[]): Promise<WalletVerdict> {
  const verdict: WalletVerdict = {
    reconciled: 0,
    inconsistent: [],
    negative: [],
    balanceMismatch: [],
    uncertainWallets: wallets.filter((wallet) => wallet.uncertain > 0).length,
  };
  let next = 0;
  const worker = async () => {
    while (next < wallets.length) {
      const wallet = wallets[next++] as WalletState;
      const report = await call(nextTarget(), 'POST', `/wallets/${wallet.id}/reconciliation`);
      const stored: string = report.body?.storedBalance?.amount ?? '';
      if (report.status !== 200 || report.body.consistent !== true)
        verdict.inconsistent.push(wallet.id);
      else verdict.reconciled += 1;
      if (stored.startsWith('-')) verdict.negative.push(wallet.id);
      if (wallet.uncertain === 0 && stored !== fromCents(wallet.expectedCents)) {
        verdict.balanceMismatch.push(wallet.id);
      }
    }
  };
  await Promise.all(Array.from({ length: SETUP_CONCURRENCY }, worker));
  return verdict;
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) result[key(item)] = (result[key(item)] ?? 0) + 1;
  return result;
}

interface OutboxPeak {
  pending: number;
  lagSeconds: number;
}

/** Lê o backlog da outbox uma vez por segundo durante o tráfego e guarda os picos. */
function watchOutbox() {
  const peak: OutboxPeak = { pending: 0, lagSeconds: 0 };
  let running = true;
  const loop = (async () => {
    while (running) {
      const { outboxPending, outboxLagSeconds } = await scrape().catch(() => ({
        outboxPending: 0,
        outboxLagSeconds: 0,
      }));
      if (outboxPending > peak.pending) peak.pending = outboxPending;
      if (outboxLagSeconds > peak.lagSeconds)
        peak.lagSeconds = Math.round(outboxLagSeconds * 10) / 10;
      await Bun.sleep(OUTBOX_SAMPLE_MS);
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      return peak;
    },
  };
}

interface SummaryInput {
  samples: Sample[];
  elapsedS: number;
  before: Scrape;
  after: Scrape;
  drain: Awaited<ReturnType<typeof waitForOutboxDrain>>;
  verdict: WalletVerdict;
  walletCount: number;
  outboxPeak: OutboxPeak;
}

function buildSummary({
  samples,
  elapsedS,
  before,
  after,
  drain,
  verdict,
  walletCount,
  outboxPeak,
}: SummaryInput) {
  const cpu = cpus();
  const statusHistogram = countBy(samples, (sample) => String(sample.status));
  const failures = samples.filter((sample) => sample.status === 0 || sample.status >= 500).length;
  const unexpected = samples.filter(
    (sample) => !sample.expected && sample.status !== 0 && sample.status < 500,
  ).length;
  return {
    environment: {
      cpu: `${cpu[0]?.model ?? 'desconhecida'} (${cpu.length} threads)`,
      memoryGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
      bun: Bun.version,
      instances: TARGETS.length,
      instanceMemoryLimit: '256 MB cada (Compose)',
      generatorSharesMachine: true,
    },
    parameters: {
      durationS: DURATION_S,
      concurrency: CONCURRENCY,
      wallets: WALLETS,
      hotWallets: HOT_WALLETS,
      hotRatio: HOT_RATIO,
    },
    requests: samples.length,
    elapsedS: Math.round(elapsedS * 10) / 10,
    throughputRps: Math.round((samples.length / elapsedS) * 10) / 10,
    latency: latencySummary(samples),
    latencyHotWallets: latencySummary(samples.filter((sample) => sample.hot)),
    latencyOtherWallets: latencySummary(samples.filter((sample) => !sample.hot)),
    statusHistogram,
    scenarios: countBy(samples, (sample) => sample.scenario),
    failures5xxOrNetwork: failures,
    errorRate: samples.length === 0 ? 0 : failures / samples.length,
    unexpectedResponses: unexpected,
    server: {
      lockConflicts: delta(after.totals, before.totals, 'wagering_lock_conflicts_total'),
      retries: delta(after.totals, before.totals, 'wagering_retries_total'),
      duplicatesDetected: delta(after.totals, before.totals, 'wagering_duplicates_total'),
      transactionsRecorded: delta(after.totals, before.totals, 'wagering_transactions_total'),
      meanProcessingMs:
        Math.round(
          (delta(after.totals, before.totals, 'wagering_processing_duration_seconds_sum') /
            Math.max(
              1,
              delta(after.totals, before.totals, 'wagering_processing_duration_seconds_count'),
            )) *
            10000,
        ) / 10,
      outboxPendingAtEndOfTraffic: after.outboxPending,
      outboxLagSecondsAtEndOfTraffic: after.outboxLagSeconds,
      outboxPeakPending: outboxPeak.pending,
      outboxPeakLagSeconds: outboxPeak.lagSeconds,
      outboxDrainSeconds: Math.round(drain.seconds * 100) / 100,
      outboxDrained: drain.drained,
    },
    verification: {
      walletsChecked: walletCount,
      reconciledConsistent: verdict.reconciled,
      inconsistentWallets: verdict.inconsistent,
      negativeBalances: verdict.negative,
      balanceMismatches: verdict.balanceMismatch,
      walletsWithUncertainRequests: verdict.uncertainWallets,
    },
  };
}

type Summary = ReturnType<typeof buildSummary>;

// ---------- execução ----------

async function run(): Promise<number> {
  log(`Teste de carga (execução ${runId}) contra ${TARGETS.join(', ')}`);
  log(
    `Parâmetros: ${DURATION_S}s, ${CONCURRENCY} usuários virtuais, ${WALLETS} wallets ` +
      `(${HOT_WALLETS} quentes recebendo ${Math.round(HOT_RATIO * 100)}% do tráfego)`,
  );

  for (const target of TARGETS) {
    const ready = await call(target, 'GET', '/health/ready').catch(() => ({ status: 0 }));
    if (ready.status !== 200) throw new Error(`${target} is not ready (status ${ready.status})`);
  }

  log('Criando wallets...');
  const wallets = await createWallets();

  const before = await scrape();
  log('Gerando tráfego...');
  const peak = watchOutbox();
  const { samples, elapsedS } = await runTraffic(wallets);
  const outboxPeak = await peak.stop();
  const after = await scrape();
  log('Aguardando a outbox esvaziar...');
  const drain = await waitForOutboxDrain();
  log('Reconciliando todas as wallets...');
  const verdict = await verifyWallets(wallets);

  const summary = buildSummary({
    samples,
    elapsedS,
    before,
    after,
    drain,
    verdict,
    walletCount: wallets.length,
    outboxPeak,
  });

  const ok =
    summary.failures5xxOrNetwork === 0 &&
    summary.unexpectedResponses === 0 &&
    drain.drained &&
    verdict.inconsistent.length === 0 &&
    verdict.negative.length === 0 &&
    verdict.balanceMismatch.length === 0 &&
    verdict.reconciled === wallets.length;

  printReport(summary, ok);
  if (JSON_OUTPUT) console.log(JSON.stringify({ ok, ...summary }, null, 2));
  return ok ? 0 : 1;
}

function printReport(summary: Summary, ok: boolean): void {
  const { environment: env, latency, server, verification } = summary;
  const row = (label: string, value: string | number) => log(`  ${label.padEnd(44)} ${value}`);
  log('\n=== Resultado do teste de carga ===');
  log('Ambiente');
  row('CPU', env.cpu);
  row('Memória da máquina', `${env.memoryGb} GB`);
  row('Bun', env.bun);
  row('Instâncias da aplicação', `${env.instances} (${env.instanceMemoryLimit})`);
  row('Gerador de carga', 'na mesma máquina, disputa CPU com o sistema testado');
  log('Metodologia');
  row(
    'Duração / usuários virtuais',
    `${summary.parameters.durationS}s / ${summary.parameters.concurrency}`,
  );
  row('Wallets (quentes)', `${summary.parameters.wallets} (${summary.parameters.hotWallets})`);
  row(
    'Tráfego nas wallets quentes',
    `${Math.round(summary.parameters.hotRatio * 100)}% das novas BETs`,
  );
  row('Cenários', JSON.stringify(summary.scenarios));
  log('Resultados');
  row('Requisições', summary.requests);
  row('Vazão', `${summary.throughputRps} req/s em ${summary.elapsedS}s`);
  row(
    'Latência p50 / p95 / p99 / máx',
    `${latency.p50Ms} / ${latency.p95Ms} / ${latency.p99Ms} / ${latency.maxMs} ms`,
  );
  const hot = summary.latencyHotWallets;
  const other = summary.latencyOtherWallets;
  row(
    '  wallets quentes p50 / p95 / p99',
    `${hot.p50Ms} / ${hot.p95Ms} / ${hot.p99Ms} ms (${hot.count} req)`,
  );
  row(
    '  demais wallets p50 / p95 / p99',
    `${other.p50Ms} / ${other.p95Ms} / ${other.p99Ms} ms (${other.count} req)`,
  );
  row('Códigos de status', JSON.stringify(summary.statusHistogram));
  row(
    'Erros (5xx ou rede)',
    `${summary.failures5xxOrNetwork} (${Math.round(summary.errorRate * 100000) / 1000}%)`,
  );
  row('Respostas fora do esperado (4xx inesperado)', summary.unexpectedResponses);
  log('Servidor (soma das instâncias, delta da execução)');
  row('Conflitos de lock', server.lockConflicts);
  row('Retries', server.retries);
  row('Duplicatas detectadas', server.duplicatesDetected);
  row('Transações registradas', server.transactionsRecorded);
  row('Tempo médio do caso de uso', `${server.meanProcessingMs} ms`);
  row(
    'Outbox ao fim do tráfego (pendentes / lag)',
    `${server.outboxPendingAtEndOfTraffic} / ${server.outboxLagSecondsAtEndOfTraffic} s`,
  );
  row(
    'Outbox, pico durante o tráfego (pendentes / lag)',
    `${server.outboxPeakPending} / ${server.outboxPeakLagSeconds} s`,
  );
  row(
    'Tempo para a outbox esvaziar',
    `${server.outboxDrainSeconds} s${server.outboxDrained ? '' : ' (TIMEOUT)'}`,
  );
  log('Corretude');
  row(
    'Wallets reconciliadas como consistentes',
    `${verification.reconciledConsistent} de ${verification.walletsChecked}`,
  );
  row('Saldos negativos', verification.negativeBalances.length);
  row('Saldo final diferente do esperado pelas respostas', verification.balanceMismatches.length);
  row('Wallets com requisição de resultado incerto', verification.walletsWithUncertainRequests);
  log('Limites desta medição');
  log(
    '  Uma única máquina: gerador, três instâncias, Postgres e LocalStack dividem CPU e memória;',
  );
  log('  o número é um piso para esta máquina, não a capacidade do sistema. Rede é loopback.');
  log(`\nVeredito: ${ok ? 'APROVADO' : 'REPROVADO'}`);
}

try {
  process.exit(await run());
} catch (error) {
  console.error(`\nFALHA: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
