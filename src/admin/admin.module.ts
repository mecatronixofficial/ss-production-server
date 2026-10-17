import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AuditLogsController } from './audit-logs.controller';

@Module({ controllers: [AdminController, AuditLogsController] })
export class AdminModule {}
