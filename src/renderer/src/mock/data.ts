import type { MarketplaceItem } from '@shared/types'

export const mockItems: MarketplaceItem[] = [
  {
    id: 1, tokenId: 1001, sellerId: '0xseller1', sellerName: 'Zorin',
    imageUrl: 'https://via.placeholder.com/320x320?text=Blade+of+Ghost',
    name: 'Blade of Ghost +7', currency: 'NUMI', price: 1250, gradeEffect: 'Rare', level: 65, enchant: 7, equipmentType: 'Weapon', createdAt: new Date().toISOString(), mintTime: new Date().toISOString(), sold: false
  },
  {
    id: 2, tokenId: 1002, sellerId: '0xseller2', sellerName: 'Ayu',
    imageUrl: 'https://via.placeholder.com/320x320?text=Phantom+Armor',
    name: 'Phantom Armor +5', currency: 'NUMI', price: 890, gradeEffect: 'Normal', level: 60, enchant: 5, equipmentType: 'Armor', createdAt: new Date().toISOString(), mintTime: new Date().toISOString(), sold: false
  },
  {
    id: 3, tokenId: 1003, sellerId: '0xseller3', sellerName: 'Dao',
    imageUrl: 'https://via.placeholder.com/320x320?text=Ghost+Ring',
    name: 'Ghost Ring', currency: 'NUMI', price: 420, gradeEffect: 'Rare', level: 55, enchant: 0, equipmentType: 'Accessory', createdAt: new Date().toISOString(), mintTime: null, sold: true
  }
]
