import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { wallet_txn_type } from '@prisma/client';

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async createManualTransaction(riderId: string, type: wallet_txn_type, amount: number, orderId?: string) {
    // amount is in centavos
    return this.prisma.$transaction(async (tx) => {
      const txn = await tx.rider_wallet_transactions.create({
        data: {
          rider_id: riderId,
          type,
          amount: BigInt(amount),
          order_id: orderId,
        },
      });

      // Update cached balance on profiles
      await tx.profiles.update({
        where: { id: riderId },
        data: {
          wallet_centavos: {
            increment: BigInt(amount),
          },
        },
      });

      return txn;
    });
  }

  async getWalletBalance(riderId: string) {
    const profile = await this.prisma.profiles.findUnique({
      where: { id: riderId },
      select: { wallet_centavos: true },
    });
    
    if (!profile) throw new BadRequestException('Profile not found');
    
    return {
      balance: profile.wallet_centavos.toString(),
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
