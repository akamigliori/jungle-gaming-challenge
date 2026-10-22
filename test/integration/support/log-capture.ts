import { Writable } from 'node:stream';

export type LogLine = Record<string, unknown>;

/** Destino de logs que guarda as linhas JSON emitidas pelo pino, para os testes conferirem. */
export class LogCapture extends Writable {
  private chunks: string[] = [];

  override _write(chunk: Buffer | string, _encoding: string, done: () => void): void {
    this.chunks.push(chunk.toString());
    done();
  }

  /** Tudo o que foi escrito, como texto bruto (para provar que um valor nunca aparece). */
  text(): string {
    return this.chunks.join('');
  }

  lines(): LogLine[] {
    return this.text()
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as LogLine);
  }

  withMessage(msg: string): LogLine[] {
    return this.lines().filter((line) => line.msg === msg);
  }
}
