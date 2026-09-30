export function normalizeImageUrl(raw: string): string {
  if (!raw) return ''
  if (raw.includes('/ipfs/')) return raw
  const m = raw.match(/^(https?:\/\/[^\/]+)\/(Qm[1-9A-HJ-NP-Za-km-z]{44,}|bafy[a-z0-9]+.*|bafk[a-z0-9]+.*)$/i)
  if (m) return `${m[1]}/ipfs/${m[2]}`
  if (/^https?:\/\//.test(raw) || raw.startsWith('data:')) return raw
  return raw
}

export function styleFor(word: string, cls?: string): string {
  const byClass: Record<string, string> = {
    section_red: 'color:#ef4444; font-weight: 700',
    section_blue: 'color:#3b82f6; font-weight: 700',
    section_sky: 'color:#0ea5e9; font-weight: 700',
    section_pink: 'color:#ec4899; font-weight: 700',
    section_green: 'color:#22c55e; font-weight: 700',
  }
  if (cls && byClass[cls]) return byClass[cls]
  return ''
}

export function dotColor(title: string): string {
  const t = title.toLowerCase()
  if (t.includes('basic')) return 'bg-red-500'
  if (t.includes('spirit') || t.includes('gem')) return 'bg-emerald-500'
  if (t.includes('grade')) return 'bg-blue-500'
  if (t.includes('set composition')) return 'bg-purple-500'
  if (t.includes('set effect')) return 'bg-pink-500'
  return 'bg-primary'
}

export function isSimpleValues(section: { title: string; values: unknown[] }): boolean {
  if (!Array.isArray(section.values) || section.values.length === 0) return true
  const first = section.values[0] as Record<string, unknown>
  return first && typeof first === 'object' && !('title' in first && 'values' in first)
}

export function simpleValues(section: { title: string; values: unknown[] }): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = []
  for (const v of section.values as Record<string, unknown>[]) {
    for (const [k, val] of Object.entries(v)) out.push({ key: k, value: String(val) })
  }
  return out
}

export function orderIndex(title: string): number {  const t = title.toLowerCase()
  if (t.includes('basic effect')) return 0
  if (t.includes('spirit synthesis') || t.includes('gem effect')) return 1
  if (t.includes('grade effect')) return 2
  if (t.includes('set composition')) return 3
  if (t.includes('set effect')) return 4
  return 99
}

export type ParsedDetail = {
  attributes: { type: string; value: string }[]
  datas: { title: string; class?: string; values: unknown[] }[]
}

export function parseDetail(detail: { attributes: unknown; datas: unknown } | null): ParsedDetail {  const attributes: { type: string; value: string }[] = (() => {
    const a = detail?.attributes
    if (!Array.isArray(a)) return []
    return (a as Record<string, unknown>[]).map(x => ({ type: String((x as Record<string, unknown>).trait_type ?? (x as Record<string, unknown>).type ?? ''), value: String((x as Record<string, unknown>).value ?? '') })).filter(x => x.type)
  })()
  const datas: { title: string; class?: string; values: unknown[] }[] = (() => {
    const d = detail?.datas
    if (!Array.isArray(d)) return []
    return (d as { title: string; class?: string; values: unknown[] }[]).map(x => ({ title: String(x.title ?? ''), class: String((x as Record<string, unknown>).class ?? ''), values: Array.isArray(x.values) ? x.values : [] })).filter(x => x.title)
  })()
  return { attributes, datas }
}

export type LiveDetailInput = {
  tokenId?: unknown
  price?: unknown
  details?: {
    name?: unknown
    image?: unknown
    attributes?: unknown
  } | null
  viewData?: {
    datas?: unknown
  } | null
} | null | undefined

export type AdaptedLiveDetail = {
  item: {
    tokenId: number
    name: string
    imageUrl: string
    equipmentType: string
    price: number
    currency: string
    soldAt: string | null
  }
  detail: {
    attributes: { trait_type: string; value: string }[]
    datas: { title: string; values: unknown[] }[]
  }
}

/** Adapt a raw live item-detail response into the dialog-ready {item, detail} shape. Never throws. */
export function adaptLiveDetail(raw: LiveDetailInput, fallbackName = ''): AdaptedLiveDetail | null {
  if (!raw || typeof raw !== 'object') return null
  const tokenId = Number((raw as Record<string, unknown>).tokenId)
  if (!Number.isFinite(tokenId)) return null
  const details = ((raw as Record<string, unknown>).details ?? {}) as Record<string, unknown>
  const viewData = ((raw as Record<string, unknown>).viewData ?? {}) as Record<string, unknown>
  const nameRaw = details.name
  const name = typeof nameRaw === 'string' && nameRaw.trim() ? nameRaw.trim() : fallbackName
  const imageRaw = details.image
  const imageUrl = typeof imageRaw === 'string' ? imageRaw.trim() : ''
  const attrsRaw = Array.isArray(details.attributes) ? (details.attributes as Record<string, unknown>[]) : []
  const attributes = attrsRaw
    .map((a) => ({
      trait_type: String(a?.trait_type ?? ''),
      value: String(a?.value ?? '')
    }))
    .filter((a) => a.trait_type)
  const equipmentType =
    attributes.find((a) => a.trait_type.trim().toLowerCase() === 'equipment type')?.value ?? ''
  const datasRaw = Array.isArray(viewData.datas) ? (viewData.datas as Record<string, unknown>[]) : []
  const datas = datasRaw
    .map((d) => ({
      title: String(d?.title ?? ''),
      values: Array.isArray(d?.values) ? (d.values as unknown[]) : []
    }))
    .filter((d) => d.title)
  const priceRaw = Number((raw as Record<string, unknown>).price)
  return {
    item: {
      tokenId,
      name,
      imageUrl,
      equipmentType,
      price: Number.isFinite(priceRaw) ? priceRaw : 0,
      currency: 'NUMI',
      soldAt: null
    },
    detail: { attributes, datas }
  }
}
