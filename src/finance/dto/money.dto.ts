import { PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ChequeStatus, MoneyAccountType, MoneyPartyType, MoneyTxnKind, PaymentMode } from '@prisma/client';

const money = { maxDecimalPlaces: 2 };
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

/** A cash, bank or UPI account. The account number is stored encrypted; only its last 4 digits are ever shown. */
export class MoneyAccountDto {
  @IsEnum(MoneyAccountType) type!: MoneyAccountType;
  @Transform(trim) @IsString() @IsNotEmpty({ message: 'Give the account a name' }) @MaxLength(80) name!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) bankName?: string | null;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) branch?: string | null;
  @IsOptional()
  @Transform(upper)
  @Matches(/^[A-Z]{4}0[A-Z0-9]{6}$/, { message: 'IFSC is 11 characters, like SBIN0001234' })
  ifsc?: string | null;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(120) accountHolder?: string | null;
  /** The full account number (digits only). Leave out on edit to keep the saved one; null removes it. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.replace(/[\s-]/g, '') : value))
  @Matches(/^[0-9]{6,18}$/, { message: 'Account number is 6 to 18 digits' })
  accountNo?: string | null;
  @IsOptional()
  @Transform(trim)
  @Matches(/^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/, { message: 'UPI ID looks like name@bank' })
  upiId?: string | null;
  @IsOptional() @IsNumber(money, { message: 'Opening balance can have at most 2 decimals' }) @Min(-1e11) @Max(1e11) openingBalance?:
    number | null;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) notes?: string | null;
}

export class UpdateMoneyAccountDto extends PartialType(MoneyAccountDto) {
  /** Accounts are never deleted; an inactive one can't be picked for new entries. */
  @IsOptional() @IsBoolean() active?: boolean;
}

/**
 * Money received from a party, paid to a party, or moved between own accounts.
 * - A receipt can be against one sale bill (`saleId`); the party is then the sale's.
 * - A cheque counts only when cleared. A received cheque needs no account until it is deposited; an issued cheque
 *   needs the bank account it is drawn on.
 */
export class MoneyTxnDto {
  @IsEnum(MoneyTxnKind) kind!: MoneyTxnKind;
  @IsDateString() txnDate!: string;
  @IsEnum(PaymentMode) mode!: PaymentMode;
  @IsNumber(money, { message: 'Amount can have at most 2 decimals' })
  @Min(0.01, { message: 'Amount must be more than zero' })
  @Max(1e11)
  amount!: number;
  @IsOptional() @IsUUID(undefined, { message: 'Choose the account' }) accountId?: string;
  @ValidateIf((d: MoneyTxnDto) => d.kind === MoneyTxnKind.TRANSFER)
  @IsUUID(undefined, { message: 'Choose the account the money goes into' })
  toAccountId?: string;
  @ValidateIf((d: MoneyTxnDto) => d.kind !== MoneyTxnKind.TRANSFER && !d.saleId)
  @IsEnum(MoneyPartyType, { message: 'Choose who the money is from / to' })
  partyType?: MoneyPartyType;
  @ValidateIf((d: MoneyTxnDto) => d.kind !== MoneyTxnKind.TRANSFER && !d.saleId && d.partyType === MoneyPartyType.DISTRIBUTOR)
  @IsUUID(undefined, { message: 'Choose the distributor' })
  supplierId?: string;
  /** The textile from the Textiles list. Or give `partyName`: a textile not on the list yet is added to it. */
  @IsOptional() @IsUUID(undefined, { message: 'Choose the textile' }) textileId?: string;
  @ValidateIf(
    (d: MoneyTxnDto) =>
      d.kind !== MoneyTxnKind.TRANSFER &&
      !d.saleId &&
      d.partyType !== MoneyPartyType.DISTRIBUTOR &&
      !(d.partyType === MoneyPartyType.TEXTILE && d.textileId),
  )
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Enter the party name' })
  @MaxLength(160)
  partyName?: string;
  @IsOptional() @IsUUID() saleId?: string;
  /** UTR / UPI transaction id / bank reference. */
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) referenceNo?: string;
  @ValidateIf((d: MoneyTxnDto) => d.mode === PaymentMode.CHEQUE)
  @Transform(trim)
  @Matches(/^[0-9]{4,12}$/, { message: 'Cheque number is the digits printed on the cheque (usually 6)' })
  chequeNo?: string;
  @IsOptional() @IsDateString() chequeDate?: string;
  /** The bank the cheque is drawn on. */
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) chequeBank?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) notes?: string;
}

export const CHEQUE_ACTIONS = ['DEPOSIT', 'CLEAR', 'BOUNCE'] as const;
export type ChequeAction = (typeof CHEQUE_ACTIONS)[number];

/** Moves a cheque on: deposited into a bank, cleared, or bounced (with the reason). */
export class ChequeActionDto {
  @IsIn(CHEQUE_ACTIONS) action!: ChequeAction;
  @IsOptional() @IsDateString() date?: string;
  /** The bank account a received cheque goes into (deposit, or clear without a separate deposit). */
  @IsOptional() @IsUUID() accountId?: string;
  @ValidateIf((d: ChequeActionDto) => d.action === 'BOUNCE')
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Say why the cheque bounced' })
  @MaxLength(300)
  reason?: string;
}

export class CancelMoneyTxnDto {
  @Transform(trim) @IsString() @MinLength(3, { message: 'Say why it is cancelled' }) @MaxLength(300) reason!: string;
}

const boolString = ({ value }: { value: unknown }) => value === true || value === 'true' || value === '1';

export class MoneyTxnFilterDto {
  @IsOptional() @IsEnum(MoneyTxnKind) kind?: MoneyTxnKind;
  @IsOptional() @IsEnum(PaymentMode) mode?: PaymentMode;
  @IsOptional() @IsUUID() accountId?: string;
  @IsOptional() @IsEnum(MoneyPartyType) partyType?: MoneyPartyType;
  @IsOptional() @IsUUID() supplierId?: string;
  @IsOptional() @IsUUID() textileId?: string;
  /** A textile / other party's name (any case). */
  @IsOptional() @Transform(trim) @IsString() @MaxLength(160) party?: string;
  @IsOptional() @IsUUID() saleId?: string;
  /** A cheque status, or OPEN for cheques still to clear. */
  @IsOptional() @IsIn([...Object.values(ChequeStatus), 'OPEN']) chequeStatus?: ChequeStatus | 'OPEN';
  /** Inclusive, ISO date-times. */
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Transform(boolString) @IsBoolean() includeCancelled?: boolean;
}

export class ExpenseFilterDto {
  @IsOptional() @IsUUID() accountId?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(60) category?: string;
  /** Inclusive, ISO date-times. */
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Transform(boolString) @IsBoolean() includeCancelled?: boolean;
}

/** A period for Finance: inclusive ISO date-times. */
export class PeriodDto {
  @IsDateString() from!: string;
  @IsDateString() to!: string;
}

/** One party's statement: a distributor or textile by id, or an other party by name. */
export class StatementQueryDto {
  @IsEnum(MoneyPartyType) type!: MoneyPartyType;
  @ValidateIf((d: StatementQueryDto) => d.type === MoneyPartyType.DISTRIBUTOR) @IsUUID() supplierId?: string;
  @ValidateIf((d: StatementQueryDto) => d.type === MoneyPartyType.TEXTILE) @IsUUID() textileId?: string;
  @ValidateIf((d: StatementQueryDto) => d.type === MoneyPartyType.OTHER)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name?: string;
}
