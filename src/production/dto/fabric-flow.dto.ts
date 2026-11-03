import { FabricDeliveryDestination, KnittingMillType, ProcessDeliveryDestination, StockCategory } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsEnum, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';

/**
 * One colour a knitting batch's grey fabric is dyed in: it becomes a dyeing lot with its own code (…-DY01). The KG can
 * be left out on one colour, which then takes all the grey fabric left.
 */
export class DyeingLotLineDto {
  @IsString() @IsNotEmpty({ message: 'Enter the colour of every dyeing lot' }) @MaxLength(80) color!: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) kg?: number;
}

/**
 * Starts dyeing or compacting with a batch's fabric from a warehouse: all of it goes (the weights are entered when the
 * process completes). With the mill, the process is started there in the same step.
 */
export class StartStockProcessDto {
  @IsIn(['dyeing', 'compacting']) process!: 'dyeing' | 'compacting';
  @IsString() @IsNotEmpty() @MaxLength(80) itemCode!: string;
  @IsUUID() warehouseId!: string;
  /** All that is in stock when left out. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) quantityKg?: number;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsString() @MaxLength(200) partyDetails?: string;
  @IsOptional() @IsString() @MaxLength(200) millDetails?: string;
  @IsOptional() @IsString() @MaxLength(80) color?: string;
  /** Dyeing: the colours, each a dyeing lot; one lot in `color` (all the stock) when left out. */
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => DyeingLotLineDto) lots?: DyeingLotLineDto[];
  @IsOptional() @IsString() @MaxLength(80) inwardNo?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
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
  /** Price of the yarn per KG; its latest purchase rate when left out (it is confirmed when knitting finishes). */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) yarnRatePerKg?: number;
}

/**
 * One fabric type knitted from the yarn (Type 1, Type 2…): each is a knitting batch of its own (…-KT01, -KT02).
 * With several types each takes its yarn KG, except one that may leave it out to take the rest.
 */
export class KnittingFabricDto {
  @IsString() @IsNotEmpty({ message: 'Enter the fabric type of every type' }) @MaxLength(120) fabricType!: string;
  @IsString() @IsNotEmpty({ message: 'Enter the diameter of every type' }) @MaxLength(40) fabricDiameter!: string;
  @IsOptional() @IsString() @MaxLength(20) fabricGsm?: string;
  @IsOptional() @IsString() @MaxLength(40) gg?: string;
  @IsOptional() @IsString() @MaxLength(40) ll?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) yarnKg?: number;
}

/**
 * Starts a batch: takes yarn out of a warehouse by its item code (the stock position is item + lot + warehouse
 * + category) and begins knitting it. The batch is known by the yarn's code. With `fabrics`, one batch per fabric
 * type, sharing the yarn.
 */
export class StartKnittingDto extends KnittingDetailsDto {
  @IsEnum(KnittingMillType) millType!: KnittingMillType;
  /** The fabric types to knit, each its own batch; the single type below when left out. */
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => KnittingFabricDto) fabrics?: KnittingFabricDto[];
  @ValidateIf((o: StartKnittingDto) => !o.fabrics?.length) @IsString() @IsNotEmpty({ message: 'Fabric type is required' }) @MaxLength(120) fabricType!: string;
  @ValidateIf((o: StartKnittingDto) => !o.fabrics?.length) @IsString() @IsNotEmpty({ message: 'Fabric diameter is required' }) @MaxLength(40) fabricDiameter!: string;
  /** Grams per square metre, e.g. 180; optional. */
  @IsOptional() @IsString() @MaxLength(20) fabricGsm?: string;
  @IsString() @IsNotEmpty() @MaxLength(80) yarnItemCode!: string;
  @IsUUID() warehouseId!: string;
  @IsOptional() @IsString() @MaxLength(60) yarnLotNo?: string;
  @IsEnum(StockCategory) yarnCategory!: StockCategory;
  /** All of the yarn in that position when left out; what was used is entered when knitting finishes. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) yarnKg?: number;
  /** The fabric to make; the yarn sent is what it needs, and the rest of the stock stays in the warehouse. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) plannedFabricKg?: number;
}

/** Knitting done: the rolls and total weight that go on to dyeing. */
export class FinishKnittingDto {
  @IsDateString() finishedDate!: string;
  @IsInt() @Min(1) rollCount!: number;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) totalWeightKg!: number;
  @IsString() @IsNotEmpty({ message: 'Delivery place is required' }) @MaxLength(200) deliveryPlace!: string;
  @IsEnum(ProcessDeliveryDestination) destination!: ProcessDeliveryDestination;
  @ValidateIf((d: FinishKnittingDto) => d.destination === ProcessDeliveryDestination.WAREHOUSE) @IsUUID(undefined, { message: 'Choose the warehouse' }) warehouseId?: string;
  @ValidateIf((d: FinishKnittingDto) => d.destination === ProcessDeliveryDestination.NEXT_PROCESS) @IsString() @IsNotEmpty({ message: 'Choose the dyeing party' }) @MaxLength(200) nextPartyDetails?: string;
  @ValidateIf((d: FinishKnittingDto) => d.destination === ProcessDeliveryDestination.NEXT_PROCESS) @IsString() @IsNotEmpty({ message: 'Select a mill or enter the dyeing location' }) @MaxLength(200) nextMillDetails?: string;
  /** Delivered to a party: who, what they paid, and what the delivery cost. */
  @ValidateIf((d: FinishKnittingDto) => d.destination === ProcessDeliveryDestination.PARTY) @IsString() @IsNotEmpty({ message: 'Enter who the fabric went to' }) @MaxLength(160) partyName?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) amount?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) deliveryExpense?: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) knittingExpense!: number;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  /** The yarn knitting actually used, of what it was given; the rest goes back into stock. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) yarnUsedKg?: number;
  /** The yarn's price per KG, confirmed now. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) yarnRatePerKg?: number;
}

/** Dyeing started: the grey fabric is at the dyeing party and mill. Completed later with its output. */
export class StartDyeingDto {
  @IsDateString() startDate!: string;
  @IsString() @IsNotEmpty({ message: 'Dyeing party is required' }) @MaxLength(200) partyDetails!: string;
  @IsString() @IsNotEmpty({ message: 'Dyeing mill is required' }) @MaxLength(200) millDetails!: string;
  /** A dyeing lot (or an older batch) being corrected: the fabric received. A knitting batch's lots take theirs from `lots`. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) fabricReceivedKg?: number;
  @IsOptional() @IsString() @MaxLength(80) color?: string;
  /** A knitting batch's colours, each a dyeing lot; one lot in `color` with all the grey fabric left when left out. */
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => DyeingLotLineDto) lots?: DyeingLotLineDto[];
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
  /** The grey fabric as weighed at the mill; the weight received when left out. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) dyeingGreyWeightKg?: number;
  @IsString() @IsNotEmpty({ message: 'Enter the colour' }) @MaxLength(80) color!: string;
  /** The yarn count; kept as it was (or the yarn's name) when left out. */
  @IsOptional() @IsString() @MaxLength(80) dyeingCount?: string;
  @IsInt() @Min(0) rollCount!: number;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) dyeingOutputWeightKg!: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) dyeingExpense!: number;
  @IsOptional() @IsString() @MaxLength(1000) dyeingNotes?: string;
  /** The weight sent on; all of the dyed output when left out. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) compactingDeliveryKg?: number;
  @IsEnum(ProcessDeliveryDestination) destination!: ProcessDeliveryDestination;
  @ValidateIf((d: UpdateFabricDyeingDto) => d.destination === ProcessDeliveryDestination.WAREHOUSE) @IsUUID(undefined, { message: 'Choose the warehouse' }) warehouseId?: string;
  @ValidateIf((d: UpdateFabricDyeingDto) => d.destination === ProcessDeliveryDestination.NEXT_PROCESS) @IsString() @IsNotEmpty({ message: 'Choose the compacting party' }) @MaxLength(200) nextPartyDetails?: string;
  @ValidateIf((d: UpdateFabricDyeingDto) => d.destination === ProcessDeliveryDestination.NEXT_PROCESS) @IsString() @IsNotEmpty({ message: 'Select a mill or enter the compacting location' }) @MaxLength(200) nextMillDetails?: string;
  /** Grey fabric dyeing didn't use, back into a warehouse (0 or left out: none). */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) balanceKg?: number;
  @ValidateIf((d: UpdateFabricDyeingDto) => (d.balanceKg ?? 0) > 0) @IsUUID(undefined, { message: 'Choose the warehouse the balance goes to' }) balanceWarehouseId?: string;
  /** Delivered to a party: who, what they paid, and what the delivery cost. */
  @ValidateIf((d: UpdateFabricDyeingDto) => d.destination === ProcessDeliveryDestination.PARTY) @IsString() @IsNotEmpty({ message: 'Enter who the fabric went to' }) @MaxLength(160) partyName?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) amount?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) deliveryExpense?: number;
}

/** Where the finished fabric goes when compacting is completed: a party or a warehouse (all of it). */
export class CompactingDeliveryDto {
  @IsEnum(FabricDeliveryDestination) destination!: FabricDeliveryDestination;
  @ValidateIf((d: CompactingDeliveryDto) => d.destination === FabricDeliveryDestination.CUSTOMER) @IsString() @IsNotEmpty({ message: 'Enter who the fabric went to' }) @MaxLength(160) partyName?: string;
  @ValidateIf((d: CompactingDeliveryDto) => d.destination === FabricDeliveryDestination.WAREHOUSE) @IsUUID(undefined, { message: 'Choose the warehouse' }) warehouseId?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) amount?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) expense?: number;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  /** Rolls going; the dyed rolls when left out. */
  @IsOptional() @IsInt() @Min(0) packages?: number;
}

/** Completes compacting (or corrects it): the compacted weight is the finished fabric. `compactingDate` is when it started. */
export class UpdateFabricCompactingDto {
  @IsDateString() compactingDate!: string;
  /** When compacting was completed; the start date when left out. */
  @IsOptional() @IsDateString() finishedDate?: string;
  @IsString() @IsNotEmpty({ message: 'Compacting party is required' }) @MaxLength(200) compactingPartyDetails!: string;
  @IsString() @IsNotEmpty({ message: 'Compacting mill is required' }) @MaxLength(200) compactingMillDetails!: string;
  /** The mill's inward and outward gate pass / challan numbers, when they give them. */
  @IsOptional() @IsString() @MaxLength(80) compactingInwardNo?: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) compactingReceivedKg!: number;
  @IsOptional() @IsString() @MaxLength(80) compactingOutwardNo?: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) officeDeliveryKg!: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) compactingExpense!: number;
  @IsOptional() @IsString() @MaxLength(1000) compactingNotes?: string;
  /** Delivered with the completion: all of the finished fabric, to a party or a warehouse. */
  @IsOptional() @ValidateNested() @Type(() => CompactingDeliveryDto) delivery?: CompactingDeliveryDto;
  /** Dyed fabric compacting didn't use, back into a warehouse (0 or left out: none). */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) balanceKg?: number;
  @ValidateIf((d: UpdateFabricCompactingDto) => (d.balanceKg ?? 0) > 0) @IsUUID(undefined, { message: 'Choose the warehouse the balance goes to' }) balanceWarehouseId?: string;
}

/** A warehouse confirming fabric sent to it from production: when it arrived and what it weighed there. */
export class ReceiveFabricDto {
  @IsDateString() receivedDate!: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) receivedWeightKg!: number;
  /** Rolls / bags counted at the warehouse, to check against the challan. */
  @IsOptional() @IsInt() @Min(0) receivedPackages?: number;
  /** Anything noticed on receipt: damp rolls, torn bags… */
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
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
  /** Rolls (or bags) going, printed on the delivery challan. */
  @IsOptional() @IsInt() @Min(0) packages?: number;
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

/** Transport details and remarks on a process delivery challan. */
export class UpdateProcessChallanDto {
  @IsOptional() @IsString() @MaxLength(30) vehicleNo?: string;
  @IsOptional() @IsString() @MaxLength(80) driverName?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}
