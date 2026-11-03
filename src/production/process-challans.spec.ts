import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProcessChallansService } from './process-challans';

describe('Process delivery challan', () => {
  const challan = (fields: Record<string, unknown>) => ({
    id: 'c',
    challanNo: 'PDC-2026-000009',
    handOff: 'DELIVERY:d',
    date: new Date('2026-11-03'),
    material: 'Finished fabric',
    fromKind: 'PROCESS',
    fromName: 'Sun compacting',
    toKind: 'PARTY',
    toName: 'Kumar Textiles',
    weightKg: new Prisma.Decimal(95),
    packages: 22,
    packageUnit: 'rolls',
    createdById: null,
    flow: { id: 'f', flowNo: '01SS26-KT01-DY01' },
    ...fields,
  });
  const setup = (c: ReturnType<typeof challan>) => {
    const prisma = {
      processChallan: { findUnique: jest.fn().mockResolvedValue(c) },
      systemSetting: { findUnique: jest.fn().mockResolvedValue({ value: { name: 'SS Clothing Mills', address: '12 Mill Road', city: 'Tiruppur', gst: '33AAACS1234A1Z5', phone: '0421 2200000' } }) },
      user: { findUnique: jest.fn() },
      fabricProductionFlow: { findMany: jest.fn().mockResolvedValue([]) },
      knittingRun: { findMany: jest.fn().mockResolvedValue([]) },
      purchaseOrderItem: { findMany: jest.fn().mockResolvedValue([]) },
      yarnReceiptLine: { findMany: jest.fn().mockResolvedValue([]) },
      textile: { findFirst: jest.fn().mockResolvedValue({ address: '4 Market St', city: 'Erode', gst: '33BBBCK9876B1Z2', mobile: '98430 11111' }) },
      supplier: { findFirst: jest.fn().mockResolvedValue(null) },
      mill: { findFirst: jest.fn().mockResolvedValue({ address: 'SIDCO', city: 'Tiruppur', gst: null, mobile: '98422 22222' }) },
      warehouse: { findFirst: jest.fn().mockResolvedValue({ location: 'Godown 2, Avinashi Road' }) },
    };
    return { service: new ProcessChallansService(prisma as unknown as PrismaService), prisma };
  };

  it('names who it is from and goes to in full: address, city, GSTIN and phone', async () => {
    const { service } = setup(challan({}));
    const doc = await service.document('c');
    expect(doc.fromDetails).toEqual({ address: 'SIDCO', city: 'Tiruppur', gst: null, phone: '98422 22222' });
    expect(doc.toDetails).toEqual({ address: '4 Market St', city: 'Erode', gst: '33BBBCK9876B1Z2', phone: '98430 11111' });
    expect(doc).toMatchObject({ packages: 22, packageUnit: 'rolls', weightKg: 95, material: 'Finished fabric' });
  });

  it('gives the own mill the company\'s details and a warehouse its location', async () => {
    const { service } = setup(challan({ fromName: 'Own mill · KN-01', toKind: 'WAREHOUSE', toName: 'GRY · Grey store' }));
    const doc = await service.document('c');
    expect(doc.fromDetails).toMatchObject({ address: '12 Mill Road', city: 'Tiruppur', gst: '33AAACS1234A1Z5' });
    expect(doc.toDetails).toMatchObject({ address: 'Godown 2, Avinashi Road' });
  });
});
