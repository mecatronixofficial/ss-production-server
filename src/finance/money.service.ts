import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import {
  ChequeStatus,
  MoneyAccount,
  MoneyAccountType,
  MoneyPartyType,
  MoneyTxnKind,
  PaymentMode,
  Prisma,
  SalePartyType,
  SaleStatus,
} from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { decryptSecret, encryptionKeyReady, encryptSecret, keyFingerprint, MISSING_KEY_MESSAGE } from '../common/crypto';
import { lockKeys } from '../common/locks';
import { documentNo } from '../common/numbering';
import { MANAGEMENT_ROLES, notifyRoles } from '../notifications/notify.util';
import { PrismaService } from '../prisma/prisma.service';
import { resolveTextile, textileBalance, textileMoney } from '../masters/textiles';
import { ExpenseDto } from './dto/finance.dto';
import {
  ChequeActionDto,
  ExpenseFilterDto,
  MoneyAccountDto,
  MoneyTxnDto,
  MoneyTxnFilterDto,
  StatementQueryDto,
  UpdateMoneyAccountDto,
} from './dto/money.dto';
import {
  ACCOUNT_TYPES_FOR,
  cashFlow,
  CHEQUE_OPEN,
  cleanName,
  COUNTED,
  counts,
  EXPENSE_LIVE,
  isOpenCheque,
  movedOn,
  round2,
  thisMonth,
  TXN_PREFIX,
} from './money-rules';

type Tx = Prisma.TransactionClient;

const ACCOUNT_LABEL: Record<MoneyAccountType, string> = { CASH: 'Cash', BANK: 'Bank', UPI: 'UPI' };
const MODE_TEXT: Record<PaymentMode, string> = { CASH: 'cash', UPI: 'UPI', BANK: 'bank transfer', CHEQUE: 'cheque' };
const KIND_ACTION: Record<MoneyTxnKind, string> = { RECEIPT: 'MONEY_RECEIVED', PAYMENT: 'MONEY_PAID', TRANSFER: 'MONEY_TRANSFERRED' };
/** A date up to a day ahead is accepted (time zones); later is a typing mistake. */
const LATEST = () => new Date(Date.now() + 24 * 3600_000);
const blank = (value?: string | null) => value?.trim() || null;
const money = (value: number) => `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const txnInclude = {
  account: { select: { id: true, name: true, type: true } },
  toAccount: { select: { id: true, name: true, type: true } },
  supplier: { select: { id: true, code: true, name: true } },
  sale: { select: { id: true, saleNo: true, totalAmount: true, status: true } },
  textile: { select: { id: true, code: true, name: true } },
} satisfies Prisma.MoneyTransactionInclude;
type TxnRow = Prisma.MoneyTransactionGetPayload<{ include: typeof txnInclude }>;

/**
 * Money management: the cash, bank and UPI accounts and their balances; every receipt, payment and transfer; cheques
 * from received to cleared or bounced; and what each distributor and textile owes or is owed.
 * Entries are never deleted or edited in amount: a wrong one is cancelled with a reason and entered again, and
 * every change is in the audit log.
 */
/** SystemSetting that remembers which key encrypted the stored account numbers (its fingerprint, not the key). */
const KEY_CHECK_SETTING = 'money.dataEncryptionKeyCheck';
const KEY_CHANGED_MESSAGE =
  'The server is using a different DATA_ENCRYPTION_KEY from the one the saved bank account numbers were encrypted with, so they cannot be read. Put the original key back in the backend .env and restart. (Every server that uses this database needs the same key.)';

@Injectable()
export class MoneyService implements OnModuleInit {
  private readonly logger = new Logger(MoneyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Warns in the server log at startup when account numbers can't be saved or read. Never stops the server. */
  async onModuleInit() {
    try {
      const status = await this.encryptionStatus();
      if (!status.ready) this.logger.warn('DATA_ENCRYPTION_KEY is not set: bank account numbers cannot be saved. See .env.example.');
      else if (status.keyChanged) this.logger.error(KEY_CHANGED_MESSAGE);
    } catch (error) {
      this.logger.warn(`Could not check the data encryption key: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ───────────────────────────── Encryption key ─────────────────────────────

  /**
   * Whether bank account numbers can be saved and read: a key is set (`ready`), and it is the same key the saved
   * numbers were encrypted with (`keyChanged` false). The first time a key is seen it is remembered by fingerprint;
   * numbers saved before that are checked by decrypting one.
   */
  async encryptionStatus() {
    const fingerprint = keyFingerprint();
    const [setting, sample, saved] = await Promise.all([
      this.prisma.systemSetting.findUnique({ where: { key: KEY_CHECK_SETTING } }),
      this.prisma.moneyAccount.findFirst({ where: { accountNoEnc: { not: null } }, select: { accountNoEnc: true } }),
      this.prisma.moneyAccount.count({ where: { accountNoEnc: { not: null } } }),
    ]);
    const known = (setting?.value as { fingerprint?: string } | null)?.fingerprint ?? null;
    let keyChanged = false;
    if (fingerprint && known) keyChanged = known !== fingerprint;
    else if (fingerprint && sample?.accountNoEnc) {
      try {
        decryptSecret(sample.accountNoEnc);
        await this.rememberKey(fingerprint);
      } catch {
        keyChanged = true;
      }
    }
    return { ready: !!fingerprint, keyChanged, savedNumbers: saved };
  }

  private rememberKey(fingerprint: string) {
    return this.prisma.systemSetting.upsert({
      where: { key: KEY_CHECK_SETTING },
      create: { key: KEY_CHECK_SETTING, value: { fingerprint } },
      update: { value: { fingerprint } },
    });
  }

  /** Before encrypting a new number: there must be a key, and it must be the one already used. */
  private async assertCanStoreNumber() {
    if (!encryptionKeyReady()) throw new BadRequestException(MISSING_KEY_MESSAGE);
    const status = await this.encryptionStatus();
    if (status.keyChanged) throw new BadRequestException(KEY_CHANGED_MESSAGE);
    await this.rememberKey(keyFingerprint()!);
  }

  // ───────────────────────────── Accounts ─────────────────────────────

  /** Never sends the encrypted number; only its last 4 digits. */
  private accountView(account: MoneyAccount) {
    const { accountNoEnc, ...rest } = account;
    return {
      ...rest,
      openingBalance: Number(account.openingBalance),
      hasAccountNo: !!accountNoEnc,
      accountNoMasked: account.accountNoLast4 ? `XXXX XXXX ${account.accountNoLast4}` : null,
    };
  }

  private async sumByAccount(where: Prisma.MoneyTransactionWhereInput) {
    const rows = await this.prisma.moneyTransaction.groupBy({
      by: ['accountId'],
      where: { AND: [where, { accountId: { not: null } }] },
      _sum: { amount: true },
    });
    return new Map(rows.map((row) => [row.accountId!, Number(row._sum.amount ?? 0)]));
  }

  /**
   * Each account with its balance: opening + received + transfers in − paid − transfers out − expenses paid from it.
   * Cheques count once cleared; `chequesToClear` are received cheques deposited into it, `chequesIssued` are cheques
   * written on it that have not cleared yet (the balance will go down by that much).
   */
  async accounts() {
    const [accounts, received, sent, transfersIn, expenses, chequesToClear, chequesIssued, lastTxn] = await Promise.all([
      this.prisma.moneyAccount.findMany({ orderBy: [{ active: 'desc' }, { type: 'asc' }, { name: 'asc' }] }),
      this.sumByAccount({ AND: [COUNTED, { kind: MoneyTxnKind.RECEIPT }] }),
      this.sumByAccount({ AND: [COUNTED, { kind: { in: [MoneyTxnKind.PAYMENT, MoneyTxnKind.TRANSFER] } }] }),
      this.prisma.moneyTransaction.groupBy({
        by: ['toAccountId'],
        where: { AND: [COUNTED, { kind: MoneyTxnKind.TRANSFER, toAccountId: { not: null } }] },
        _sum: { amount: true },
      }),
      this.prisma.expense.groupBy({ by: ['accountId'], where: { ...EXPENSE_LIVE, accountId: { not: null } }, _sum: { amount: true } }),
      this.sumByAccount({ AND: [CHEQUE_OPEN, { kind: MoneyTxnKind.RECEIPT }] }),
      this.sumByAccount({ AND: [CHEQUE_OPEN, { kind: MoneyTxnKind.PAYMENT }] }),
      this.prisma.moneyTransaction.groupBy({
        by: ['accountId'],
        where: { cancelledAt: null, accountId: { not: null } },
        _max: { txnDate: true },
      }),
    ]);
    const inBy = new Map(transfersIn.map((row) => [row.toAccountId!, Number(row._sum.amount ?? 0)]));
    const expenseBy = new Map(expenses.map((row) => [row.accountId!, Number(row._sum.amount ?? 0)]));
    const lastBy = new Map(lastTxn.map((row) => [row.accountId!, row._max.txnDate]));
    return accounts.map((account) => {
      const moneyIn = (received.get(account.id) ?? 0) + (inBy.get(account.id) ?? 0);
      const moneyOut = (sent.get(account.id) ?? 0) + (expenseBy.get(account.id) ?? 0);
      return {
        ...this.accountView(account),
        moneyIn: round2(moneyIn),
        moneyOut: round2(moneyOut),
        balance: round2(Number(account.openingBalance) + moneyIn - moneyOut),
        chequesToClear: round2(chequesToClear.get(account.id) ?? 0),
        chequesIssued: round2(chequesIssued.get(account.id) ?? 0),
        lastTxnAt: lastBy.get(account.id) ?? null,
      };
    });
  }

  private async assertNameFree(name: string, exceptId?: string) {
    const clash = await this.prisma.moneyAccount.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (clash) throw new ConflictException(`An account named "${name}" already exists`);
  }

  /**
   * The stored fields for an account of a type: a bank account has bank details (and may have a UPI ID on it), a UPI
   * account has its UPI ID, cash has neither. `accountNo` undefined keeps the saved number, null removes it.
   */
  private accountFields(type: MoneyAccountType, d: UpdateMoneyAccountDto, current?: MoneyAccount) {
    const pick = <K extends keyof UpdateMoneyAccountDto & keyof MoneyAccount>(key: K) =>
      d[key] !== undefined ? blank(d[key] as string | null) : current ? (current[key] as string | null) : null;
    const name = cleanName(d.name ?? current?.name ?? '');
    if (!name) throw new BadRequestException('Give the account a name');
    const fields = {
      type,
      name,
      bankName: null as string | null,
      branch: null as string | null,
      ifsc: null as string | null,
      accountHolder: null as string | null,
      upiId: null as string | null,
      accountNoEnc: null as string | null,
      accountNoLast4: null as string | null,
      notes: pick('notes'),
    };
    if (type === MoneyAccountType.CASH) return fields;
    fields.upiId = pick('upiId');
    fields.bankName = pick('bankName');
    if (type === MoneyAccountType.UPI) {
      if (!fields.upiId) throw new BadRequestException('Enter the UPI ID, like business@okaxis');
      return fields;
    }
    if (!fields.bankName) throw new BadRequestException('Enter the bank name');
    fields.branch = pick('branch');
    fields.ifsc = pick('ifsc');
    fields.accountHolder = pick('accountHolder');
    if (d.accountNo === undefined) {
      fields.accountNoEnc = current?.type === MoneyAccountType.BANK ? current.accountNoEnc : null;
      fields.accountNoLast4 = current?.type === MoneyAccountType.BANK ? current.accountNoLast4 : null;
    } else if (d.accountNo) {
      fields.accountNoEnc = encryptSecret(d.accountNo);
      fields.accountNoLast4 = d.accountNo.slice(-4);
    }
    return fields;
  }

  async createAccount(dto: MoneyAccountDto, user: AuthUser) {
    if (dto.type === MoneyAccountType.BANK && dto.accountNo) await this.assertCanStoreNumber();
    const fields = this.accountFields(dto.type, dto);
    await this.assertNameFree(fields.name);
    const account = await this.prisma.$transaction(async (tx) => {
      const created = await tx.moneyAccount.create({ data: { ...fields, openingBalance: dto.openingBalance ?? 0, createdById: user.id } });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'MONEY_ACCOUNT_CREATED',
          module: 'money',
          entity: 'MoneyAccount',
          entityId: created.id,
          newValue: {
            type: created.type,
            name: created.name,
            bank: created.bankName,
            accountNo: created.accountNoLast4 ? `XXXX${created.accountNoLast4}` : null,
            openingBalance: Number(created.openingBalance),
          },
        },
      });
      return created;
    });
    return this.accountView(account);
  }

  async updateAccount(id: string, dto: UpdateMoneyAccountDto, user: AuthUser) {
    const current = await this.prisma.moneyAccount.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Account not found');
    const type = dto.type ?? current.type;
    if (type !== current.type) {
      const used = await this.prisma.moneyTransaction.count({ where: { OR: [{ accountId: id }, { toAccountId: id }] } });
      const spent = await this.prisma.expense.count({ where: { accountId: id } });
      if (used || spent)
        throw new BadRequestException(`${current.name} already has entries; its type can't change. Add a new account instead.`);
    }
    if (type === MoneyAccountType.BANK && dto.accountNo) await this.assertCanStoreNumber();
    const fields = this.accountFields(type, dto, current);
    if (fields.name.toLowerCase() !== current.name.toLowerCase()) await this.assertNameFree(fields.name, id);
    const openingBalance = dto.openingBalance === undefined ? undefined : (dto.openingBalance ?? 0);
    const account = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.moneyAccount.update({
        where: { id },
        data: {
          ...fields,
          ...(openingBalance !== undefined ? { openingBalance } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
        },
      });
      const changed = (['type', 'name', 'bankName', 'branch', 'ifsc', 'accountHolder', 'upiId', 'notes', 'active'] as const).filter(
        (key) => current[key] !== updated[key],
      );
      if (current.accountNoEnc !== updated.accountNoEnc) changed.push('accountNo' as never);
      const openingChanged = Number(current.openingBalance) !== Number(updated.openingBalance);
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: dto.active === false && current.active ? 'MONEY_ACCOUNT_DEACTIVATED' : 'MONEY_ACCOUNT_UPDATED',
          module: 'money',
          entity: 'MoneyAccount',
          entityId: id,
          previousValue: {
            name: current.name,
            ...(openingChanged ? { openingBalance: Number(current.openingBalance) } : {}),
            accountNo: current.accountNoLast4 ? `XXXX${current.accountNoLast4}` : null,
          },
          newValue: {
            changed,
            ...(openingChanged ? { openingBalance: Number(updated.openingBalance) } : {}),
            accountNo: updated.accountNoLast4 ? `XXXX${updated.accountNoLast4}` : null,
          },
        },
      });
      return updated;
    });
    return this.accountView(account);
  }

  /** The full account number, for a super admin only; every view is in the audit log. */
  async revealAccountNo(id: string, user: AuthUser, ipAddress?: string, userAgent?: string) {
    const account = await this.prisma.moneyAccount.findUnique({ where: { id }, select: { id: true, name: true, accountNoEnc: true } });
    if (!account) throw new NotFoundException('Account not found');
    if (!account.accountNoEnc) throw new BadRequestException('No account number is saved for this account');
    if (!encryptionKeyReady()) throw new BadRequestException(MISSING_KEY_MESSAGE);
    let accountNo: string;
    try {
      accountNo = decryptSecret(account.accountNoEnc);
    } catch {
      throw new BadRequestException(KEY_CHANGED_MESSAGE);
    }
    await this.prisma.auditLog.create({
      data: {
        actorId: user.id,
        action: 'BANK_ACCOUNT_NUMBER_VIEWED',
        module: 'money',
        entity: 'MoneyAccount',
        entityId: id,
        newValue: { account: account.name },
        ipAddress,
        userAgent,
      },
    });
    return { accountNo };
  }

  private async activeAccount(db: Tx | PrismaService, id: string | undefined, label: string) {
    if (!id) throw new BadRequestException(`Choose the account ${label}`);
    const account = await db.moneyAccount.findUnique({ where: { id } });
    if (!account) throw new BadRequestException('Account not found');
    if (!account.active) throw new BadRequestException(`${account.name} is inactive; choose another account`);
    return account;
  }

  private checkAccountFor(mode: PaymentMode, account: MoneyAccount) {
    const allowed = ACCOUNT_TYPES_FOR[mode];
    if (!allowed.includes(account.type)) {
      const where = allowed.map((t) => ACCOUNT_LABEL[t].toLowerCase()).join(' or ');
      throw new BadRequestException(
        `${mode === PaymentMode.BANK ? 'A bank transfer' : mode === PaymentMode.CHEQUE ? 'A cheque' : mode === PaymentMode.UPI ? 'UPI' : 'Cash'} goes through a ${where} account, not ${account.name}`,
      );
    }
  }

  // ───────────────────────────── Entries ─────────────────────────────

  private async names(ids: Array<string | null>) {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    const users = unique.length ? await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } }) : [];
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private txnView(t: TxnRow, people: Map<string, string>) {
    return {
      ...t,
      amount: Number(t.amount),
      sale: t.sale ? { ...t.sale, totalAmount: Number(t.sale.totalAmount) } : null,
      counted: counts(t),
      createdBy: t.createdById ? (people.get(t.createdById) ?? null) : null,
      cancelledBy: t.cancelledById ? (people.get(t.cancelledById) ?? null) : null,
    };
  }

  async transactions(f: MoneyTxnFilterDto) {
    const and: Prisma.MoneyTransactionWhereInput[] = [];
    if (!f.includeCancelled) and.push({ cancelledAt: null });
    if (f.kind) and.push({ kind: f.kind });
    if (f.mode) and.push({ mode: f.mode });
    if (f.accountId) and.push({ OR: [{ accountId: f.accountId }, { toAccountId: f.accountId }] });
    if (f.partyType) and.push({ partyType: f.partyType });
    if (f.supplierId) and.push({ supplierId: f.supplierId });
    if (f.textileId) and.push({ textileId: f.textileId });
    if (f.party) and.push({ partyName: { equals: cleanName(f.party), mode: 'insensitive' } });
    if (f.saleId) and.push({ saleId: f.saleId });
    if (f.chequeStatus === 'OPEN') and.push(CHEQUE_OPEN);
    else if (f.chequeStatus) and.push({ mode: PaymentMode.CHEQUE, chequeStatus: f.chequeStatus });
    if (f.from || f.to) and.push({ txnDate: { ...(f.from ? { gte: new Date(f.from) } : {}), ...(f.to ? { lte: new Date(f.to) } : {}) } });
    const rows = await this.prisma.moneyTransaction.findMany({
      where: { AND: and },
      include: txnInclude,
      orderBy: [{ txnDate: 'desc' }, { createdAt: 'desc' }],
      take: 2000,
    });
    const people = await this.names(rows.flatMap((r) => [r.createdById, r.cancelledById]));
    return rows.map((row) => this.txnView(row, people));
  }

  async findOne(id: string) {
    const row = await this.prisma.moneyTransaction.findUnique({ where: { id }, include: txnInclude });
    if (!row) throw new NotFoundException('Entry not found');
    return this.txnView(row, await this.names([row.createdById, row.cancelledById]));
  }

  /**
   * Who the money is from / to: a sale's party, a distributor, a textile from the Textiles list (a new name is added
   * to it), or a named other party.
   */
  private async party(dto: MoneyTxnDto) {
    if (dto.saleId) {
      if (dto.kind !== MoneyTxnKind.RECEIPT) throw new BadRequestException('Only money received can be recorded against a sale bill');
      const sale = await this.prisma.sale.findUnique({
        where: { id: dto.saleId },
        select: { id: true, saleNo: true, status: true, partyType: true, supplierId: true, textileId: true, partyName: true },
      });
      if (!sale) throw new BadRequestException('Sale not found');
      if (sale.status === SaleStatus.CANCELLED)
        throw new BadRequestException(`${sale.saleNo} is cancelled; record the money without a bill`);
      if (sale.partyType === SalePartyType.DISTRIBUTOR) {
        return {
          partyType: MoneyPartyType.DISTRIBUTOR,
          supplierId: sale.supplierId,
          textileId: null,
          partyName: cleanName(sale.partyName),
          sale,
        };
      }
      const textile = await resolveTextile(this.prisma, { textileId: sale.textileId, name: sale.partyName });
      return { partyType: MoneyPartyType.TEXTILE, supplierId: null, textileId: textile.id, partyName: textile.name, sale };
    }
    if (dto.partyType === MoneyPartyType.DISTRIBUTOR) {
      const supplier = await this.prisma.supplier.findUnique({ where: { id: dto.supplierId }, select: { id: true, name: true } });
      if (!supplier) throw new BadRequestException('Distributor not found');
      return { partyType: MoneyPartyType.DISTRIBUTOR, supplierId: supplier.id, textileId: null, partyName: supplier.name, sale: null };
    }
    if (dto.partyType === MoneyPartyType.TEXTILE) {
      const textile = await resolveTextile(this.prisma, { textileId: dto.textileId, name: dto.partyName });
      return { partyType: MoneyPartyType.TEXTILE, supplierId: null, textileId: textile.id, partyName: textile.name, sale: null };
    }
    const name = cleanName(dto.partyName ?? '');
    if (!name) throw new BadRequestException('Enter the party name');
    return { partyType: MoneyPartyType.OTHER, supplierId: null, textileId: null, partyName: name, sale: null };
  }

  /** The same cheque or bank reference entered twice is almost always a double entry. */
  private async assertNotDuplicate(
    tx: Tx,
    dto: MoneyTxnDto,
    party: { supplierId: string | null; textileId: string | null; partyName: string | null },
    accountId: string | null,
  ) {
    if (dto.mode === PaymentMode.CHEQUE && dto.chequeNo) {
      const same = await tx.moneyTransaction.findFirst({
        where: {
          cancelledAt: null,
          kind: dto.kind,
          mode: PaymentMode.CHEQUE,
          chequeNo: dto.chequeNo,
          ...(dto.kind === MoneyTxnKind.PAYMENT
            ? { accountId }
            : party.supplierId
              ? { supplierId: party.supplierId }
              : party.textileId
                ? { textileId: party.textileId }
                : { partyName: { equals: party.partyName ?? '', mode: 'insensitive' } }),
        },
        select: { txnNo: true },
      });
      if (same) throw new ConflictException(`Cheque ${dto.chequeNo} is already recorded on ${same.txnNo}`);
    }
    const ref = blank(dto.referenceNo);
    if (ref && ref.length >= 6 && (dto.mode === PaymentMode.UPI || dto.mode === PaymentMode.BANK)) {
      const same = await tx.moneyTransaction.findFirst({
        where: { cancelledAt: null, kind: dto.kind, referenceNo: { equals: ref, mode: 'insensitive' } },
        select: { txnNo: true },
      });
      if (same) throw new ConflictException(`Reference ${ref} is already recorded on ${same.txnNo}`);
    }
  }

  async create(dto: MoneyTxnDto, user: AuthUser) {
    const txnDate = new Date(dto.txnDate);
    if (txnDate > LATEST()) throw new BadRequestException("The date can't be in the future");
    const amount = round2(dto.amount);
    const isCheque = dto.mode === PaymentMode.CHEQUE;

    let account: MoneyAccount | null = null;
    let toAccount: MoneyAccount | null = null;
    let party: Awaited<ReturnType<MoneyService['party']>> | null = null;
    if (dto.kind === MoneyTxnKind.TRANSFER) {
      if (isCheque) throw new BadRequestException('A transfer between your own accounts is cash, bank or UPI');
      account = await this.activeAccount(this.prisma, dto.accountId, 'the money leaves');
      toAccount = await this.activeAccount(this.prisma, dto.toAccountId, 'the money goes into');
      if (account.id === toAccount.id) throw new BadRequestException('Choose two different accounts');
    } else {
      // A received cheque goes into a bank only when deposited; every other entry needs its account now.
      if (dto.accountId || !(isCheque && dto.kind === MoneyTxnKind.RECEIPT)) {
        account = await this.activeAccount(
          this.prisma,
          dto.accountId,
          isCheque ? 'the cheque is drawn on' : dto.kind === MoneyTxnKind.RECEIPT ? 'the money came into' : 'the money was paid from',
        );
        this.checkAccountFor(dto.mode, account);
      }
      // The party last: a new textile name is added to the list only once the rest is right.
      party = await this.party(dto);
    }

    const chequeStatus = !isCheque ? null : dto.kind === MoneyTxnKind.RECEIPT && account ? ChequeStatus.DEPOSITED : ChequeStatus.PENDING;
    const created = await this.prisma.$transaction(async (tx) => {
      if (party?.sale) {
        await lockKeys(tx, `sale:${party.sale.id}`);
        const sale = await tx.sale.findUniqueOrThrow({
          where: { id: party.sale.id },
          select: { saleNo: true, status: true, totalAmount: true },
        });
        if (sale.status === SaleStatus.CANCELLED) throw new BadRequestException(`${sale.saleNo} was cancelled meanwhile`);
        const taken = await tx.moneyTransaction.aggregate({
          where: { saleId: party.sale.id, kind: MoneyTxnKind.RECEIPT, cancelledAt: null, NOT: { chequeStatus: ChequeStatus.BOUNCED } },
          _sum: { amount: true },
        });
        const open = round2(Number(sale.totalAmount) - Number(taken._sum.amount ?? 0));
        if (amount > open + 0.005) {
          throw new BadRequestException(
            open > 0.005
              ? `Only ${money(open)} is still to be received on ${sale.saleNo}. Record the extra ${money(round2(amount - open))} separately as an advance (without a bill).`
              : `${sale.saleNo} is already fully received${Number(taken._sum.amount ?? 0) > 0 ? ' (counting cheques still to clear)' : ''}. Record this as an advance without a bill.`,
          );
        }
      }
      await this.assertNotDuplicate(
        tx,
        dto,
        { supplierId: party?.supplierId ?? null, textileId: party?.textileId ?? null, partyName: party?.partyName ?? null },
        account?.id ?? null,
      );
      const txn = await tx.moneyTransaction.create({
        data: {
          txnNo: await documentNo(tx, TXN_PREFIX[dto.kind], txnDate),
          kind: dto.kind,
          txnDate,
          mode: dto.mode,
          amount,
          accountId: account?.id ?? null,
          toAccountId: toAccount?.id ?? null,
          partyType: party?.partyType ?? null,
          supplierId: party?.supplierId ?? null,
          textileId: party?.textileId ?? null,
          partyName: party?.partyName ?? null,
          saleId: party?.sale?.id ?? null,
          referenceNo: isCheque ? null : blank(dto.referenceNo),
          chequeNo: isCheque ? dto.chequeNo! : null,
          chequeDate: isCheque ? (dto.chequeDate ? new Date(dto.chequeDate) : txnDate) : null,
          chequeBank: isCheque ? blank(dto.chequeBank) : null,
          chequeStatus,
          depositedAt: chequeStatus === ChequeStatus.DEPOSITED ? txnDate : null,
          notes: blank(dto.notes),
          createdById: user.id,
        },
        include: txnInclude,
      });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: KIND_ACTION[dto.kind],
          module: 'money',
          entity: 'MoneyTransaction',
          entityId: txn.id,
          newValue: {
            txnNo: txn.txnNo,
            amount,
            mode: txn.mode,
            account: txn.account?.name ?? null,
            ...(toAccount ? { to: toAccount.name } : {}),
            ...(txn.partyName ? { party: txn.partyName } : {}),
            ...(txn.sale ? { sale: txn.sale.saleNo } : {}),
            ...(txn.chequeNo ? { chequeNo: txn.chequeNo } : {}),
          },
        },
      });
      return txn;
    });
    return this.txnView(created, await this.names([user.id]));
  }

  /** A wrong entry stays on record but stops counting; enter it again correctly. */
  async cancel(id: string, reason: string, user: AuthUser) {
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `money:${id}`);
      const txn = await tx.moneyTransaction.findUnique({ where: { id } });
      if (!txn) throw new NotFoundException('Entry not found');
      if (txn.cancelledAt) throw new BadRequestException(`${txn.txnNo} is already cancelled`);
      const row = await tx.moneyTransaction.update({
        where: { id },
        data: { cancelledAt: new Date(), cancelledById: user.id, cancelReason: reason },
        include: txnInclude,
      });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'MONEY_ENTRY_CANCELLED',
          module: 'money',
          entity: 'MoneyTransaction',
          entityId: id,
          previousValue: { txnNo: txn.txnNo, amount: Number(txn.amount), mode: txn.mode, chequeStatus: txn.chequeStatus },
          newValue: { reason },
        },
      });
      return row;
    });
    return this.txnView(updated, await this.names([updated.createdById, user.id]));
  }

  /**
   * A received cheque: deposited into a bank, then cleared (the money counts) or bounced. An issued cheque: cleared
   * (the money leaves the bank) or bounced. A bounced cheque counts nowhere, so the party owes / is owed again.
   */
  async chequeAction(id: string, dto: ChequeActionDto, user: AuthUser) {
    const date = dto.date ? new Date(dto.date) : new Date();
    if (date > LATEST()) throw new BadRequestException("The date can't be in the future");
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `money:${id}`);
      const txn = await tx.moneyTransaction.findUnique({ where: { id }, include: { account: true } });
      if (!txn) throw new NotFoundException('Entry not found');
      if (txn.mode !== PaymentMode.CHEQUE) throw new BadRequestException(`${txn.txnNo} is not a cheque`);
      if (txn.cancelledAt) throw new BadRequestException(`${txn.txnNo} is cancelled`);
      if (!isOpenCheque(txn))
        throw new BadRequestException(
          `Cheque ${txn.chequeNo} has already ${txn.chequeStatus === ChequeStatus.CLEARED ? 'cleared' : 'bounced'}`,
        );
      if (date < txn.txnDate)
        throw new BadRequestException(
          `The date can't be before the cheque was ${txn.kind === MoneyTxnKind.RECEIPT ? 'received' : 'given'} (${txn.txnDate.toISOString().slice(0, 10)})`,
        );

      const data: Prisma.MoneyTransactionUpdateInput = {};
      if (dto.action === 'DEPOSIT' || (dto.action === 'CLEAR' && txn.kind === MoneyTxnKind.RECEIPT && !txn.accountId)) {
        if (txn.kind !== MoneyTxnKind.RECEIPT) throw new BadRequestException('Only a received cheque is deposited');
        if (dto.action === 'DEPOSIT' && txn.chequeStatus === ChequeStatus.DEPOSITED)
          throw new BadRequestException(`Cheque ${txn.chequeNo} is already deposited`);
        const bank = await this.activeAccount(tx, dto.accountId, 'the cheque was deposited into');
        this.checkAccountFor(PaymentMode.CHEQUE, bank);
        data.account = { connect: { id: bank.id } };
        data.chequeStatus = ChequeStatus.DEPOSITED;
        data.depositedAt = date;
      }
      if (dto.action === 'CLEAR') {
        data.chequeStatus = ChequeStatus.CLEARED;
        data.clearedAt = date;
      }
      if (dto.action === 'BOUNCE') {
        data.chequeStatus = ChequeStatus.BOUNCED;
        data.bouncedAt = date;
        data.bounceReason = dto.reason!;
      }
      const row = await tx.moneyTransaction.update({ where: { id }, data, include: txnInclude });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: `CHEQUE_${dto.action === 'DEPOSIT' ? 'DEPOSITED' : dto.action === 'CLEAR' ? 'CLEARED' : 'BOUNCED'}`,
          module: 'money',
          entity: 'MoneyTransaction',
          entityId: id,
          previousValue: { status: txn.chequeStatus },
          newValue: {
            txnNo: txn.txnNo,
            chequeNo: txn.chequeNo,
            status: row.chequeStatus,
            account: row.account?.name ?? null,
            ...(dto.reason ? { reason: dto.reason } : {}),
          },
        },
      });
      if (dto.action === 'BOUNCE') {
        await notifyRoles(
          tx,
          MANAGEMENT_ROLES,
          {
            title: `Cheque bounced · ${money(Number(txn.amount))}`,
            message: `Cheque ${txn.chequeNo} ${txn.kind === MoneyTxnKind.RECEIPT ? 'from' : 'to'} ${txn.partyName ?? 'party'} (${txn.txnNo}): ${dto.reason}. ${txn.kind === MoneyTxnKind.RECEIPT ? 'The amount is due again.' : 'The amount is owed again.'}`,
            type: 'PAYMENT_DUE',
            priority: 'HIGH',
            referenceType: 'MoneyTransaction',
            referenceId: id,
          },
          user.id,
        );
      }
      return row;
    });
    return this.txnView(updated, await this.names([updated.createdById]));
  }

  // ───────────────────────────── Parties ─────────────────────────────

  /**
   * What each distributor and textile owes or is owed.
   * - Distributor, purchases: opening + goods received − paid (`payable`; minus is an advance paid to them).
   * - Distributor or textile, sales: dispatched bills − received + refunds paid back (`receivable`; minus is an
   *   advance received from them).
   * Cheques still to clear are shown separately and are not in the balances yet.
   */
  async parties() {
    const [suppliers, purchased, sold, moneyBySupplier, textileList, textileMoneyBy] = await Promise.all([
      this.prisma.supplier.findMany({
        select: { id: true, code: true, name: true, active: true, mobile: true, paymentTerms: true, openingBalance: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.$queryRaw<Array<{ supplierId: string; value: number; last: Date | null }>>`
        SELECT po."supplierId" AS "supplierId", COALESCE(SUM(ri."quantity" * poi."rate"), 0)::float8 AS "value", MAX(pr."receivedAt") AS "last"
        FROM "PurchaseReceiptItem" ri
        JOIN "PurchaseReceipt" pr ON pr."id" = ri."purchaseReceiptId"
        JOIN "PurchaseOrderItem" poi ON poi."id" = ri."purchaseOrderItemId"
        JOIN "PurchaseOrder" po ON po."id" = pr."purchaseOrderId"
        GROUP BY po."supplierId"`,
      this.prisma.sale.groupBy({
        by: ['supplierId'],
        where: { partyType: SalePartyType.DISTRIBUTOR, status: SaleStatus.DISPATCHED, supplierId: { not: null } },
        _sum: { totalAmount: true },
        _count: { _all: true },
        _max: { saleDate: true },
      }),
      this.prisma.$queryRaw<Array<{ supplierId: string; kind: MoneyTxnKind; counted: number; pending: number; last: Date | null }>>`
        SELECT "supplierId", "kind",
          COALESCE(SUM(CASE WHEN "mode" <> 'CHEQUE' OR "chequeStatus" = 'CLEARED' THEN "amount" ELSE 0 END), 0)::float8 AS "counted",
          COALESCE(SUM(CASE WHEN "mode" = 'CHEQUE' AND "chequeStatus" IN ('PENDING', 'DEPOSITED') THEN "amount" ELSE 0 END), 0)::float8 AS "pending",
          MAX("txnDate") AS "last"
        FROM "MoneyTransaction"
        WHERE "cancelledAt" IS NULL AND "supplierId" IS NOT NULL AND "kind" IN ('RECEIPT', 'PAYMENT')
        GROUP BY "supplierId", "kind"`,
      this.prisma.textile.findMany({ orderBy: { name: 'asc' } }),
      textileMoney(this.prisma),
    ]);

    const purchasedBy = new Map(purchased.map((row) => [row.supplierId, row]));
    const soldBy = new Map(sold.map((row) => [row.supplierId!, row]));
    const moneyOf = (rows: typeof moneyBySupplier, id: string, kind: MoneyTxnKind) =>
      rows.find((row) => row.supplierId === id && row.kind === kind);
    const distributors = suppliers.map((s) => {
      const p = purchasedBy.get(s.id);
      const b = soldBy.get(s.id);
      const paid = moneyOf(moneyBySupplier, s.id, MoneyTxnKind.PAYMENT);
      const got = moneyOf(moneyBySupplier, s.id, MoneyTxnKind.RECEIPT);
      const openingBalance = Number(s.openingBalance);
      const purchasedValue = Number(p?.value ?? 0);
      const billed = Number(b?._sum.totalAmount ?? 0);
      return {
        type: MoneyPartyType.DISTRIBUTOR,
        key: s.id,
        supplierId: s.id,
        code: s.code,
        name: s.name,
        active: s.active,
        phone: s.mobile,
        paymentTerms: s.paymentTerms,
        openingBalance,
        purchased: round2(purchasedValue),
        paid: round2(paid?.counted ?? 0),
        payChequesPending: round2(paid?.pending ?? 0),
        payable: round2(openingBalance + purchasedValue - (paid?.counted ?? 0)),
        billed: round2(billed),
        bills: b?._count._all ?? 0,
        received: round2(got?.counted ?? 0),
        receiveChequesPending: round2(got?.pending ?? 0),
        receivable: round2(billed - (got?.counted ?? 0)),
        lastActivity:
          [p?.last, b?._max.saleDate, paid?.last, got?.last].filter((d): d is Date => !!d).sort((x, y) => y.getTime() - x.getTime())[0] ??
          null,
      };
    });

    const textileRows = textileList
      .map((t) => {
        const m = textileMoneyBy.get(t.id);
        const openingBalance = Number(t.openingBalance);
        return {
          type: MoneyPartyType.TEXTILE,
          key: t.id,
          textileId: t.id,
          code: t.code,
          name: t.name,
          active: t.active,
          phone: t.mobile,
          paymentTerms: t.paymentTerms,
          creditLimit: t.creditLimit === null ? null : Number(t.creditLimit),
          openingBalance,
          billed: m?.billed ?? 0,
          bills: m?.bills ?? 0,
          received: m?.received ?? 0,
          receiveChequesPending: m?.receiveChequesPending ?? 0,
          refunded: m?.refunded ?? 0,
          receivable: textileBalance(openingBalance, m),
          lastActivity: [m?.lastSaleAt, m?.lastPaidAt].filter((d): d is Date => !!d).sort((x, y) => y.getTime() - x.getTime())[0] ?? null,
        };
      })
      .sort((a, b) => b.receivable - a.receivable || a.name.localeCompare(b.name));

    const positive = (values: number[]) => round2(values.filter((v) => v > 0.005).reduce((s, v) => s + v, 0));
    const negative = (values: number[]) => round2(-values.filter((v) => v < -0.005).reduce((s, v) => s + v, 0));
    const receivables = [...distributors.map((d) => d.receivable), ...textileRows.map((t) => t.receivable)];
    return {
      distributors,
      textiles: textileRows,
      totals: {
        /** Still to collect on bills. */
        receivable: positive(receivables),
        /** Received ahead of bills. */
        advanceReceived: negative(receivables),
        /** Still to pay distributors for goods. */
        payable: positive(distributors.map((d) => d.payable)),
        /** Paid to distributors ahead of goods. */
        advancePaid: negative(distributors.map((d) => d.payable)),
        textilesDue: textileRows.filter((t) => t.receivable > 0.005).length,
        distributorsToPay: distributors.filter((d) => d.payable > 0.005).length,
        distributorsDue: distributors.filter((d) => d.receivable > 0.005).length,
      },
    };
  }

  /**
   * One party's account in date order with a running balance from our side: debit is what they owe us more (a sale
   * bill, money we paid them), credit what we owe them more (goods they delivered, money they paid us). Positive
   * balance: they owe us; negative: we owe them. Cheques still to clear are listed but not counted until cleared.
   */
  async statement(q: StatementQueryDto) {
    type Line = {
      date: Date;
      kind: 'OPENING' | 'SALE' | 'GOODS' | 'RECEIPT' | 'PAYMENT';
      ref: string;
      refId: string | null;
      text: string;
      debit: number;
      credit: number;
      counted: boolean;
      status: string | null;
    };
    const lines: Line[] = [];
    let party: {
      type: MoneyPartyType;
      supplierId: string | null;
      code: string | null;
      name: string;
      phone: string | null;
      gst: string | null;
    };
    let opening = 0;

    let moneyWhere: Prisma.MoneyTransactionWhereInput;
    if (q.type === MoneyPartyType.DISTRIBUTOR) {
      const supplier = await this.prisma.supplier.findUnique({ where: { id: q.supplierId } });
      if (!supplier) throw new NotFoundException('Distributor not found');
      party = {
        type: q.type,
        supplierId: supplier.id,
        code: supplier.code,
        name: supplier.name,
        phone: supplier.mobile,
        gst: supplier.gst,
      };
      opening = -Number(supplier.openingBalance);
      const receipts = await this.prisma.purchaseReceipt.findMany({
        where: { purchaseOrder: { supplierId: supplier.id } },
        select: {
          id: true,
          receiptNo: true,
          receivedAt: true,
          purchaseOrder: { select: { id: true, poNo: true } },
          items: { select: { quantity: true, purchaseOrderItem: { select: { rate: true } } } },
        },
        orderBy: { receivedAt: 'asc' },
      });
      for (const r of receipts) {
        const value = round2(r.items.reduce((s, i) => s + Number(i.quantity) * Number(i.purchaseOrderItem.rate), 0));
        lines.push({
          date: r.receivedAt,
          kind: 'GOODS',
          ref: r.receiptNo,
          refId: r.purchaseOrder.id,
          text: `Goods received · ${r.purchaseOrder.poNo}`,
          debit: 0,
          credit: value,
          counted: true,
          status: null,
        });
      }
      moneyWhere = { supplierId: supplier.id };
    } else if (q.type === MoneyPartyType.TEXTILE) {
      const textile = await this.prisma.textile.findUnique({ where: { id: q.textileId } });
      if (!textile) throw new NotFoundException('Textile not found');
      party = { type: q.type, supplierId: null, code: textile.code, name: textile.name, phone: textile.mobile, gst: textile.gst };
      // What they owed before the ERP: positive, they owe us.
      opening = Number(textile.openingBalance);
      const sales = await this.prisma.sale.findMany({
        where: { textileId: textile.id, status: SaleStatus.DISPATCHED },
        select: { id: true, saleNo: true, saleDate: true, totalAmount: true },
      });
      for (const sale of sales) {
        lines.push({
          date: sale.saleDate,
          kind: 'SALE',
          ref: sale.saleNo,
          refId: sale.id,
          text: `Sale bill ${sale.saleNo}`,
          debit: Number(sale.totalAmount),
          credit: 0,
          counted: true,
          status: null,
        });
      }
      moneyWhere = { textileId: textile.id };
    } else {
      const name = cleanName(q.name!);
      party = { type: q.type, supplierId: null, code: null, name, phone: null, gst: null };
      moneyWhere = { partyType: q.type, partyName: { equals: name, mode: 'insensitive' } };
    }
    if (q.type === MoneyPartyType.DISTRIBUTOR) {
      const sales = await this.prisma.sale.findMany({
        where: { supplierId: q.supplierId, partyType: SalePartyType.DISTRIBUTOR, status: SaleStatus.DISPATCHED },
        select: { id: true, saleNo: true, saleDate: true, totalAmount: true },
      });
      for (const s of sales)
        lines.push({
          date: s.saleDate,
          kind: 'SALE',
          ref: s.saleNo,
          refId: s.id,
          text: `Sale bill ${s.saleNo}`,
          debit: Number(s.totalAmount),
          credit: 0,
          counted: true,
          status: null,
        });
    }

    const txns = await this.prisma.moneyTransaction.findMany({
      where: { AND: [moneyWhere, { cancelledAt: null, kind: { in: [MoneyTxnKind.RECEIPT, MoneyTxnKind.PAYMENT] } }] },
      include: { sale: { select: { saleNo: true } }, account: { select: { name: true } } },
      orderBy: { txnDate: 'asc' },
    });
    for (const t of txns) {
      const how = t.mode === PaymentMode.CHEQUE ? `cheque ${t.chequeNo}` : MODE_TEXT[t.mode];
      const text =
        t.kind === MoneyTxnKind.RECEIPT ? `Received by ${how}${t.sale ? ` · ${t.sale.saleNo}` : ' · on account'}` : `Paid by ${how}`;
      const amount = Number(t.amount);
      lines.push({
        date: t.txnDate,
        kind: t.kind === MoneyTxnKind.RECEIPT ? 'RECEIPT' : 'PAYMENT',
        ref: t.txnNo,
        refId: t.id,
        text: `${text}${t.account ? ` → ${t.account.name}` : ''}`,
        debit: t.kind === MoneyTxnKind.PAYMENT ? amount : 0,
        credit: t.kind === MoneyTxnKind.RECEIPT ? amount : 0,
        counted: counts(t),
        status: t.chequeStatus,
      });
    }

    const order = { OPENING: 0, GOODS: 1, SALE: 1, PAYMENT: 2, RECEIPT: 2 };
    lines.sort((a, b) => a.date.getTime() - b.date.getTime() || order[a.kind] - order[b.kind]);
    let running = opening;
    const rows = lines.map((line) => {
      if (line.counted) running = round2(running + line.debit - line.credit);
      return { ...line, balance: running };
    });
    const sum = (pick: (l: Line) => number, filter: (l: Line) => boolean) => round2(lines.filter(filter).reduce((s, l) => s + pick(l), 0));
    return {
      party,
      opening,
      lines: rows,
      totals: {
        debit: sum(
          (l) => l.debit,
          (l) => l.counted,
        ),
        credit: sum(
          (l) => l.credit,
          (l) => l.counted,
        ),
        chequesPending: sum(
          (l) => l.debit + l.credit,
          (l) => !l.counted && (l.status === ChequeStatus.PENDING || l.status === ChequeStatus.DEPOSITED),
        ),
        balance: running,
      },
    };
  }

  // ───────────────────────────── Overview ─────────────────────────────

  /** Names, accounts and open bills the entry form offers. */
  async context() {
    const [accounts, distributors, textiles, others, openSales] = await Promise.all([
      this.prisma.moneyAccount.findMany({ where: { active: true }, orderBy: [{ type: 'asc' }, { name: 'asc' }] }),
      this.prisma.supplier.findMany({
        select: { id: true, code: true, name: true, active: true },
        orderBy: [{ active: 'desc' }, { name: 'asc' }],
      }),
      this.prisma.textile.findMany({
        select: { id: true, code: true, name: true, active: true },
        orderBy: [{ active: 'desc' }, { name: 'asc' }],
      }),
      this.prisma.moneyTransaction.findMany({
        where: { partyType: MoneyPartyType.OTHER },
        select: { partyName: true },
        distinct: ['partyName'],
        take: 1000,
      }),
      this.prisma.sale.findMany({
        where: { status: { in: [SaleStatus.PENDING, SaleStatus.REJECTED, SaleStatus.DISPATCHED] } },
        select: {
          id: true,
          saleNo: true,
          saleDate: true,
          status: true,
          partyType: true,
          supplierId: true,
          textileId: true,
          partyName: true,
          totalAmount: true,
        },
        orderBy: { saleDate: 'desc' },
        take: 1500,
      }),
    ]);
    const taken = await this.prisma.moneyTransaction.groupBy({
      by: ['saleId'],
      where: {
        saleId: { in: openSales.map((s) => s.id) },
        kind: MoneyTxnKind.RECEIPT,
        cancelledAt: null,
        NOT: { chequeStatus: ChequeStatus.BOUNCED },
      },
      _sum: { amount: true },
    });
    const takenBy = new Map(taken.map((row) => [row.saleId!, Number(row._sum.amount ?? 0)]));
    return {
      accounts: accounts.map((a) => this.accountView(a)),
      distributors,
      textiles,
      others: [...new Set(others.map((o) => o.partyName ?? '').filter(Boolean))].sort((a, b) => a.localeCompare(b)),
      openSales: openSales
        .map((s) => ({
          ...s,
          partyName: cleanName(s.partyName),
          totalAmount: Number(s.totalAmount),
          open: round2(Number(s.totalAmount) - (takenBy.get(s.id) ?? 0)),
        }))
        .filter((s) => s.open > 0.005),
    };
  }

  /** The Money page's overview: balances, cheques, this month in and out (the same figures as Finance), and party totals. */
  async summary() {
    const { from: monthStart, to: monthEnd } = thisMonth();
    const [accounts, parties, chequesOpen, bouncedMonth, clearedMonth, month, legacyPaid] = await Promise.all([
      this.accounts(),
      this.parties(),
      this.prisma.moneyTransaction.groupBy({
        by: ['kind', 'chequeStatus'],
        where: CHEQUE_OPEN,
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.moneyTransaction.aggregate({
        where: { cancelledAt: null, chequeStatus: ChequeStatus.BOUNCED, bouncedAt: { gte: monthStart } },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.moneyTransaction.groupBy({
        by: ['kind'],
        where: { cancelledAt: null, chequeStatus: ChequeStatus.CLEARED, clearedAt: { gte: monthStart } },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      cashFlow(this.prisma, monthStart, monthEnd),
      this.prisma.moneyTransaction.count({
        where: { cancelledAt: null, accountId: null, kind: MoneyTxnKind.PAYMENT, mode: { not: PaymentMode.CHEQUE } },
      }),
    ]);
    const live = accounts.filter((a) => a.active);
    const byType = (type: MoneyAccountType) => round2(live.filter((a) => a.type === type).reduce((s, a) => s + a.balance, 0));
    const open = (kind: MoneyTxnKind, status?: ChequeStatus) => {
      const rows = chequesOpen.filter((r) => r.kind === kind && (!status || r.chequeStatus === status));
      return {
        count: rows.reduce((s, r) => s + r._count._all, 0),
        amount: round2(rows.reduce((s, r) => s + Number(r._sum.amount ?? 0), 0)),
      };
    };
    const cleared = (kind: MoneyTxnKind) => {
      const row = clearedMonth.find((r) => r.kind === kind);
      return { count: row?._count._all ?? 0, amount: round2(Number(row?._sum.amount ?? 0)) };
    };
    return {
      accounts,
      balances: {
        cash: byType(MoneyAccountType.CASH),
        bank: byType(MoneyAccountType.BANK),
        upi: byType(MoneyAccountType.UPI),
        total: round2(live.reduce((s, a) => s + a.balance, 0)),
      },
      cheques: {
        toDeposit: open(MoneyTxnKind.RECEIPT, ChequeStatus.PENDING),
        deposited: open(MoneyTxnKind.RECEIPT, ChequeStatus.DEPOSITED),
        received: open(MoneyTxnKind.RECEIPT),
        issued: open(MoneyTxnKind.PAYMENT),
        clearedInMonth: cleared(MoneyTxnKind.RECEIPT),
        clearedOutMonth: cleared(MoneyTxnKind.PAYMENT),
        bouncedMonth: { count: bouncedMonth._count._all, amount: round2(Number(bouncedMonth._sum.amount ?? 0)) },
      },
      month,
      parties: parties.totals,
      /** Old distributor payments from before accounts existed; they are not in any account's balance. */
      unassignedPayments: legacyPaid,
    };
  }

  // ───────────────────────────── Expenses ─────────────────────────────

  private readonly expenseInclude = { account: { select: { id: true, name: true, type: true } } } satisfies Prisma.ExpenseInclude;

  async expenses(f: ExpenseFilterDto) {
    const rows = await this.prisma.expense.findMany({
      where: {
        ...(f.includeCancelled ? {} : EXPENSE_LIVE),
        ...(f.accountId ? { accountId: f.accountId } : {}),
        ...(f.category ? { category: f.category } : {}),
        ...(f.from || f.to
          ? { expenseDate: { ...(f.from ? { gte: new Date(f.from) } : {}), ...(f.to ? { lte: new Date(f.to) } : {}) } }
          : {}),
      },
      include: this.expenseInclude,
      orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }],
      take: 2000,
    });
    const people = await this.names(rows.flatMap((r) => [r.createdById, r.cancelledById]));
    return rows.map((e) => ({
      ...e,
      amount: Number(e.amount),
      createdBy: e.createdById ? (people.get(e.createdById) ?? null) : null,
      cancelledBy: e.cancelledById ? (people.get(e.cancelledById) ?? null) : null,
    }));
  }

  /** An expense paid from a cash / bank / UPI account; its balance goes down by the amount. */
  async addExpense(dto: ExpenseDto, user: AuthUser) {
    const expenseDate = dto.expenseDate ? new Date(dto.expenseDate) : new Date();
    if (expenseDate > LATEST()) throw new BadRequestException("The date can't be in the future");
    const mode = dto.paymentMode.trim().toUpperCase();
    if (dto.accountId) {
      const account = await this.activeAccount(this.prisma, dto.accountId, 'it was paid from');
      if ((Object.values(PaymentMode) as string[]).includes(mode)) this.checkAccountFor(mode as PaymentMode, account);
    }
    const expense = await this.prisma.$transaction(async (tx) => {
      const created = await tx.expense.create({
        data: {
          expenseNo: await documentNo(tx, 'EXP', expenseDate),
          expenseDate,
          category: dto.category.trim(),
          subcategory: blank(dto.subcategory),
          description: blank(dto.description),
          amount: round2(dto.amount),
          paymentMode: mode,
          accountId: dto.accountId ?? null,
          branch: blank(dto.branch),
          createdById: user.id,
        },
        include: this.expenseInclude,
      });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'EXPENSE_RECORDED',
          module: 'money',
          entity: 'Expense',
          entityId: created.id,
          newValue: {
            expenseNo: created.expenseNo,
            category: created.category,
            amount: Number(created.amount),
            mode,
            account: created.account?.name ?? null,
          },
        },
      });
      return created;
    });
    return { ...expense, amount: Number(expense.amount) };
  }

  async cancelExpense(id: string, reason: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `expense:${id}`);
      const expense = await tx.expense.findUnique({ where: { id } });
      if (!expense) throw new NotFoundException('Expense not found');
      if (expense.cancelledAt) throw new BadRequestException(`${expense.expenseNo} is already cancelled`);
      const updated = await tx.expense.update({
        where: { id },
        data: { cancelledAt: new Date(), cancelledById: user.id, cancelReason: reason },
      });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'EXPENSE_CANCELLED',
          module: 'money',
          entity: 'Expense',
          entityId: id,
          previousValue: { expenseNo: expense.expenseNo, category: expense.category, amount: Number(expense.amount) },
          newValue: { reason },
        },
      });
      return { ...updated, amount: Number(updated.amount) };
    });
  }

  /**
   * One account's cash book: opening balance, then every movement that counts (money in, money out, transfers,
   * expenses) in date order with the running balance. A cheque appears on the day it cleared. Cheques still to clear
   * are listed separately.
   */
  async cashbook(accountId: string) {
    const account = await this.prisma.moneyAccount.findUnique({ where: { id: accountId } });
    if (!account) throw new NotFoundException('Account not found');
    const [txns, expenses, openCheques] = await Promise.all([
      this.prisma.moneyTransaction.findMany({
        where: { AND: [COUNTED, { OR: [{ accountId }, { toAccountId: accountId }] }] },
        include: { account: { select: { name: true } }, toAccount: { select: { name: true } }, sale: { select: { saleNo: true } } },
        take: 5000,
      }),
      this.prisma.expense.findMany({ where: { ...EXPENSE_LIVE, accountId }, take: 5000 }),
      this.prisma.moneyTransaction.findMany({
        where: { AND: [CHEQUE_OPEN, { accountId }] },
        include: txnInclude,
        orderBy: { chequeDate: 'asc' },
      }),
    ]);
    type Line = {
      id: string;
      date: Date;
      ref: string;
      kind: 'RECEIPT' | 'PAYMENT' | 'TRANSFER_IN' | 'TRANSFER_OUT' | 'EXPENSE';
      text: string;
      mode: string;
      moneyIn: number;
      moneyOut: number;
    };
    const lines: Line[] = [];
    for (const t of txns) {
      const amount = Number(t.amount);
      const how = t.mode === PaymentMode.CHEQUE ? `cheque ${t.chequeNo}` : MODE_TEXT[t.mode];
      if (t.kind === MoneyTxnKind.TRANSFER) {
        const incoming = t.toAccountId === accountId;
        lines.push({
          id: t.id,
          date: movedOn(t),
          ref: t.txnNo,
          kind: incoming ? 'TRANSFER_IN' : 'TRANSFER_OUT',
          text: incoming ? `Transfer from ${t.account?.name}` : `Transfer to ${t.toAccount?.name}`,
          mode: t.mode,
          moneyIn: incoming ? amount : 0,
          moneyOut: incoming ? 0 : amount,
        });
      } else if (t.kind === MoneyTxnKind.RECEIPT) {
        lines.push({
          id: t.id,
          date: movedOn(t),
          ref: t.txnNo,
          kind: 'RECEIPT',
          text: `From ${t.partyName ?? 'party'} by ${how}${t.sale ? ` · ${t.sale.saleNo}` : ''}`,
          mode: t.mode,
          moneyIn: amount,
          moneyOut: 0,
        });
      } else {
        lines.push({
          id: t.id,
          date: movedOn(t),
          ref: t.txnNo,
          kind: 'PAYMENT',
          text: `To ${t.partyName ?? 'party'} by ${how}`,
          mode: t.mode,
          moneyIn: 0,
          moneyOut: amount,
        });
      }
    }
    for (const e of expenses) {
      lines.push({
        id: e.id,
        date: e.expenseDate,
        ref: e.expenseNo,
        kind: 'EXPENSE',
        text: `${e.category}${e.description ? ` · ${e.description}` : ''}`,
        mode: e.paymentMode,
        moneyIn: 0,
        moneyOut: Number(e.amount),
      });
    }
    lines.sort((a, b) => a.date.getTime() - b.date.getTime() || a.ref.localeCompare(b.ref));
    let running = Number(account.openingBalance);
    const rows = lines.map((line) => {
      running = round2(running + line.moneyIn - line.moneyOut);
      return { ...line, balance: running };
    });
    const people = await this.names(openCheques.map((c) => c.createdById));
    return {
      account: this.accountView(account),
      opening: Number(account.openingBalance),
      lines: rows,
      totals: {
        moneyIn: round2(lines.reduce((s, l) => s + l.moneyIn, 0)),
        moneyOut: round2(lines.reduce((s, l) => s + l.moneyOut, 0)),
        balance: running,
      },
      openCheques: openCheques.map((c) => this.txnView(c, people)),
    };
  }
}
