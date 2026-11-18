import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { MillDto, UpdateMillDto } from './dto/mill.dto';
import { MastersService } from './masters.service';

describe('mill details without a services field', () => {
  const input = { code: 'PC-001', name: 'Example Mill' };

  it('accepts the contact form without services', async () => {
    expect(await validate(plainToInstance(MillDto, input))).toHaveLength(0);
  });

  it('still rejects invalid legacy services values', async () => {
    const errors = await validate(plainToInstance(MillDto, { ...input, services: 'INVALID' }));
    expect(errors.some((error) => error.property === 'services')).toBe(true);
  });

  it('makes a newly registered mill available to the existing production pickers', async () => {
    const mill = { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'mill-id' }) };
    const service = new MastersService({ mill } as unknown as PrismaService);
    await service.createMill(input);
    expect(mill.create).toHaveBeenCalledWith({
      data: { ...input, services: 'KNITTING,DYEING,COMPACTING' },
    });
  });

  it('accepts an explicit services value from existing API clients', async () => {
    const mill = { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'mill-id' }) };
    const service = new MastersService({ mill } as unknown as PrismaService);
    await service.createMill({ ...input, services: 'DYEING' });
    expect(mill.create).toHaveBeenCalledWith({ data: { ...input, services: 'DYEING' } });
  });

  it('updates contact details without replacing existing services', async () => {
    const mill = {
      findUnique: jest.fn().mockResolvedValue({ id: 'mill-id', services: 'DYEING' }),
      update: jest.fn().mockResolvedValue({ id: 'mill-id' }),
    };
    const service = new MastersService({ mill } as unknown as PrismaService);
    const dto = plainToInstance(UpdateMillDto, { mobile: '9876543210' });
    expect(dto.services).toBeUndefined();
    await service.updateMill('mill-id', dto);
    expect(mill.update).toHaveBeenCalledWith({ where: { id: 'mill-id' }, data: { mobile: '9876543210' } });
  });
});
