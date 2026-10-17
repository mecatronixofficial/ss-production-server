import { Body, Controller, Delete, Get,HttpCode, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Role } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreateUserDto, UpdateUserDto } from './dto/create-user.dto';
import { UsersService } from './users.service';

@Controller('users')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.SUPERADMIN, Role.ADMIN)
export class UsersController {
  constructor(private service: UsersService) {}
  @Get() list() {
    return this.service.list();
  }
  /** One user's page: details, devices signed in, recent activity and account changes. */
  @Get(':id') details(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.details(id);
  }
  @Post() create(@Body() dto: CreateUserDto, @CurrentUser() user: AuthUser) {
    return this.service.create(dto, user);
  }
  @Patch(':id') update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto, @CurrentUser() user: AuthUser) {
    return this.service.update(id, dto, user);
  }
  @Post(':id/sign-out') @HttpCode(200) signOut(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.signOutEverywhere(id, user);
  }
  @Delete(':id') remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.remove(id, user);
  }
}
