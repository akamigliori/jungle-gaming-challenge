import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, Injectable } from '@nestjs/common';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { ZodError } from 'zod';
import { DomainError } from '../../domain/shared/domain-error';
import type { ErrorCode } from '../../domain/shared/failure-code';
import { safeError } from '../../infrastructure/logging/safe-error';
import { isConnectionError } from '../../infrastructure/persistence/pg-errors';
import { statusFor } from './error-status-map';

/** Subconjunto do logger usado pelo filtro (facilita testar sem o pino). */
export type ErrorLogger = Pick<PinoLogger, 'info' | 'warn' | 'error'>;

/** Parte da resposta HTTP (Express) usada pelo filtro. */
interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): unknown;
  json(body: unknown): unknown;
}

interface ResolvedError {
  status: number;
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

const GENERIC_5XX_MESSAGE = 'Internal server error';
const UNAVAILABLE_MESSAGE = 'Service temporarily unavailable';

function genericMessage(status: number): string {
  return status === 503 ? UNAVAILABLE_MESSAGE : GENERIC_5XX_MESSAGE;
}

/** Segundos sugeridos ao cliente antes de reenviar após um 503. */
const RETRY_AFTER_SECONDS = '1';

/**
 * Filtro global: converte qualquer erro no corpo uniforme
 * `{ error: { code, message, retryable } }`, sem nunca expor stack trace.
 */
@Catch()
@Injectable()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(@InjectPinoLogger(HttpErrorFilter.name) private readonly logger: ErrorLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<HttpResponse>();
    const e = this.resolve(exception);

    if (e.status >= 500) {
      // 5xx: loga só campos seguros do erro (sem a query nem os valores), nunca na resposta
      this.logger.error(
        { err: safeError(exception), code: e.code, status: e.status },
        'request failed',
      );
    } else {
      // 4xx: sem corpo da requisição nem stack, só o necessário para diagnóstico
      this.logger.info({ code: e.code, status: e.status }, e.message);
    }

    if (e.status === 503) res.setHeader('Retry-After', RETRY_AFTER_SECONDS);
    res.status(e.status).json({
      error: { code: e.code, message: e.message, retryable: e.retryable },
    });
  }

  private resolve(exception: unknown): ResolvedError {
    if (exception instanceof DomainError) {
      const mapped = statusFor(exception.code);
      // 5xx nunca ecoa a mensagem interna: o detalhe fica só no log
      const message = mapped.status >= 500 ? genericMessage(mapped.status) : exception.message;
      return { code: exception.code, message, ...mapped };
    }
    if (exception instanceof ZodError) {
      return this.fromCode('INVALID_PAYLOAD', zodMessage(exception));
    }
    if (isConnectionError(exception)) {
      return this.fromCode('SERVICE_UNAVAILABLE', 'Service temporarily unavailable');
    }
    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }
    const clientStatus = exposedClientErrorStatus(exception);
    if (clientStatus !== null) {
      // erro do body-parser (corpo grande demais, encoding inválido, JSON malformado que não
      // chegou como HttpException): payload inválido, preservando o status original
      const message = (exception as Error).message;
      return { status: clientStatus, code: 'INVALID_PAYLOAD', message, retryable: false };
    }
    return this.fromCode('INTERNAL_ERROR', 'Internal server error');
  }

  private fromHttpException(exception: HttpException): ResolvedError {
    const status = exception.getStatus();
    if (status === 404) return this.fromCode('NOT_FOUND', exception.message);
    if (status === 401 || status === 403) return this.fromCode('UNAUTHORIZED', exception.message);
    if (status === 503) return this.fromCode('SERVICE_UNAVAILABLE', exception.message);
    if (status >= 500) return this.fromCode('INTERNAL_ERROR', 'Internal server error');
    // demais 4xx do framework (JSON malformado, corpo grande demais, etc.): payload inválido,
    // preservando o status original
    return { status, code: 'INVALID_PAYLOAD', message: exception.message, retryable: false };
  }

  private fromCode(code: ErrorCode, message: string): ResolvedError {
    return { code, message, ...statusFor(code) };
  }
}

/** Resume os problemas de validação sem ecoar os valores recebidos. */
function zodMessage(error: ZodError): string {
  return error.issues
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

/**
 * Status 4xx de erros no formato do pacote `http-errors` (usado pelo body-parser do Express),
 * só quando o próprio erro declara `expose: true`, isto é, que a mensagem é segura para o cliente.
 */
function exposedClientErrorStatus(exception: unknown): number | null {
  if (!(exception instanceof Error)) return null;
  const { status, expose } = exception as { status?: unknown; expose?: unknown };
  const isClientError = typeof status === 'number' && status >= 400 && status < 500;
  return isClientError && expose === true ? status : null;
}
