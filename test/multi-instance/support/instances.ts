import { createServer } from 'node:net';
import type { Subprocess } from 'bun';
import type { Env } from '../../../src/infrastructure/config/config';

const READY_TIMEOUT_MS = 30_000;
const READY_POLL_INTERVAL_MS = 100;
const LOOPBACK = '127.0.0.1';
/** Tentativas de subir uma instância que morre antes de ficar pronta (porta tomada no meio). */
const START_ATTEMPTS = 3;

export type StopSignal = 'SIGKILL' | 'SIGTERM';

export interface Instance {
  /** Número da instância no teste (1, 2, 3), só para mensagens de erro. */
  n: number;
  port: number;
  baseUrl: string;
  proc: Subprocess;
  /** Envia o sinal e espera o processo terminar; devolve o código de saída. */
  kill(signal: StopSignal): Promise<number>;
}

/** Processos vivos iniciados pelo teste, para o `afterAll` não deixar órfãos nem em falha. */
const running = new Set<Subprocess>();

/**
 * Sobe um processo real da aplicação (`bun src/main.ts`) numa porta livre, com o ambiente do teste
 * somado a `env`, e espera `/health/ready` responder 200. A porta é escolhida antes do processo
 * escutá-la; se outro processo a pegar nesse intervalo, a instância morre no `listen` e é tentada
 * de novo numa porta nova (até `START_ATTEMPTS` vezes).
 */
export async function startInstance(n: number, env: Env): Promise<Instance> {
  for (let attempt = 1; ; attempt++) {
    const instance = await spawnInstance(n, env);
    if (await waitReady(instance)) return instance;
    if (attempt >= START_ATTEMPTS) {
      throw new Error(`instance ${n} exited before becoming ready (${attempt} attempts)`);
    }
  }
}

async function spawnInstance(n: number, env: Env): Promise<Instance> {
  const port = await freePort();
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    env: { ...process.env, ...env, PORT: String(port) },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  running.add(proc);
  void proc.exited.then(() => running.delete(proc));
  return {
    n,
    port,
    baseUrl: `http://${LOOPBACK}:${port}`,
    proc,
    async kill(signal) {
      proc.kill(signal);
      return proc.exited;
    },
  };
}

/** Mata com `SIGKILL` tudo o que o teste iniciou e ainda está vivo. */
export async function killAll(): Promise<void> {
  const procs = [...running];
  for (const proc of procs) proc.kill('SIGKILL');
  await Promise.all(procs.map((proc) => proc.exited));
}

/** `true` quando fica pronta; `false` se o processo morreu antes; lança se o prazo estourar. */
async function waitReady(instance: Instance): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (instance.proc.exitCode !== null || instance.proc.signalCode !== null) return false;
    try {
      const res = await fetch(`${instance.baseUrl}/health/ready`);
      if (res.status === 200) return true;
    } catch {
      // ainda não está escutando
    }
    await Bun.sleep(READY_POLL_INTERVAL_MS);
  }
  instance.proc.kill('SIGKILL');
  throw new Error(`instance ${instance.n} not ready after ${READY_TIMEOUT_MS} ms`);
}

/** Pede ao sistema uma porta livre (porta 0) e a devolve depois de fechar o socket. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, LOOPBACK, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
