import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { wallet_txn_type } from '@prisma/client';

@Controller('ledger')
@UseGuards(JwtAuthGuard)
export class LedgerController {
  constructor(private readonly ledgerService: LedgerService) {}

  @Post('transactions')
  @Roles('admin')
  createManualTransaction(@Body() data: { rider_id: string, type: wallet_txn_type, amount: number, order_id?: string }) {
    return this.ledgerService.createManualTransaction(data.rider_id, data.type, data.amount, data.order_id).then(txn => ({
      ...txn,
      id: txn.id.toString(),
      amount: txn.amount.toString()
    }));
  }

  @Get('me/wallet')
  @Roles('rider')
  getWalletBalance(@CurrentUser() user: AuthenticatedUser) {
    return this.ledgerService.getWalletBalance(user.id);
  }

  @Get('me/transactions')
  @Roles('rider')
  getTransactions(@CurrentUser() user: AuthenticatedUser) {
    return this.ledgerService.getTransactions(user.id).then(txns => txns.map(txn => ({
      ...txn,
      id: txn.id.toString(),
      amount: txn.amount.toString()
    })));
  }
}
