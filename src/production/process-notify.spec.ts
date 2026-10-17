import { PrismaClient } from '@prisma/client';
import { notifyProcessDone, weightChange } from './process-notify';

/** Records the notifications made, for two active users of the roles asked for. */
function fakeDb() {
  const made: Array<Record<string, unknown>> = [];
  const asked: unknown[] = [];
  const db = {
    user: {
      findMany: (args: { where: { role: { in: unknown } } }) => {
        asked.push(args.where.role.in);
        return Promise.resolve([{ id: 'u1' }, { id: 'u2' }]);
      },
    },
    notification: {
      createMany: ({ data }: { data: Array<Record<string, unknown>> }) => {
        made.push(...data);
        return Promise.resolve({ count: data.length });
      },
    },
  };
  return { db: db as unknown as PrismaClient, made, asked };
}

describe('weightChange', () => {
  it('reads a loss, a gain and no change', () => {
    expect(weightChange(240, 238.5)).toBe('−1.5 KG (0.63%)');
    expect(weightChange(200, 200.4)).toBe('+0.4 KG (0.20%)');
    expect(weightChange(100, 100)).toBe('no weight change');
  });
});

describe('notifyProcessDone', () => {
  it('tells every user what a process made, from what, and where it went', async () => {
    const { db, made, asked } = fakeDb();
    await notifyProcessDone(db, {
      process: 'Dyeing',
      flowNo: 'SS-2026-003-D1',
      input: 238.5,
      output: 230,
      outputLabel: 'dyed fabric',
      details: ['Navy', '24 rolls', null, false],
      next: 'sent to compacting at Sri Compactors',
    });
    expect(asked[0]).toEqual(['SUPERADMIN', 'ADMIN']);
    expect(made).toHaveLength(2);
    expect(made[0]).toMatchObject({
      userId: 'u1',
      title: 'Dyeing completed · SS-2026-003-D1',
      message: '230 KG dyed fabric from 238.5 KG, −8.5 KG (3.56%) · Navy · 24 rolls · sent to compacting at Sri Compactors',
      type: 'JOB_COMPLETED',
      priority: 'NORMAL',
      referenceType: 'ProductionBatch',
      referenceId: 'SS-2026-003-D1',
    });
  });

  it('sends knitting to managers too, and flags a big loss', async () => {
    const { db, made, asked } = fakeDb();
    await notifyProcessDone(db, { process: 'Knitting', flowNo: 'B1', input: 1000, output: 850, outputLabel: 'grey fabric', details: [], next: 'ready for dyeing' });
    expect(asked[0]).toEqual(['SUPERADMIN', 'ADMIN', 'MANAGER']);
    expect(made[0]).toMatchObject({ title: 'Knitting completed · B1 · check the loss', priority: 'HIGH' });
  });
});
