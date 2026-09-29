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

export interface User {
  id: string
  username: string | null
}

export interface MarketplaceTokenTransfer {
  id: number
  tokenId: number
  gameName: string | null
  sellerId: string
  sellerUsername?: string | null
  buyerId: string
  buyerUsername?: string | null
  itemName: string
  price: number
  currency: string
  txHash: string
  imageUrl: string | null
  createdAt: string // ISO
  claimed: boolean
}

export interface HistoryListQuery {
  page?: number
  limit?: number
  seller?: string
  buyer?: string
  sellerName?: string
  buyerName?: string
  tokenId?: number | string
  txHash?: string
  itemName?: string
  /** alias for itemName */
  q?: string
  priceMin?: number
  priceMax?: number
  createdFrom?: string // YYYY-MM-DD (UTC day, inclusive)
  createdTo?: string // YYYY-MM-DD (UTC day, inclusive)
  claimed?: boolean
  sort?: 'recent' | 'created_at_desc' | 'created_at_asc' | 'price_asc' | 'price_desc'
}

/** Raw live item-detail response (display-only, never persisted). */
export interface LiveItemDetailResponse {
  tokenId: number
  owner?: string | null
  ownerName?: string | null
  price?: number | null
  ipfs?: string | null
  details?: {
    name?: string | null
    image?: string | null
    attributes?: { trait_type?: string | null; value?: unknown }[] | null
  } | null
  viewData?: {
    datas?: { title?: string | null; values?: unknown[] }[] | null
  } | null
}

/** Dialog-ready shape adapted from a live response (mirrors marketplace:get). */
export interface AdaptedLiveDetail {
  item: {
    tokenId: number
    name: string
    imageUrl: string
    equipmentType: string
    price: number
    currency: string
    sold: boolean
  }
  detail: {
    attributes: { trait_type: string; value: string }[]
    datas: { title: string; values: unknown[] }[]
  }
}
