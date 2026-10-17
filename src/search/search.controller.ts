import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthUser } from '../common/auth-user';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SearchService } from './search.service';

/** The search box in the top bar: codes, documents, parties, machines and warehouses, as the user's role allows. */
@Controller('search')
@UseGuards(AuthGuard('jwt'))
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  find(@CurrentUser() user: AuthUser, @Query('q') q?: string) {
    return this.search.search((q ?? '').slice(0, 80), user.role);
  }
}
