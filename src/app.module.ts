import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { validateEnv } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { MastersModule } from './masters/masters.module';
import { InventoryModule } from './inventory/inventory.module';
import { ProductionModule } from './production/production.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ReportsModule } from './reports/reports.module';
import { FinanceModule } from './finance/finance.module';
import { StorageModule } from './storage/storage.module';
import { HealthController } from './health.controller';
import { AdminModule } from './admin/admin.module';
import { ProcurementModule } from './procurement/procurement.module';
import { SalesModule } from './sales/sales.module';
import { KnittingModule } from './knitting/knitting.module';
import { TasksModule } from './tasks/tasks.module';
import { SearchModule } from './search/search.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    UsersModule,
    DashboardModule,
    MastersModule,
    InventoryModule,
    ProductionModule,
    NotificationsModule,
    ReportsModule,
    FinanceModule,
    StorageModule,
    AdminModule,
    ProcurementModule,
    SalesModule,
    KnittingModule,
    TasksModule,
    SearchModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
