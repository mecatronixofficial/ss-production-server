import { IsDateString, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

const money = { maxDecimalPlaces: 2 };

/** An expense, recorded on the Money page. */
export class ExpenseDto {
  @IsString() @IsNotEmpty() @MaxLength(60) category!: string;
  @IsOptional() @IsString() @MaxLength(60) subcategory?: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsNumber(money, { message: 'Amount can have at most 2 decimals' }) @Min(0.01) @Max(1e11) amount!: number;
  /** CASH, UPI, BANK or CHEQUE (older expenses also have NEFT, RTGS, CARD). */
  @IsString() @IsNotEmpty() @MaxLength(20) paymentMode!: string;
  /** The cash / bank / UPI account it was paid from; its balance goes down by the amount. */
  @IsOptional() @IsUUID(undefined, { message: 'Choose the account it was paid from' }) accountId?: string;
  @IsOptional() @IsString() @MaxLength(60) branch?: string;
  @IsOptional() @IsDateString() expenseDate?: string;
}
