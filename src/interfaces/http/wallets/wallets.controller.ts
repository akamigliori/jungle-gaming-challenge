import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import {
  WALLET_REPOSITORY,
  type WalletRepository,
} from '../../../application/ports/wallet.repository';
import { CreateWalletUseCase } from '../../../application/wallet/create-wallet.use-case';
import { ReconcileWalletUseCase } from '../../../application/wallet/reconcile-wallet.use-case';
import { WalletNotFoundError } from '../../../application/wallet/wallet-errors';
import type { ReconciliationReport } from '../../../application/wallet/wallet-reconciliation';
import type { Wallet } from '../../../domain/wallet/wallet';
import {
  type LedgerItemDto,
  LedgerQuery,
} from '../../../infrastructure/persistence/queries/ledger.query';
import { decodeCursor, encodeCursor } from './ledger-cursor';
import {
  createWalletBodySchema,
  ledgerQuerySchema,
  toWalletResponse,
  type WalletResponse,
  walletIdParamsSchema,
} from './wallet.dto';

/** Requisição com o correlation id gravado pelo pino-http. */
interface RequestWithId {
  id: string;
}

interface LedgerResponse {
  items: LedgerItemDto[];
  nextCursor: string | null;
}

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    private readonly ledger: LedgerQuery,
    private readonly reconcileWallet: ReconcileWalletUseCase,
    @InjectPinoLogger(WalletsController.name) private readonly logger: PinoLogger,
  ) {}

  /** Cria a wallet; responde 201 (padrão do Nest para POST). */
  @Post()
  async create(@Body() body: unknown, @Req() req: RequestWithId): Promise<WalletResponse> {
    const input = createWalletBodySchema.parse(body);
    const wallet = await this.createWallet.execute({ ...input, correlationId: req.id });
    return toWalletResponse(wallet);
  }

  @Get(':walletId')
  async findOne(@Param() params: unknown): Promise<WalletResponse> {
    const { walletId } = walletIdParamsSchema.parse(params);
    return toWalletResponse(await this.getWallet(walletId));
  }

  /** Ledger em ordem de `walletVersion`, paginado por cursor opaco. */
  @Get(':walletId/ledger')
  async ledgerPage(@Param() params: unknown, @Query() query: unknown): Promise<LedgerResponse> {
    const { walletId } = walletIdParamsSchema.parse(params);
    const { cursor, limit } = ledgerQuerySchema.parse(query);
    const afterVersion = cursor === undefined ? null : decodeCursor(cursor);
    await this.getWallet(walletId);
    const page = await this.ledger.page(walletId, afterVersion, limit);
    return {
      items: page.items,
      nextCursor: page.nextVersion === null ? null : encodeCursor(page.nextVersion),
    };
  }

  /**
   * Confere o saldo contra o ledger. Responde 200 também quando há divergência (ela vai no corpo);
   * nunca corrige nada. O log leva só o id da wallet e os códigos, sem valores.
   */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param() params: unknown): Promise<ReconciliationReport> {
    const { walletId } = walletIdParamsSchema.parse(params);
    const report = await this.reconcileWallet.execute(walletId);
    if (!report.consistent) {
      this.logger.warn({ walletId, issues: report.issues }, 'wallet diverges from its ledger');
    }
    return report;
  }

  private async getWallet(walletId: string): Promise<Wallet> {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) throw new WalletNotFoundError(`wallet ${walletId} not found`);
    return wallet;
  }
}
