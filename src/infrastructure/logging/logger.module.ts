import type { DynamicModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { AppConfig } from '../config/config';
import { UuidV7IdGenerator } from '../ids/uuid-v7.id-generator';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

/** Aceita só ids curtos e sem caracteres de controle, para não permitir injeção nos logs. */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const ids = new UuidV7IdGenerator();

interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
}

interface ResponseLike {
  setHeader(name: string, value: string): unknown;
}

/**
 * Usa o `x-correlation-id` recebido (se for seguro) ou gera um UUIDv7, e devolve o mesmo
 * valor no header da resposta. O pino-http grava esse id em todas as linhas de log da requisição.
 */
export function correlationIdFor(req: RequestLike, res: ResponseLike): string {
  const incoming = req.headers[CORRELATION_ID_HEADER];
  const id =
    typeof incoming === 'string' && SAFE_CORRELATION_ID.test(incoming) ? incoming : ids.next();
  res.setHeader(CORRELATION_ID_HEADER, id);
  return id;
}

/** Logs estruturados em JSON (pino), um por requisição, sem dados sensíveis. */
export function createLoggerModule(cfg: AppConfig): DynamicModule {
  return LoggerModule.forRoot({
    pinoHttp: {
      level: cfg.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body'],
      genReqId: (req, res) => correlationIdFor(req, res),
      // `correlationId` no topo de toda linha de log emitida durante a requisição
      customProps: (req) => ({ correlationId: req.id }),
    },
  });
}
