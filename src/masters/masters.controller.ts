import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Role } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { GODOWN_VIEW_ROLES, MACHINE_ROLES } from '../common/roles';
import { MastersService } from './masters.service';
import { SupplierDto, UpdateSupplierDto } from './dto/supplier.dto';
import { MachineDto, UpdateMachineDto } from './dto/machine.dto';
import { EmployeeDto, UpdateEmployeeDto } from './dto/employee.dto';
import { UpdateWarehouseDto, WarehouseDto } from './dto/warehouse.dto';
import { MillDto, UpdateMillDto } from './dto/mill.dto';
import { TextileDto, UpdateTextileDto } from './dto/textile.dto';

@Controller('masters')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.SUPERADMIN, Role.ADMIN)
export class MastersController {
  constructor(private s: MastersService) {}

  @Get('suppliers') suppliers() {
    return this.s.suppliers();
  }
  /** Preview for the Add form; the code is assigned for real on save, which may pick a later one. */
  /** One distributor's page: details, purchase orders, receipts, payments and balance. */
  @Get('suppliers/:id/account') supplierAccount(@Param('id', ParseUUIDPipe) id: string) {
    return this.s.supplierAccount(id);
  }
  @Get('suppliers/next-code') async nextSupplierCode() {
    return { code: await this.s.nextSupplierCode() };
  }
  @Post('suppliers') supplier(@Body() d: SupplierDto) {
    return this.s.createSupplier(d);
  }
  @Patch('suppliers/:id') updateSupplier(@Param('id', ParseUUIDPipe) id: string, @Body() d: UpdateSupplierDto) {
    return this.s.updateSupplier(id, d);
  }

  /** Textiles the business sells to, with what each owes. */
  @Get('textiles') textiles() {
    return this.s.textiles();
  }
  @Get('textiles/next-code') async nextTextileCode() {
    return { code: await this.s.nextTextileCode() };
  }
  /** One textile's page: details, sale bills, money received and balance. */
  @Get('textiles/:id/account') textileAccount(@Param('id', ParseUUIDPipe) id: string) {
    return this.s.textileAccount(id);
  }
  @Post('textiles') createTextile(@Body() d: TextileDto) {
    return this.s.createTextile(d);
  }
  @Patch('textiles/:id') updateTextile(@Param('id', ParseUUIDPipe) id: string, @Body() d: UpdateTextileDto) {
    return this.s.updateTextile(id, d);
  }

  @Get('mills') mills() {
    return this.s.mills();
  }
  /** Suggestion for the Add form; the code stays editable and is re-checked on save. */
  /** One mill's page: details and the production jobs it did. */
  @Get('mills/:id/account') millAccount(@Param('id', ParseUUIDPipe) id: string) {
    return this.s.millAccount(id);
  }
  @Get('mills/next-code') async nextMillCode() {
    return { code: await this.s.nextMillCode() };
  }
  @Post('mills') createMill(@Body() d: MillDto) {
    return this.s.createMill(d);
  }
  @Patch('mills/:id') updateMill(@Param('id', ParseUUIDPipe) id: string, @Body() d: UpdateMillDto) {
    return this.s.updateMill(id, d);
  }
  @Delete('mills/:id') deleteMill(@Param('id', ParseUUIDPipe) id: string) {
    return this.s.deleteMill(id);
  }

  @Get('machines') @Roles(...MACHINE_ROLES) machines() {
    return this.s.machines();
  }
  @Get('machines/stats') @Roles(...MACHINE_ROLES) machineStats() {
    return this.s.machineStats();
  }
  @Post('machines') @Roles(...MACHINE_ROLES) machine(@Body() d: MachineDto) {
    return this.s.createMachine(d);
  }
  @Patch('machines/:id') @Roles(...MACHINE_ROLES) updateMachine(@Param('id') id: string, @Body() d: UpdateMachineDto) {
    return this.s.updateMachine(id, d);
  }
  @Delete('machines/:id') @Roles(...MACHINE_ROLES) deleteMachine(@Param('id') id: string) {
    return this.s.deleteMachine(id);
  }

  @Get('employees') employees() {
    return this.s.employees();
  }
  /** Suggestion for the Add form; the code stays editable and is re-checked on save. */
  /** One employee's page: details, linked login and the machine runs they operated. */
  @Get('employees/:id/account') employeeAccount(@Param('id', ParseUUIDPipe) id: string) {
    return this.s.employeeAccount(id);
  }
  @Get('employees/next-code') async nextEmployeeCode() {
    return { code: await this.s.nextEmployeeCode() };
  }
  @Post('employees') employee(@Body() d: EmployeeDto) {
    return this.s.createEmployee(d);
  }
  @Patch('employees/:id') updateEmployee(@Param('id', ParseUUIDPipe) id: string, @Body() d: UpdateEmployeeDto) {
    return this.s.updateEmployee(id, d);
  }

  @Get('warehouses') @Roles(...GODOWN_VIEW_ROLES) warehouses() {
    return this.s.warehouses();
  }
  @Get('warehouses/summary') @Roles(...GODOWN_VIEW_ROLES) warehouseSummary() {
    return this.s.warehouseSummary();
  }
  @Get('warehouses/:id/stock') @Roles(...GODOWN_VIEW_ROLES) warehouseStock(@Param('id', ParseUUIDPipe) id: string) {
    return this.s.warehouseStock(id);
  }
  @Post('warehouses') createWarehouse(@Body() d: WarehouseDto) {
    return this.s.createWarehouse(d);
  }
  @Patch('warehouses/:id') updateWarehouse(@Param('id', ParseUUIDPipe) id: string, @Body() d: UpdateWarehouseDto) {
    return this.s.updateWarehouse(id, d);
  }
  @Delete('warehouses/:id') deleteWarehouse(@Param('id', ParseUUIDPipe) id: string) {
    return this.s.deleteWarehouse(id);
  }
}
