import { Transform } from 'class-transformer'
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator'
import { toOptionalString } from '../../../common/transforms'
import type { CreateFavoriteInput as SharedCreate, UpdateFavoriteInput as SharedUpdate } from '@ghostmplay/shared'

function normalizeList({ value }: { value: unknown }): string[] {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  const s = String(value).trim()
  if (!s) return []
  return s.includes(',') ? s.split(',').map((v) => v.trim()).filter(Boolean) : [s]
}

/**
 * Accepts the camelCase names and the legacy snake_case aliases the client may send.
 *
 * Every optional field is declared with `declare` so it emits no runtime property.
 * Without this, TypeScript's `useDefineForClassFields` would define each one as
 * `undefined` on every instance, so the service's `'q' in input` check would be
 * true for fields the client never sent and a rename would silently wipe filters.
 */
class FavoriteFields {
  @IsOptional()
  @Transform(toOptionalString)
  @IsString()
  declare name?: string

  @IsOptional()
  @Transform(toOptionalString)
  @IsString()
  declare q?: string | null

  @IsOptional()
  @Transform(normalizeList)
  declare equipmentTypes?: string[]

  @IsOptional()
  @Transform(toOptionalString)
  @IsString()
  declare equipment_type?: string

  @IsOptional()
  @Transform(normalizeList)
  declare gradeEffects?: string[]

  @IsOptional()
  @Transform(toOptionalString)
  @IsString()
  declare grade_effect?: string

  @IsOptional()
  @Transform(toOptionalString)
  @IsString()
  declare sort?: string
}

export class CreateFavoriteDto extends FavoriteFields implements SharedCreate {
  @IsString()
  @MinLength(1)
  @MaxLength(50, { message: 'Favorite name max 50 chars' })
  declare name: string
}

export class UpdateFavoriteDto extends FavoriteFields implements SharedUpdate {}
