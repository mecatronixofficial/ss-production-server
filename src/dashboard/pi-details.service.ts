import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { piDetail, piDetails } from './pi-details';

@Injectable()
export class PiDetailsService {
  constructor(private readonly prisma: PrismaService) {}

  get(search?: string, page?: string) {
    return piDetails(this.prisma, search, page);
  }

  one(id: string) {
    return piDetail(this.prisma, id);
  }
}
