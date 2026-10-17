import { FabricDeliveryDestination, KnittingMillType, ProcessDeliveryDestination, StockCategory } from '@prisma/client';
import { IsDateString, IsEnum, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateIf } from 'class-validator';

export class StartStockProcessDto {
  @IsIn(['dyeing', 'compacting']) process!: 'dyeing' | 'compacting';
  @IsString() @IsNotEmpty() @MaxLength(80) itemCode!: string;
  @IsUUID() warehouseId!: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) quantityKg!: number;
}

/** Knitting details that can still be corrected while the batch is knitting. */
export class KnittingDetailsDto {
  @IsDateString() startDate!: string;
  @IsOptional() @IsDateString() expectedFinishDate?: string;
  /** Optional for outside-mill work: the selected mill is also the responsible party. */
  @IsOptional() @IsString() @MaxLength(200) partyDetails?: string;
  @IsString() @IsNotEmpty({ message: 'Mill is required' }) @MaxLength(200) millDetails!: string;
  @IsOptional() @IsString() @MaxLength(40) gg?: string;
  @IsOptional() @IsString() @MaxLength(40) ll?: string;
  /** Price of the yarn per KG; defaults from its purchase rate. */
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) yarnRatePerKg!: number;
}

/**
 * Starts a batch: takes yarn out of a warehouse by its item code (the stock position is item + lot + warehouse
 * + category) and begins knitting it. The batch is known by the yarn's code.
 */
export class StartKnittingDto extends KnittingDetailsDto {
  @IsEnum(KnittingMillType) millType!: KnittingMillType;
  @IsString() @IsNotEmpty({ message: 'Fabric type is required' }) @MaxLength(120) fabricType!: string;
  @IsString() @IsNotEmpty({ message: 'Fabric diameter is required' }) @MaxLength(40) fabricDiameter!: string;
  /** Grams per square metre, e.g. 180; optional. */
  @IsOptional() @IsString() @MaxLength(20) fabricGsm?: string;
  @IsString() @IsNotEmpty() @MaxLength(80) yarnItemCode!: string;
  @IsUUID() warehouseId!: string;
  @IsOptional() @IsString() @MaxLength(60) yarnLotNo?: string;
  @IsEnum(StockCategory) yarnCategory!: StockCategory;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) yarnKg!: number;
}

/** Knitting done: the bags and total weight that go on to dyeing. */
export class FinishKnittingDto {
  @IsDateString() finishedDate!: string;
  @IsInt() @Min(1) bagCount!: number;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) totalWeightKg!: number;
  @IsString() @IsNotEmpty({ message: 'Delivery place is required' }) @MaxLength(200) deliveryPlace!: string;
  @IsEnum(ProcessDeliveryDestination) destination!: ProcessDeliveryDestination;
  @ValidateIf((d: FinishKnittingDto) => d.destination === ProcessDeliveryDestination.WAREHOUSE) @IsUUID(undefined, { message: 'Choose the warehouse' }) warehouseId?: string;
  @ValidateIf((d: FinishKnittingDto) => d.destination === ProcessDeliveryDestination.NEXT_PROCESS) @IsString() @IsNotEmpty({ message: 'Choose the dyeing party' }) @MaxLength(200) nextPartyDetails?: string;
  @ValidateIf((d: FinishKnittingDto) => d.destination === ProcessDeliveryDestination.NEXT_PROCESS) @IsString() @IsNotEmpty({ message: 'Select a mill or enter the dyeing location' }) @MaxLength(200) nextMillDetails?: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) knittingExpense!: number;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

/** Dyeing started: the grey fabric is at the dyeing party and mill. Completed later with its output. */
export class StartDyeingDto {
  @IsDateString() startDate!: string;
  @IsString() @IsNotEmpty({ message: 'Dyeing party is required' }) @MaxLength(200) partyDetails!: string;
  @IsString() @IsNotEmpty({ message: 'Dyeing mill is required' }) @MaxLength(200) millDetails!: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) fabricReceivedKg!: number;
  @IsOptional() @IsString() @MaxLength(80) color?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

/** Compacting started: the dyed fabric is at the compacting party and mill. Completed later with the compacted weight. */
export class StartCompactingDto {
  @IsDateString() startDate!: string;
  @IsString() @IsNotEmpty({ message: 'Compacting party is required' }) @MaxLength(200) partyDetails!: string;
  @IsString() @IsNotEmpty({ message: 'Compacting mill is required' }) @MaxLength(200) millDetails!: string;
  @IsOptional() @IsString() @MaxLength(80) inwardNo?: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) receivedKg!: number;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

/** Completes dyeing (or corrects it): output, delivery to compacting or a warehouse. `dyeingDate` is when it started. */
export class UpdateFabricDyeingDto {
  @IsDateString() dyeingDate!: string;
  /** When dyeing was completed; the start date when left out. */
  @IsOptional() @IsDateString() finishedDate?: string;
  @IsString() @IsNotEmpty() dyeingPartyDetails!: string;
  @IsString() @IsNotEmpty() dyeingMillDetails!: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) fabricReceivedKg!: number;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) dyeingGreyWeightKg!: number;
  @IsString() @IsNotEmpty() color!: string;
  @IsString() @IsNotEmpty() dyeingCount!: string;
  @IsInt() @Min(0) rollCount!: number;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) dyeingOutputWeightKg!: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) dyeingExpense!: number;
  @IsOptional() @IsString() @MaxLength(1000) dyeingNotes?: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) compactingDeliveryKg!: number;
  @IsEnum(ProcessDeliveryDestination) destination!: ProcessDeliveryDestination;
  @ValidateIf((d: UpdateFabricDyeingDto) => d.destination === ProcessDeliveryDestination.WAREHOUSE) @IsUUID(undefined, { message: 'Choose the warehouse' }) warehouseId?: string;
  @ValidateIf((d: UpdateFabricDyeingDto) => d.destination === ProcessDeliveryDestination.NEXT_PROCESS) @IsString() @IsNotEmpty({ message: 'Choose the compacting party' }) @MaxLength(200) nextPartyDetails?: string;
  @ValidateIf((d: UpdateFabricDyeingDto) => d.destination === ProcessDeliveryDestination.NEXT_PROCESS) @IsString() @IsNotEmpty({ message: 'Select a mill or enter the compacting location' }) @MaxLength(200) nextMillDetails?: string;
}

/** Completes compacting (or corrects it): the compacted weight is the finished fabric. `compactingDate` is when it started. */
export class UpdateFabricCompactingDto {
  @IsDateString() compactingDate!: string;
  /** When compacting was completed; the start date when left out. */
  @IsOptional() @IsDateString() finishedDate?: string;
  @IsString() @IsNotEmpty({ message: 'Compacting party is required' }) @MaxLength(200) compactingPartyDetails!: string;
  @IsString() @IsNotEmpty({ message: 'Compacting mill is required' }) @MaxLength(200) compactingMillDetails!: string;
  @IsString() @IsNotEmpty() compactingInwardNo!: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) compactingReceivedKg!: number;
  @IsString() @IsNotEmpty() compactingOutwardNo!: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) officeDeliveryKg!: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) compactingExpense!: number;
  @IsOptional() @IsString() @MaxLength(1000) compactingNotes?: string;
}

/** A warehouse confirming fabric sent to it from production: when it arrived and what it weighed there. */
export class ReceiveFabricDto {
  @IsDateString() receivedDate!: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) receivedWeightKg!: number;
}

/**
 * Finished fabric sent out of a batch, to a party (typed name) or into a warehouse. A batch can have several
 * (part to a party, the rest into stock); it is delivered once nothing is left at the office.
 */
export class RecordDeliveryDto {
  @IsDateString() deliveredDate!: string;
  @IsEnum(FabricDeliveryDestination) destination!: FabricDeliveryDestination;
  @ValidateIf((d: RecordDeliveryDto) => d.destination === FabricDeliveryDestination.CUSTOMER)
  @IsString({ message: 'Enter who the fabric went to' })
  @MaxLength(160)
  partyName?: string;
  @ValidateIf((d: RecordDeliveryDto) => d.destination === FabricDeliveryDestination.WAREHOUSE)
  @IsUUID(undefined, { message: 'Choose the warehouse' })
  warehouseId?: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) weightKg!: number;
  /** Collected from the party; not used for a warehouse. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) amount?: number;
  /** Transport or other cost of this delivery. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) expense?: number;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class CreateFabricExpenseDto {
  @IsDateString() expenseDate!: string;
  @IsString() @IsNotEmpty() @MaxLength(80) category!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount!: number;
}
