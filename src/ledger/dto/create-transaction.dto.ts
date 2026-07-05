import { IsIn, IsNumber, IsOptional, IsUUID } from 'class-validator';
import { wallet_txn_type } from '@prisma/client';

const WALLET_TXN_TYPES: wallet_txn_type[] = [
  'credit_remittance',
  'debit_cod_order',
  'credit_delivery_reward',
  'debit_commission',
];

/**
 * Body for POST /ledger/transactions (admin-only manual wallet adjustment).
 * No mobile call site exists — this is an admin-panel endpoint. Fields
 * mirror the inline type LedgerController previously declared for
 * `@Body()`: `{rider_id, type, amount, order_id?}`. `amount` is always
 * positive centavos; sign is inferred server-side from `type` (see
 * LedgerService.createManualTransaction).
 */
export class CreateTransactionDto {
  @IsUUID()
  rider_id!: string;

  @IsIn(WALLET_TXN_TYPES)
  type!: wallet_txn_type;

  @IsNumber()
  amount!: number;

  @IsOptional()
  @IsUUID()
  order_id?: string;
}
