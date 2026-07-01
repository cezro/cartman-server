import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { wallet_txn_type } from '@prisma/client';

const CREDIT_TYPES: wallet_txn_type[] = [
  'credit_remittance',
  'credit_delivery_reward',
];

const LOCK_FLOOR = -200_000n; // -₱2,000 in centavos — mirrors accept_order() RPC

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async createManualTransaction(riderId: string, type: wallet_txn_type, amount: number, orderId?: string) {
    // amount is in centavos; always positive — sign is inferred from type
    return this.prisma.rider_wallet_transactions.create({
      data: {
        rider_id: riderId,
        type,
        amount: BigInt(amount),
        order_id: orderId,
      },
    });
  }

  // Returns signed net cash balance in centavos.
  // Credits add, debits subtract — mirrors rider_net_cash() Postgres function.
  async getNetCash(riderId: string): Promise<bigint> {
    const txns = await this.prisma.rider_wallet_transactions.findMany({
      where: { rider_id: riderId },
      select: { type: true, amount: true },
    });
    return txns.reduce((sum, t) => {
      return sum + (CREDIT_TYPES.includes(t.type) ? t.amount : -t.amount);
    }, 0n);
  }

  async getWalletBalance(riderId: string) {
    const profile = await this.prisma.profiles.findUnique({ where: { id: riderId } });
    if (!profile) throw new BadRequestException('Profile not found');

    const netCash = await this.getNetCash(riderId);
    return {
      balance: netCash.toString(),
      locked: netCash <= LOCK_FLOOR,
    };
  }

  async getTransactions(riderId: string) {
    return this.prisma.rider_wallet_transactions.findMany({
      where: { rider_id: riderId },
      orderBy: { created_at: 'desc' },
      take: 50,
    });
  }
}
