import { describe, it, expect } from 'vitest'
import { adaptLiveDetail } from './itemDetailHelpers'

const full = {
  tokenId: 4949,
  owner: '0xBuyer',
  ownerName: 'herwan',
  price: 148,
  ipfs: 'https://ipfs.example.com',
  details: {
    name: '+4 Spectersoul Greaves (Fire)',
    image: 'QmczABC',
    attributes: [
      { trait_type: 'Level', value: '65' },
      { trait_type: 'Equipment Type', value: 'Armor' },
      { trait_type: 'Grade Effect', value: 'Rare' }
    ]
  },
  viewData: {
    datas: [{ title: 'Basic Effect', values: [{ ATK: '+10' }] }],
    infos: []
  }
}

describe('adaptLiveDetail', () => {
  it('maps full live response to dialog shape', () => {
    const res = adaptLiveDetail(full)
    expect(res).not.toBeNull()
    expect(res!.item.tokenId).toBe(4949)
    expect(res!.item.name).toBe('+4 Spectersoul Greaves (Fire)')
    expect(res!.item.imageUrl).toBe('QmczABC')
    expect(res!.item.equipmentType).toBe('Armor')
    expect(res!.item.price).toBe(148)
    expect(res!.item.currency).toBe('NUMI')
    expect(res!.item.sold).toBe(false)
    expect(res!.detail.attributes).toHaveLength(3)
    expect(res!.detail.datas).toEqual([{ title: 'Basic Effect', values: [{ ATK: '+10' }] }])
  })

  it('falls back to fallbackName when details.name missing', () => {
    const res = adaptLiveDetail({ tokenId: 1, details: {}, viewData: {} }, 'Gold Box')
    expect(res!.item.name).toBe('Gold Box')
    expect(res!.item.equipmentType).toBe('')
    expect(res!.detail.attributes).toEqual([])
    expect(res!.detail.datas).toEqual([])
  })

  it('returns null for null, non-object, or non-numeric tokenId', () => {
    expect(adaptLiveDetail(null)).toBeNull()
    expect(adaptLiveDetail(undefined)).toBeNull()
    expect(adaptLiveDetail({} as never)).toBeNull()
    expect(adaptLiveDetail({ tokenId: 'abc' } as never)).toBeNull()
    expect(adaptLiveDetail({ tokenId: '4949' } as never)?.item.tokenId).toBe(4949)
  })

  it('drops malformed attributes and datas entries', () => {
    const res = adaptLiveDetail({
      tokenId: 2,
      details: { attributes: [{ value: 'x' }, null, { trait_type: 'Level', value: 65 }] },
      viewData: { datas: [{ values: [] }, null, { title: 'Set Effect', values: 'nope' }] }
    } as never)
    expect(res!.detail.attributes).toEqual([{ trait_type: 'Level', value: '65' }])
    expect(res!.detail.datas).toEqual([{ title: 'Set Effect', values: [] }])
  })

  it('normalizes non-finite price to 0', () => {
    const res = adaptLiveDetail({ tokenId: 3, price: 'NaN' } as never)
    expect(res!.item.price).toBe(0)
  })
})
