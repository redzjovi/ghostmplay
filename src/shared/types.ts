export type GradeEffect = 'Normal' | 'Rare' | 'Legacy' | string
export type EquipmentType = string // e.g. Weapon, Armor, Accessory — from note.txt equipment_type
export type AttributeType = 'Level' | 'Equipment Type' | 'Enchant' | 'Grade Effect'

export interface MarketplaceItem {
  id: number
  tokenId: number
  ownerId: string
  ownerName: string
  sellerId: string
  imageUrl: string
  name: string
  currency: string // NUMI
  price: number
  gradeEffect: GradeEffect
  level: number
  enchant: number
  equipmentType: EquipmentType
  createdAt: string // ISO
}

export interface MarketplaceItemDetail extends MarketplaceItem {
  attributes: { type: AttributeType; value: string }[]
  datas: { title: 'Basic Effect' | 'Set Composition' | 'Set Effect' | string; values: string[] }[]
  infos: { title: string; valueName: string; value: string }[]
  mintTime: string | null
  marketTime: string | null
}

export interface MarketplaceListQuery {
  page?: number
  limit?: number
  q?: string
  equipmentType?: string | string[]
  gradeEffect?: GradeEffect | GradeEffect[]
  level?: number
  sort?: 'price_asc' | 'price_desc' | 'recent' | 'created_at_desc'
}

export interface MarketplaceFilterOptions {
  equipmentTypes: EquipmentType[]
  gradeEffects: GradeEffect[]
}
