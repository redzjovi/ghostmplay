export type GradeEffect = 'Normal' | 'Rare' | 'Legacy' | string
export type EquipmentType = string // e.g. Weapon, Armor, Accessory — from note.txt equipment_type
export type AttributeType = 'Level' | 'Equipment Type' | 'Enchant' | 'Grade Effect'

export interface MarketplaceItem {
  id: number
  tokenId: number
  sellerId: string
  sellerName: string | null
  imageUrl: string
  name: string
  currency: string // NUMI
  price: number
  gradeEffect: GradeEffect
  level: number
  enchant: number
  equipmentType: EquipmentType
  createdAt: string // ISO — equals market_time (duplicate removed from detail)
  mintTime?: string | null // moved from marketplace_item_detail (nullable, equals mint_time)
  sold: boolean
}

export interface MarketplaceItemDetail extends MarketplaceItem {
  attributes: { type: AttributeType; value: string }[]
  datas: { title: 'Basic Effect' | 'Set Composition' | 'Set Effect' | string; values: string[] }[]
  infos: { title: string; valueName: string; value: string }[]
  marketTime?: never // removed: use createdAt
}

export interface MarketplaceListQuery {
  page?: number
  limit?: number
  q?: string
  equipment_type?: string | string[]
  grade_effect?: GradeEffect | GradeEffect[]
  level?: number
  sort?: 'price_asc' | 'price_desc' | 'recent' | 'created_at_desc'
  /** @deprecated alias — use equipment_type (snake_case sama dengan api & db) */
  equipmentType?: string | string[]
  /** @deprecated alias — use grade_effect */
  gradeEffect?: GradeEffect | GradeEffect[]
}

export interface MarketplaceFilterOptions {
  equipmentTypes: EquipmentType[]
  gradeEffects: GradeEffect[]
}

export interface MarketplaceFavorite {
  id: number
  name: string
  q?: string | null
  equipmentTypes: string[]
  gradeEffects: string[]
  sort: 'recent' | 'price_asc' | 'price_desc' | string
  createdAt: string
  updatedAt: string
}

export interface CreateFavoriteInput {
  name: string
  q?: string | null
  equipmentTypes?: string[]
  gradeEffects?: string[]
  sort?: 'recent' | 'price_asc' | 'price_desc' | string
  // legacy snake_case aliases accepted by IPC
  equipment_type?: string | string[]
  grade_effect?: string | string[]
}

export interface UpdateFavoriteInput {
  name?: string
  q?: string | null
  equipmentTypes?: string[]
  gradeEffects?: string[]
  sort?: string
  equipment_type?: string | string[]
  grade_effect?: string | string[]
}
