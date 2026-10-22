import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { ProcessWagerTransactionUseCase } from '../../../application/wager/process-wager-transaction.use-case';
import { InvalidPayloadError } from '../../../domain/shared/domain-error';
import { WagerTransactionKind } from '../../../domain/wager/wager-transaction-kind';
import { WagerTransactionStatus } from '../../../domain/wager/wager-transaction-status';
import { wagerOutcomeFields } from '../../../infrastructure/logging/wager-log';
import {
  type WagerTransactionDto,
  WagerTransactionQuery,
} from '../../../infrastructure/persistence/queries/wager-transaction.query';
import {
  idempotencyKeySchema,
  providerTransactionParamsSchema,
  type RejectedWagerResponse,
  type SubmitWagerResponse,
  submitWagerBodySchema,
  toRejectedResponse,
  toSubmitResponse,
  transactionIdParamsSchema,
} from './wager.dto';

/** Requisição com o correlation id gravado pelo pino-http. */
interface RequestWithId {
  id: string;
}

/** Parte da resposta HTTP (Express) usada para status e header. */
interface HttpResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

const STATUS_BY_OUTCOME: Record<string, number> = {
  [WagerTransactionStatus.Processed]: HttpStatus.CREATED,
  [WagerTransactionStatus.PendingReference]: HttpStatus.ACCEPTED,
  [WagerTransactionStatus.Rejected]: HttpStatus.UNPROCESSABLE_ENTITY,
};

@Controller()
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly transactions: WagerTransactionQuery,
    @InjectPinoLogger(WageringController.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Submete uma transação. PROCESSED → 201, PENDING_REFERENCE → 202, REJECTED → 422 (a rejeição
   * é um resultado gravado, não uma exceção). Replay devolve o mesmo status do original.
   */
  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKeyHeader: unknown,
    @Req() req: RequestWithId,
    @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<SubmitWagerResponse | RejectedWagerResponse> {
    const idempotencyKey = idempotencyKeySchema.safeParse(idempotencyKeyHeader);
    if (!idempotencyKey.success) {
      throw new InvalidPayloadError('Idempotency-Key header is required (1 to 255 characters)');
    }
    const input = submitWagerBodySchema.parse(body);
    // ids já validados: entram em todas as linhas da requisição, inclusive a do filtro de erros
    this.logger.assign({ walletId: input.walletId, providerId: input.providerId });

    const startedAt = performance.now();
    const { transaction, idempotentReplay } = await this.processWager.execute({
      ...input,
      kind: input.kind as WagerTransactionKind,
      idempotencyKey: idempotencyKey.data,
      correlationId: req.id,
    });

    this.logger.info(
      wagerOutcomeFields(transaction, idempotentReplay, startedAt),
      'wager transaction processed',
    );

    res.status(STATUS_BY_OUTCOME[transaction.status] ?? HttpStatus.INTERNAL_SERVER_ERROR);
    if (idempotentReplay) res.setHeader('Idempotent-Replayed', 'true');
    return transaction.status === WagerTransactionStatus.Rejected
      ? toRejectedResponse(transaction, idempotentReplay)
      : toSubmitResponse(transaction, idempotentReplay);
  }

  @Get('wagering/transactions/:transactionId')
  async findById(@Param() params: unknown): Promise<WagerTransactionDto> {
    const { transactionId } = transactionIdParamsSchema.parse(params);
    return found(await this.transactions.findById(transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async findByExternalId(@Param() params: unknown): Promise<WagerTransactionDto> {
    const { providerId, externalTransactionId } = providerTransactionParamsSchema.parse(params);
    return found(await this.transactions.findByExternalId(providerId, externalTransactionId));
  }
}

/** Transação inexistente vira 404 `NOT_FOUND` pelo filtro global. */
function found(transaction: WagerTransactionDto | null): WagerTransactionDto {
  if (!transaction) throw new NotFoundException('transaction not found');
  return transaction;
}
