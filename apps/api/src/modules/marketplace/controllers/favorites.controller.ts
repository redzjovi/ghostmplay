import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common'
import { MarketplaceService } from '../marketplace.service'
import { CreateFavoriteDto, UpdateFavoriteDto } from '../dto/favorite.dto'
import { RequireAuthGuard, CurrentAccount } from '../../auth/guards'
import type { AuthenticatedAccount } from '../../auth/session.service'
import type { MarketplaceFavorite } from '@ghostmplay/shared'

@Controller('api/favorites')
@UseGuards(RequireAuthGuard)
export class FavoritesController {
  constructor(private readonly marketplace: MarketplaceService) {}

  @Get()
  list(@CurrentAccount() account: AuthenticatedAccount): Promise<MarketplaceFavorite[]> {
    return this.marketplace.listFavorites(account.id)
  }

  @Get(':id')
  async get(
    @CurrentAccount() account: AuthenticatedAccount,
    @Param('id', ParseIntPipe) id: number
  ): Promise<MarketplaceFavorite> {
    return this.marketplace.getFavorite(account.id, id)
  }

  @Post()
  create(
    @CurrentAccount() account: AuthenticatedAccount,
    @Body() input: CreateFavoriteDto
  ): Promise<MarketplaceFavorite> {
    return this.marketplace.createFavorite(account.id, input)
  }

  @Patch(':id')
  update(
    @CurrentAccount() account: AuthenticatedAccount,
    @Param('id', ParseIntPipe) id: number,
    @Body() input: UpdateFavoriteDto
  ): Promise<MarketplaceFavorite> {
    return this.marketplace.updateFavorite(account.id, id, input)
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentAccount() account: AuthenticatedAccount,
    @Param('id', ParseIntPipe) id: number
  ): Promise<void> {
    await this.marketplace.deleteFavorite(account.id, id)
  }
}
