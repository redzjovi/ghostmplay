import { Transform } from 'class-transformer'
import { IsOptional, IsInt, IsString, IsIn, Min, Max } from 'class-validator'
import { toCsv, toOptionalInt, toOptionalString } from '../../../common/transforms'
import type { MarketplaceListQuery } from '@ghostmplay/shared'

export const MARKETPLACE_SORTS = ['price_asc', 'price_desc', 'recent', 'created_at_desc'] as const

export class MarketplaceListQueryDto implements MarketplaceListQuery {
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

  @IsOptional()
  @Transform(toOptionalString)
  @IsString()
  q?: string

  /** Canonical snake_case, matching both the API and the DB columns. */
  @IsOptional()
  @Transform(toCsv)
  @IsString()
  equipment_type?: string | string[]

  @IsOptional()
  @Transform(toCsv)
  @IsString()
  grade_effect?: string | string[]

  /** @deprecated alias for `equipment_type` */
  @IsOptional()
  @Transform(toCsv)
  @IsString()
  equipmentType?: string | string[]

  /** @deprecated alias for `grade_effect` */
  @IsOptional()
  @Transform(toCsv)
  @IsString()
  gradeEffect?: string | string[]

  @IsOptional()
  @Transform(toOptionalInt)
  @IsInt()
  level?: number

  @IsOptional()
  @Transform(toOptionalString)
  @IsIn(MARKETPLACE_SORTS)
  sort?: (typeof MARKETPLACE_SORTS)[number]
}
