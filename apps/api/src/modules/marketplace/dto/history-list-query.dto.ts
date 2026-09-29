import { Transform } from 'class-transformer'
import { IsOptional, IsInt, IsString, IsIn, Min, Max } from 'class-validator'
import { toOptionalBoolean, toOptionalInt, toOptionalNumber, toOptionalString } from '../../../common/transforms'
import type { HistoryListQuery } from '@ghostmplay/shared'

export const HISTORY_SORTS = ['recent', 'created_at_desc', 'created_at_asc', 'price_asc', 'price_desc'] as const

/** `YYYY-MM-DD`. Bounds are whole UTC days; `createdTo` is inclusive of that day. */
const DATE_DAY = /^\d{4}-\d{2}-\d{2}$/

const toOptionalDay = ({ value }: { value: unknown }): string | undefined => {
  const s = toOptionalString({ value })
  return s && DATE_DAY.test(s) ? s : undefined
}

export class HistoryListQueryDto implements HistoryListQuery {
  @IsOptional()
  @Transform(toOptionalInt)
  @IsInt()
  @Min(1)
  page?: number

  @IsOptional()
  @Transform(toOptionalInt)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number

  /** Matches either the wallet address or the username. */
  @IsOptional()
  @Transform(toOptionalString)
  @IsString()
  seller?: string

  /** Matches either the wallet address or the username. */
  @IsOptional()
  @Transform(toOptionalString)
  @IsString()
  buyer?: string

  /** Exact username match. */
  @IsOptional()
  @Transform(toOptionalString)
  @IsString()
  sellerName?: string

  /** Exact username match. */
  @IsOptional()
  @Transform(toOptionalString)
  @IsString()
  buyerName?: string

  @IsOptional()
  @Transform(toOptionalString)
  @IsString()
  itemName?: string

  /** @deprecated alias for `itemName` */
  @IsOptional()
  @Transform(toOptionalString)
  @IsString()
  q?: string

  @IsOptional()
  @Transform(toOptionalInt)
  @IsInt()
  tokenId?: number

  @IsOptional()
  @Transform(toOptionalString)
  @IsString()
  txHash?: string

  @IsOptional()
  @Transform(toOptionalNumber)
  priceMin?: number

  @IsOptional()
  @Transform(toOptionalNumber)
  priceMax?: number

  @IsOptional()
  @Transform(toOptionalDay)
  @IsString()
  createdFrom?: string

  @IsOptional()
  @Transform(toOptionalDay)
  @IsString()
  createdTo?: string

  @IsOptional()
  @Transform(toOptionalBoolean)
  claimed?: boolean

  @IsOptional()
  @Transform(toOptionalString)
  @IsIn(HISTORY_SORTS)
  sort?: (typeof HISTORY_SORTS)[number]
}
