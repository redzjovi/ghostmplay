<template>
  <div class="p-5 space-y-3">
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-2xl font-semibold">Marketplace</h2>
      <Button :disabled="syncing" @click="triggerAutoSync('all', true)">
        <Loader2 v-if="syncing && syncMode==='all'" class="mr-2 h-4 w-4 animate-spin" />
        {{ syncing && syncMode==='all' ? 'Syncing All…' : 'Sync All' }}
      </Button>
    </div>

    <!-- Browse view (menu List) -->
    <div v-if="!isFavoriteView" class="space-y-3">
        <!-- Filter Section [equipment type] [grade effect] [input search] + chips inside -->
        <div class="p-3 border rounded-lg bg-card space-y-3">
          <div class="flex flex-wrap gap-3 items-end">
            <div class="flex flex-col gap-1 w-[220px] shrink-0">
              <label class="text-xs font-medium text-muted-foreground">Equipment type</label>
              <Popover v-model:open="equipOpen">
                <PopoverTrigger as-child>
                  <Button variant="outline" class="justify-between w-full max-w-[220px] overflow-hidden" :title="equipmentTypeFullTitle"><span class="truncate text-left flex-1">{{ equipmentTypeLabel }}</span> <ChevronDown class="ml-2 h-4 w-4 opacity-50 shrink-0" /></Button>
                </PopoverTrigger>
                <PopoverContent class="w-64 p-0">
                  <Command>
                    <CommandInput placeholder="Search ..." />
                    <CommandList>
                      <CommandEmpty>No results</CommandEmpty>
                      <CommandGroup>
                        <div v-if="store.filterLoading" class="px-2 py-6 text-center text-sm text-muted-foreground">Loading…</div>
                        <div v-else-if="!store.equipmentTypes.length" class="px-2 py-6 text-center text-sm text-muted-foreground">No equipment types</div>
                      <CommandItem v-for="t in store.equipmentTypes" :key="t" :value="t" @select="() => toggleEquip(t)">
                        <span class="mr-2 grid h-4 w-4 shrink-0 place-content-center rounded-sm border border-primary" :class="selectedEquipmentTypes.includes(t) ? 'bg-primary text-primary-foreground' : 'text-transparent'"><Check class="h-4 w-4" /></span> {{ t }}
                      </CommandItem>
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            <div class="flex flex-col gap-1 w-[200px] shrink-0">
              <label class="text-xs font-medium text-muted-foreground">Grade effect</label>
              <Popover v-model:open="gradeOpen">
                <PopoverTrigger as-child>
                  <Button variant="outline" class="justify-between w-full max-w-[200px] overflow-hidden" :title="gradeEffectFullTitle"><span class="truncate text-left flex-1">{{ gradeEffectLabel }}</span> <ChevronDown class="ml-2 h-4 w-4 opacity-50 shrink-0" /></Button>
                </PopoverTrigger>
                <PopoverContent class="w-56 p-0">
                  <Command>
                    <CommandInput placeholder="Search ..." />
                    <CommandList>
                      <CommandEmpty>No results</CommandEmpty>
                      <CommandGroup>
                        <div v-if="store.filterLoading" class="px-2 py-6 text-center text-sm text-muted-foreground">Loading…</div>
                        <div v-else-if="!store.gradeEffects.length" class="px-2 py-6 text-center text-sm text-muted-foreground">No grade effects</div>
                      <CommandItem v-for="g in store.gradeEffects" :key="g" :value="g" @select="() => toggleGrade(g)">
                        <span class="mr-2 grid h-4 w-4 shrink-0 place-content-center rounded-sm border border-primary" :class="selectedGradeEffects.includes(g) ? 'bg-primary text-primary-foreground' : 'text-transparent'"><Check class="h-4 w-4" /></span> {{ g }}
                      </CommandItem>
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            <div class="flex flex-col gap-1 flex-1 min-w-[200px]">
              <label class="text-xs font-medium text-muted-foreground">Search</label>
              <div class="relative">
                <Search class="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input v-model="q" placeholder="Please enter your search term." class="pl-8" @keyup.enter="load(1)" />
              </div>
            </div>
          </div>

          <div v-if="filterGroups.length" class="space-y-1.5 pt-3 border-t">
            <div v-for="g in filterGroups" :key="g.key" class="flex flex-wrap items-center gap-2">
              <span class="w-28 shrink-0 text-xs text-muted-foreground">{{ g.title }}</span>
              <Badge v-for="c in g.chips" :key="c.key" variant="secondary" class="gap-1">
                {{ c.label }} <Button variant="ghost" size="icon" class="h-3 w-3 p-0" @click="c.clear()"><X class="h-3 w-3" /></Button>
              </Badge>
              <Button v-if="g.chips.length>1" variant="ghost" size="icon" class="h-3 w-3 p-0" :title="`Clear ${g.title}`" :aria-label="`Clear ${g.title}`" @click="g.clearGroup()"><X class="h-3 w-3" /></Button>
            </div>
            <Button v-if="activeFilterCount>1" variant="ghost" size="sm" @click="clearAllFilters()">Clear all</Button>
          </div>
        </div>

        <!-- Row 2: Sort, Limit, Add favorite -->
        <div class="flex flex-wrap gap-2 items-center">
          <Select v-model="sort">
            <SelectTrigger class="w-[200px]">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="recent">Recently registered</SelectItem>
              <SelectItem value="price_desc">Price high to low</SelectItem>
              <SelectItem value="price_asc">Price low to high</SelectItem>
            </SelectContent>
          </Select>

          <Select :model-value="String(limit)" @update:model-value="(v:any)=>{ limit = Number(v) }">
            <SelectTrigger class="w-[110px]">
              <SelectValue placeholder="Per page" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="n in PAGE_SIZES" :key="n" :value="String(n)">{{ n }} / page</SelectItem>
            </SelectContent>
          </Select>

          <Button variant="default" class="ml-2 gap-1.5" @click="openAddFavorite">
            <Star class="h-4 w-4" /> Add favorite
          </Button>

          <ToggleGroup type="single" :model-value="viewMode" @update:model-value="(v:any)=>viewMode=v || viewMode" class="ml-auto">
            <ToggleGroupItem value="grid" aria-label="Grid"><LayoutGrid class="h-4 w-4" /></ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label="List"><List class="h-4 w-4" /></ToggleGroupItem>
          </ToggleGroup>
        </div>

        <div v-if="syncing" class="text-sm text-muted-foreground flex items-center gap-2"><Loader2 class="h-4 w-4 animate-spin" /> Syncing {{ syncMode }} (sort=created_at_desc, limit 12{{ syncMode==='latest' ? ', break on id+created_at' : '' }})…</div>
        <p class="text-sm text-muted-foreground">Total: {{ store.total }} · Showing {{ store.items.length }}<span v-if="lastSynced!==null"> · Last sync ({{ lastMode }}): {{ lastSynced }} new</span> · Page {{ page }}/{{ totalPages }}</p>

        <div :class="viewMode==='grid' ? 'grid gap-3 grid-cols-[repeat(auto-fill,minmax(200px,1fr))]' : 'flex flex-col gap-1.5'">
          <Card v-for="it in (store.items as Item[])" :key="it.tokenId" :class="[viewMode==='list' ? 'flex flex-row items-center gap-2 overflow-hidden' : 'flex flex-col gap-2 overflow-hidden', isSoldOut(it) ? 'opacity-60' : '']">
            <router-link :to="itemDetailTo(it.tokenId)" class="block overflow-hidden leading-[0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring relative group" :class="viewMode==='list' ? 'rounded-l-lg w-12 shrink-0' : 'rounded-t-md'" :aria-label="`View ${it.name} details`" :title="it.name">
              <Badge v-if="isSoldOut(it)" variant="destructive" class="absolute top-1.5 left-1.5 z-10 text-[10px] px-1.5 py-0.5">Sold Out</Badge>
              <Button variant="secondary" size="icon" class="absolute top-1.5 right-1.5 z-10 h-7 w-7 rounded-full bg-background/90 backdrop-blur shadow opacity-90 hover:opacity-100" :class="viewMode==='list' ? 'hidden' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'" title="Preview" aria-label="Preview" @click.stop.prevent="openPreview(it)"><Eye class="h-4 w-4" /></Button>
              <AspectRatio :ratio="1" class="relative w-full bg-muted overflow-hidden rounded-md">
                <Skeleton v-if="hasImage(it) && !imageLoaded(imageKey(it)) && !imageFailed(imageKey(it))" class="absolute inset-0 h-full w-full rounded-md" />
                <div v-if="!hasImage(it) || imageFailed(imageKey(it))" class="absolute inset-0 grid place-items-center bg-muted p-2 text-center">
                  <div class="space-y-1">
                    <div class="text-xs font-medium text-muted-foreground line-clamp-2 px-1">{{ it.name }}</div>
                    <div class="text-[10px] text-muted-foreground/60">No Image</div>
                  </div>
                </div>
                <img v-if="hasImage(it) && !imageFailed(imageKey(it))" :key="imageKey(it)" :src="normalizeImageUrl(it.imageUrl)" :alt="it.name" class="h-full w-full object-cover" :class="{ 'opacity-0': !imageLoaded(imageKey(it)), 'opacity-100 transition-opacity': imageLoaded(imageKey(it)) }" decoding="async" @load="markImageLoaded(imageKey(it))" @error="(e:any)=>onImageError(e, imageKey(it))" />
              </AspectRatio>
            </router-link>
            <template v-if="viewMode==='list'">
              <span class="min-w-0 flex-1 truncate text-sm font-medium"><router-link :to="itemDetailTo(it.tokenId)" class="hover:text-primary hover:underline underline-offset-2" :title="it.name">{{ it.name }}</router-link></span>
              <span class="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{{ it.equipmentType }}</span>
              <span class="shrink-0 whitespace-nowrap text-xs text-muted-foreground">Lv {{ it.level }}</span>
              <span class="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{{ it.gradeEffect }}</span>
              <span class="w-10 shrink-0 whitespace-nowrap text-right text-xs text-muted-foreground">{{ it.enchant ? '+' + it.enchant : '–' }}</span>
              <Button variant="ghost" size="icon" class="shrink-0 h-7 w-7" title="Preview" aria-label="Preview" @click.stop="openPreview(it)"><Eye class="h-4 w-4" /></Button>
            </template>
            <div v-else class="flex flex-col gap-1 min-w-0 px-3">
              <CardTitle class="text-sm leading-tight truncate"><router-link :to="itemDetailTo(it.tokenId)" class="hover:text-primary hover:underline underline-offset-2" :title="it.name">{{ it.name }}</router-link></CardTitle>
              <div class="flex flex-col gap-1">
                <Badge variant="outline" class="w-fit text-[11px]">{{ it.equipmentType }}</Badge>
                <span class="text-xs text-muted-foreground">Lv {{ it.level }}</span>
                <span v-if="it.enchant" class="text-xs text-muted-foreground"><span>{{ it.gradeEffect }}</span> <span>+{{ it.enchant }}</span></span>
                <span v-else class="text-xs text-muted-foreground">{{ it.gradeEffect }}</span>
              </div>
            </div>
            <div class="flex items-center gap-1 font-semibold" :class="viewMode==='list' ? 'text-sm min-w-[96px] justify-end pr-2' : 'text-sm px-3 pb-3'">
              <img v-if="isNUMI(it.currency)" :src="NUMI_ICON_URL" alt="NUMI" :class="viewMode==='list' ? 'h-4 w-4' : 'h-[18px] w-[18px]'" class="rounded object-contain bg-muted" decoding="async" @error="(e:any)=>(e.target as HTMLImageElement).style.display='none'" />
              <span>{{ formatPrice(it.price) }}</span><span class="text-xs font-normal text-muted-foreground">{{ it.currency }}</span>
            </div>
          </Card>
        </div>

        <div v-if="totalPages > 1" class="flex justify-center gap-1">
          <Button variant="outline" size="sm" :disabled="page<=1" @click="load(page-1)">‹ Prev</Button>
          <template v-for="n in pageNumbers" :key="n">
            <span v-if="n==='...'" class="px-2 text-muted-foreground">…</span>
            <Button v-else :variant="n===page ? 'default' : 'outline'" size="sm" :disabled="n===page" @click="load(n as number)">{{ n }}</Button>
          </template>
          <Button variant="outline" size="sm" :disabled="page>=totalPages" @click="load(page+1)">Next ›</Button>
        </div>
    </div>

    <!-- Favorite view (menu Favorite) -->
    <div v-else class="space-y-3">
        <!-- Favorite detail view — like marketplace item list + Update -->
        <div v-if="selectedFavorite" class="space-y-3">
          <div class="flex items-center gap-2">
            <Button variant="outline" size="sm" @click="backToFavorites"><ArrowLeft class="mr-1 h-4 w-4" /> Back</Button>
            <h3 class="text-lg font-semibold truncate flex-1 min-w-0" :title="selectedFavorite.name">{{ selectedFavorite.name }}</h3>
            <Button variant="ghost" size="sm" class="h-7 px-2 shrink-0" @click="startRename(selectedFavorite)"><Pencil class="mr-1 h-3 w-3" /> Rename</Button>
            <Button variant="ghost" size="sm" class="h-7 px-2 shrink-0 text-destructive hover:text-destructive" @click="confirmDelete(selectedFavorite)"><Trash2 class="mr-1 h-3 w-3" /> Delete</Button>
          </div>

          <!-- Filter Section (same as marketplace) -->
          <div class="p-3 border rounded-lg bg-card space-y-3">
            <div class="flex flex-wrap gap-3 items-end">
              <div class="flex flex-col gap-1 w-[220px] shrink-0">
                <label class="text-xs font-medium text-muted-foreground">Equipment type</label>
                <Popover v-model:open="equipOpen">
                  <PopoverTrigger as-child>
                    <Button variant="outline" class="justify-between w-full max-w-[220px] overflow-hidden" :title="equipmentTypeFullTitle"><span class="truncate text-left flex-1">{{ equipmentTypeLabel }}</span> <ChevronDown class="ml-2 h-4 w-4 opacity-50 shrink-0" /></Button>
                  </PopoverTrigger>
                  <PopoverContent class="w-64 p-0">
                    <Command>
                      <CommandInput placeholder="Search ..." />
                      <CommandList>
                        <CommandEmpty>No results</CommandEmpty>
                        <CommandGroup>
                          <div v-if="store.filterLoading" class="px-2 py-6 text-center text-sm text-muted-foreground">Loading…</div>
                          <div v-else-if="!store.equipmentTypes.length" class="px-2 py-6 text-center text-sm text-muted-foreground">No equipment types</div>
                        <CommandItem v-for="t in store.equipmentTypes" :key="t" :value="t" @select="() => toggleEquip(t)">
                          <span class="mr-2 grid h-4 w-4 shrink-0 place-content-center rounded-sm border border-primary" :class="selectedEquipmentTypes.includes(t) ? 'bg-primary text-primary-foreground' : 'text-transparent'"><Check class="h-4 w-4" /></span> {{ t }}
                        </CommandItem>
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>

              <div class="flex flex-col gap-1 w-[200px] shrink-0">
                <label class="text-xs font-medium text-muted-foreground">Grade effect</label>
                <Popover v-model:open="gradeOpen">
                  <PopoverTrigger as-child>
                    <Button variant="outline" class="justify-between w-full max-w-[200px] overflow-hidden" :title="gradeEffectFullTitle"><span class="truncate text-left flex-1">{{ gradeEffectLabel }}</span> <ChevronDown class="ml-2 h-4 w-4 opacity-50 shrink-0" /></Button>
                  </PopoverTrigger>
                  <PopoverContent class="w-56 p-0">
                    <Command>
                      <CommandInput placeholder="Search ..." />
                      <CommandList>
                        <CommandEmpty>No results</CommandEmpty>
                        <CommandGroup>
                          <div v-if="store.filterLoading" class="px-2 py-6 text-center text-sm text-muted-foreground">Loading…</div>
                          <div v-else-if="!store.gradeEffects.length" class="px-2 py-6 text-center text-sm text-muted-foreground">No grade effects</div>
                        <CommandItem v-for="g in store.gradeEffects" :key="g" :value="g" @select="() => toggleGrade(g)">
                          <span class="mr-2 grid h-4 w-4 shrink-0 place-content-center rounded-sm border border-primary" :class="selectedGradeEffects.includes(g) ? 'bg-primary text-primary-foreground' : 'text-transparent'"><Check class="h-4 w-4" /></span> {{ g }}
                        </CommandItem>
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>

              <div class="flex flex-col gap-1 flex-1 min-w-[200px]">
                <label class="text-xs font-medium text-muted-foreground">Search</label>
                <div class="relative">
                  <Search class="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input v-model="q" placeholder="Please enter your search term." class="pl-8" @keyup.enter="load(1)" />
                </div>
              </div>
            </div>

            <div v-if="filterGroups.length" class="space-y-1.5 pt-3 border-t">
              <div v-for="g in filterGroups" :key="g.key" class="flex flex-wrap items-center gap-2">
                <span class="w-28 shrink-0 text-xs text-muted-foreground">{{ g.title }}</span>
                <Badge v-for="c in g.chips" :key="c.key" variant="secondary" class="gap-1">
                  {{ c.label }} <Button variant="ghost" size="icon" class="h-3 w-3 p-0" @click="c.clear()"><X class="h-3 w-3" /></Button>
                </Badge>
                <Button v-if="g.chips.length>1" variant="ghost" size="icon" class="h-3 w-3 p-0" :title="`Clear ${g.title}`" :aria-label="`Clear ${g.title}`" @click="g.clearGroup()"><X class="h-3 w-3" /></Button>
              </div>
              <Button v-if="activeFilterCount>1" variant="ghost" size="sm" @click="clearAllFilters()">Clear all</Button>
            </div>
          </div>

          <!-- Sort / Limit / Update -->
          <div class="flex flex-wrap gap-2 items-center">
            <Select v-model="sort">
              <SelectTrigger class="w-[200px]">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="recent">Recently registered</SelectItem>
                <SelectItem value="price_desc">Price high to low</SelectItem>
                <SelectItem value="price_asc">Price low to high</SelectItem>
              </SelectContent>
            </Select>

            <Select :model-value="String(limit)" @update:model-value="(v:any)=>{ limit = Number(v) }">
              <SelectTrigger class="w-[110px]">
                <SelectValue placeholder="Per page" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="n in PAGE_SIZES" :key="n" :value="String(n)">{{ n }} / page</SelectItem>
              </SelectContent>
            </Select>

            <Button :disabled="!isFavoriteDirty || updatingFavorite" @click="updateFavorite">
              <Loader2 v-if="updatingFavorite" class="mr-2 h-4 w-4 animate-spin" />
              <Save v-else class="mr-2 h-4 w-4" />
              Update favorite
            </Button>

            <ToggleGroup type="single" :model-value="viewMode" @update:model-value="(v:any)=>viewMode=v || viewMode" class="ml-auto">
              <ToggleGroupItem value="grid" aria-label="Grid"><LayoutGrid class="h-4 w-4" /></ToggleGroupItem>
              <ToggleGroupItem value="list" aria-label="List"><List class="h-4 w-4" /></ToggleGroupItem>
            </ToggleGroup>
          </div>

          <div v-if="syncing" class="text-sm text-muted-foreground flex items-center gap-2"><Loader2 class="h-4 w-4 animate-spin" /> Syncing {{ syncMode }} …</div>
          <div class="text-sm text-muted-foreground">Total: {{ store.total }} · Showing {{ store.items.length }} · Page {{ page }}/{{ totalPages }}</div>
          <div :class="viewMode==='grid' ? 'grid gap-3 grid-cols-[repeat(auto-fill,minmax(200px,1fr))]' : 'flex flex-col gap-1.5'">
            <Card v-for="it in (store.items as Item[])" :key="it.tokenId" :class="[viewMode==='list' ? 'flex flex-row items-center gap-2 overflow-hidden' : 'flex flex-col gap-2 overflow-hidden', isSoldOut(it) ? 'opacity-60' : '']">
              <router-link :to="itemDetailTo(it.tokenId)" class="block overflow-hidden leading-[0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring relative group" :class="viewMode==='list' ? 'rounded-l-lg w-12 shrink-0' : 'rounded-t-md'" :aria-label="`View ${it.name} details`" :title="it.name">
                <Badge v-if="isSoldOut(it)" variant="destructive" class="absolute top-1.5 left-1.5 z-10 text-[10px] px-1.5 py-0.5">Sold Out</Badge>
                <Button variant="secondary" size="icon" class="absolute top-1.5 right-1.5 z-10 h-7 w-7 rounded-full bg-background/90 backdrop-blur shadow opacity-90 hover:opacity-100" :class="viewMode==='list' ? 'hidden' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'" title="Preview" aria-label="Preview" @click.stop.prevent="openPreview(it)"><Eye class="h-4 w-4" /></Button>
                <AspectRatio :ratio="1" class="relative w-full bg-muted overflow-hidden rounded-md">
                  <Skeleton v-if="hasImage(it) && !imageLoaded(imageKey(it)) && !imageFailed(imageKey(it))" class="absolute inset-0 h-full w-full rounded-md" />
                  <div v-if="!hasImage(it) || imageFailed(imageKey(it))" class="absolute inset-0 grid place-items-center bg-muted p-2 text-center"><div class="space-y-1"><div class="text-xs font-medium text-muted-foreground line-clamp-2 px-1">{{ it.name }}</div><div class="text-[10px] text-muted-foreground/60">No Image</div></div></div>
                  <img v-if="hasImage(it) && !imageFailed(imageKey(it))" :key="imageKey(it)" :src="normalizeImageUrl(it.imageUrl)" :alt="it.name" class="h-full w-full object-cover" :class="{ 'opacity-0': !imageLoaded(imageKey(it)), 'opacity-100 transition-opacity': imageLoaded(imageKey(it)) }" decoding="async" @load="markImageLoaded(imageKey(it))" @error="(e:any)=>onImageError(e, imageKey(it))" />
                </AspectRatio>
              </router-link>
              <template v-if="viewMode==='list'">
                <span class="min-w-0 flex-1 truncate text-sm font-medium"><router-link :to="itemDetailTo(it.tokenId)" class="hover:text-primary hover:underline underline-offset-2" :title="it.name">{{ it.name }}</router-link></span>
                <span class="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{{ it.equipmentType }}</span>
                <span class="shrink-0 whitespace-nowrap text-xs text-muted-foreground">Lv {{ it.level }}</span>
                <span class="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{{ it.gradeEffect }}</span>
                <span class="w-10 shrink-0 whitespace-nowrap text-right text-xs text-muted-foreground">{{ it.enchant ? '+' + it.enchant : '–' }}</span>
                <Button variant="ghost" size="icon" class="shrink-0 h-7 w-7" title="Preview" aria-label="Preview" @click.stop="openPreview(it)"><Eye class="h-4 w-4" /></Button>
              </template>
              <div v-else class="flex flex-col gap-1 min-w-0 px-3">
                <CardTitle class="text-sm leading-tight truncate"><router-link :to="itemDetailTo(it.tokenId)" class="hover:text-primary hover:underline underline-offset-2" :title="it.name">{{ it.name }}</router-link></CardTitle>
                <div class="flex flex-col gap-1">
                  <Badge variant="outline" class="w-fit text-[11px]">{{ it.equipmentType }}</Badge>
                  <span class="text-xs text-muted-foreground">Lv {{ it.level }}</span>
                  <span v-if="it.enchant" class="text-xs text-muted-foreground"><span>{{ it.gradeEffect }}</span> <span>+{{ it.enchant }}</span></span>
                  <span v-else class="text-xs text-muted-foreground">{{ it.gradeEffect }}</span>
                </div>
              </div>
              <div class="flex items-center gap-1 font-semibold" :class="viewMode==='list' ? 'text-sm min-w-[96px] justify-end pr-2' : 'text-sm px-3 pb-3'">
                <img v-if="isNUMI(it.currency)" :src="NUMI_ICON_URL" alt="NUMI" :class="viewMode==='list' ? 'h-4 w-4' : 'h-[18px] w-[18px]'" class="rounded object-contain bg-muted" decoding="async" @error="(e:any)=>(e.target as HTMLImageElement).style.display='none'" />
                <span>{{ formatPrice(it.price) }}</span><span class="text-xs font-normal text-muted-foreground">{{ it.currency }}</span>
              </div>
            </Card>
          </div>
          <div v-if="totalPages > 1" class="flex justify-center gap-1">
            <Button variant="outline" size="sm" :disabled="page<=1" @click="load(page-1)">‹ Prev</Button>
            <template v-for="n in pageNumbers" :key="n">
              <span v-if="n==='...'" class="px-2 text-muted-foreground">…</span>
              <Button v-else :variant="n===page ? 'default' : 'outline'" size="sm" :disabled="n===page" @click="load(n as number)">{{ n }}</Button>
            </template>
            <Button variant="outline" size="sm" :disabled="page>=totalPages" @click="load(page+1)">Next ›</Button>
          </div>
        </div>

        <!-- Favorite list -->
        <div v-else class="space-y-3">
          <div v-if="favStore.loading" class="py-8 text-center text-sm text-muted-foreground"><Loader2 class="mx-auto mb-2 h-6 w-6 animate-spin" /> Loading favorites…</div>
          <div v-else-if="!favStore.favorites.length" class="rounded-lg border border-dashed p-8 text-center space-y-3">
            <Star class="mx-auto h-8 w-8 text-muted-foreground" />
            <p class="text-sm text-muted-foreground">No favorites yet. Use Marketplace filters then “Add favorite” to save.</p>
            <Button variant="outline" @click="router.replace({ path: '/marketplaces/list' })">Go to Marketplace</Button>
          </div>
          <div v-else class="grid gap-2 grid-cols-[repeat(auto-fill,minmax(240px,1fr))]">
            <Card v-for="fav in favStore.favorites" :key="fav.id" class="px-2.5 py-2 flex flex-col gap-1">
              <button class="text-left text-sm font-medium truncate hover:underline hover:text-primary" :title="fav.name" @click="viewFavorite(fav)">{{ fav.name }}</button>
              <div class="text-[11px] text-muted-foreground leading-none">{{ new Date(fav.createdAt).toLocaleString() }}</div>
              <div class="flex flex-col gap-0.5 text-xs leading-tight pt-0.5">
                <div class="truncate"><span class="text-muted-foreground">Equipment type:</span> {{ fav.equipmentTypes.length ? fav.equipmentTypes.join(', ') : '—' }}</div>
                <div class="truncate"><span class="text-muted-foreground">Grade effect:</span> {{ fav.gradeEffects.length ? fav.gradeEffects.join(', ') : '—' }}</div>
                <div class="truncate"><span class="text-muted-foreground">Search:</span> {{ fav.q ? `“${fav.q}”` : '—' }}</div>
                <div class="truncate"><span class="text-muted-foreground">Sort:</span> {{ favSortLabel(fav.sort) }}</div>
              </div>
              <div class="flex gap-1 pt-1">
                <Button variant="ghost" size="sm" class="h-6 px-2 text-xs" @click="startRename(fav)"><Pencil class="mr-1 h-3 w-3" /> Rename</Button>
                <Button variant="ghost" size="sm" class="h-6 px-2 text-xs text-destructive hover:text-destructive" @click="confirmDelete(fav)"><Trash2 class="mr-1 h-3 w-3" /> Delete</Button>
              </div>
            </Card>
          </div>
        </div>
    </div>

    <ItemPreviewDialog :tokenId="previewTokenId" :open="previewOpen" :fallbackItem="previewFallback" @update:open="previewOpen = $event" />
    <AddFavoriteDialog :open="showAddFavorite" :q="q" :equipmentTypes="selectedEquipmentTypes" :gradeEffects="selectedGradeEffects" :sort="sort" :existingNames="favStore.favorites.map(f=>f.name)" @update:open="showAddFavorite=$event" @save="onSaveFavorite" />

    <!-- Rename dialog -->
    <Dialog :open="showRename" @update:open="showRename=$event">
      <DialogContent class="sm:max-w-md">
        <DialogHeader><DialogTitle>Rename favorite</DialogTitle></DialogHeader>
        <div class="space-y-2">
          <Input v-model="renameName" placeholder="New name" maxlength="50" @keyup.enter="doRename" />
          <p v-if="renameError" class="text-xs text-destructive">{{ renameError }}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="showRename=false">Cancel</Button>
          <Button :disabled="!renameName.trim()" @click="doRename">Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Delete confirm -->
    <Dialog :open="showDelete" @update:open="showDelete=$event">
      <DialogContent class="sm:max-w-md">
        <DialogHeader><DialogTitle>Delete favorite?</DialogTitle><DialogDescription>“{{ deleteTarget?.name }}” will be deleted.</DialogDescription></DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="showDelete=false">Cancel</Button>
          <Button variant="destructive" @click="doDelete">Delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Search, LayoutGrid, List, ChevronDown, X, Loader2, Check, Eye, Star, ArrowLeft, Pencil, Trash2, Save } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { AspectRatio } from '@/components/ui/aspect-ratio'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

import { useMarketplaceStore } from '@/stores/marketplace'
import { useFavoritesStore } from '@/stores/favorites'
import type { GradeEffect, MarketplaceFavorite } from '@shared/types'
import ItemPreviewDialog from '@/components/ItemPreviewDialog.vue'
import AddFavoriteDialog from '@/components/AddFavoriteDialog.vue'
import { formatPrice } from '@/lib/format'

const NUMI_ICON_URL = 'https://market.numine.io/images/market/icon_numi.png'
function isNUMI(currency?: string | number | null): boolean {
  if (currency == null) return false
  const s = String(currency).trim().toUpperCase()
  return s === 'NUMI' || s === '266'
}
function normalizeImageUrl(raw: string): string {
  if (!raw) return ''
  if (raw.includes('/ipfs/')) return raw
  const m = raw.match(/^(https?:\/\/[^\/]+)\/(Qm[1-9A-HJ-NP-Za-km-z]{44,}|bafy[a-z0-9]+.*|bafk[a-z0-9]+.*)$/i)
  if (m) return `${m[1]}/ipfs/${m[2]}`
  if (/^https?:\/\//.test(raw) || raw.startsWith('data:')) return raw
  return raw
}
type Item = { tokenId:number; name:string; imageUrl:string; equipmentType:string; level:number; enchant:number; gradeEffect:string; price:number; currency:string; mintTime?: string | null; createdAt?: string | null; sold?: boolean }
const store = useMarketplaceStore()
const favStore = useFavoritesStore()
const loadedImages = ref<Set<string>>(new Set())
const errorImages = ref<Set<string>>(new Set())
function imageKey(it: Item): string { return `${it.tokenId}:${normalizeImageUrl(it.imageUrl)}` }
function markImageLoaded(key: string) { loadedImages.value = new Set(loadedImages.value).add(key) }
function onImageError(e: Event, key: string) { errorImages.value = new Set(errorImages.value).add(key); markImageLoaded(key); (e.target as HTMLImageElement).style.display='none' }
function hasImage(it: Item): boolean { return !!normalizeImageUrl(it.imageUrl) }
function imageLoaded(key: string): boolean { return loadedImages.value.has(key) }
function imageFailed(key: string): boolean { return errorImages.value.has(key) }
function isSoldOut(it: Item): boolean { return !!it.sold }
function favSortLabel(s:string){ if(s==='price_asc') return 'Price low → high'; if(s==='price_desc') return 'Price high → low'; return 'Recently registered' }
function encodeBackUrl(fullPath: string): string {
  try { return btoa(encodeURIComponent(fullPath)) } catch { try { return btoa(fullPath) } catch { return '' } }
}
function itemDetailTo(tokenId: number | string): string {
  const back = encodeBackUrl(route.fullPath)
  return back ? `/items/${tokenId}?back_url=${encodeURIComponent(back)}` : `/items/${tokenId}`
}

function parseArrayParam(v: unknown): string[] {
  if (!v) return []
  if (Array.isArray(v)) return v.flatMap((x) => String(x).split(',')).map((s) => s.trim()).filter(Boolean)
  return String(v).split(',').map((s) => s.trim()).filter(Boolean)
}
const route = useRoute()
const router = useRouter()
const q = ref(String(route.query.q || ''))
const selectedGradeEffects = ref<GradeEffect[]>(parseArrayParam(route.query.grade_effect) as GradeEffect[])
const selectedEquipmentTypes = ref<string[]>(parseArrayParam(route.query.equipment_type))
const equipOpen = ref(false)
const gradeOpen = ref(false)
const equipmentTypeFullTitle = computed(() => selectedEquipmentTypes.value.join(', '))
const gradeEffectFullTitle = computed(() => selectedGradeEffects.value.join(', '))
const equipmentTypeLabel = computed(() => {
  const v = selectedEquipmentTypes.value
  if (v.length === 0) return ''
  if (v.length === 1) return v[0]
  return `${v[0]} +${v.length - 1}`
})
const gradeEffectLabel = computed(() => {
  const v = selectedGradeEffects.value
  if (v.length === 0) return ''
  if (v.length === 1) return v[0]
  return `${v[0]} +${v.length - 1}`
})
function toggleEquip(v: string) {
  const i = selectedEquipmentTypes.value.indexOf(v)
  if (i >= 0) selectedEquipmentTypes.value = selectedEquipmentTypes.value.filter((x) => x !== v)
  else selectedEquipmentTypes.value = [...selectedEquipmentTypes.value, v]
}
function toggleGrade(v: string) {
  const i = selectedGradeEffects.value.indexOf(v as GradeEffect)
  if (i >= 0) selectedGradeEffects.value = selectedGradeEffects.value.filter((x) => x !== v)
  else selectedGradeEffects.value = [...selectedGradeEffects.value, v as GradeEffect]
}
const sort = ref<'recent' | 'price_asc' | 'price_desc'>(
  (route.query.sort as 'recent' | 'price_asc' | 'price_desc') || 'recent'
)
const page = ref<number>(Number(route.query.page) || 1)

const syncing = ref(false)
const syncMode = ref<'all' | 'latest'>('latest')
const lastSynced = ref<number | null>(null)
const lastMode = ref<'all' | 'latest' | null>(null)
const PAGE_SIZES = [12, 24, 48, 96]
const storedLimit = Number(route.query.limit ?? localStorage.getItem('ghostmplay:marketplace:limit') ?? 12)
const initialLimit = Number.isFinite(storedLimit) ? storedLimit : 12
const limit = ref(PAGE_SIZES.includes(initialLimit) ? initialLimit : 12)
watch(sort, () => { page.value=1; load(1) })
watch(limit, (v) => { localStorage.setItem('ghostmplay:marketplace:limit', String(v)); page.value=1; load(1) })
const viewMode = ref<'grid' | 'list'>((localStorage.getItem('ghostmplay:marketplace:viewMode') as 'grid' | 'list') || 'grid')
watch(viewMode, (v) => localStorage.setItem('ghostmplay:marketplace:viewMode', v))

const isFavoriteView = computed(() => route.path.startsWith('/marketplaces/favorites'))
const selectedFavorite = ref<MarketplaceFavorite | null>(null)
const origFavoriteSnapshot = ref<{ q: string | null; equipmentTypes: string[]; gradeEffects: string[]; sort: string } | null>(null)
const updatingFavorite = ref(false)
const isFavoriteDirty = computed(() => {
  if (!selectedFavorite.value || !origFavoriteSnapshot.value) return false
  const s = origFavoriteSnapshot.value
  const qCur = q.value.trim() || null
  const qOrig = s.q?.trim() || null
  if (qCur !== qOrig) return true
  if (sort.value !== s.sort) return true
  const a = [...selectedEquipmentTypes.value].sort()
  const b = [...s.equipmentTypes].sort()
  if (a.length !== b.length || a.some((v,i)=> v!==b[i])) return true
  const c = [...selectedGradeEffects.value].sort()
  const d = [...s.gradeEffects].sort()
  if (c.length !== d.length || c.some((v,i)=> v!==d[i])) return true
  return false
})
const showAddFavorite = ref(false)
const showRename = ref(false)
const renameName = ref('')
const renameError = ref('')
const renameTarget = ref<MarketplaceFavorite|null>(null)
const showDelete = ref(false)
const deleteTarget = ref<MarketplaceFavorite|null>(null)

function resetBrowseFiltersToClean() {
  q.value = ''
  selectedEquipmentTypes.value = []
  selectedGradeEffects.value = []
  sort.value = 'recent'
  page.value = 1
}

async function restoreFavoriteFromUrl() {
  const favId = route.query.fav ? Number(route.query.fav) : null
  const isFavView = route.path.startsWith('/marketplaces/favorites')
  if (isFavView && favId) {
    if (!favStore.favorites.length) await favStore.fetchFavorites()
    const fav = favStore.favorites.find((f) => f.id === favId)
    if (fav && selectedFavorite.value?.id !== favId) {
      selectedFavorite.value = fav
      origFavoriteSnapshot.value = {
        q: fav.q ?? null,
        equipmentTypes: [...(fav.equipmentTypes ?? [])],
        gradeEffects: [...(fav.gradeEffects ?? [])],
        sort: fav.sort ?? 'recent',
      }
      // Restore filter UI from URL if present, else from favorite — preserves unsaved edits after back from item detail
      const urlQ = typeof route.query.q === 'string' ? route.query.q : ''
      const urlEq = parseArrayParam(route.query.equipment_type)
      const urlGe = parseArrayParam(route.query.grade_effect)
      const urlSort = route.query.sort as string | undefined
      q.value = urlQ || fav.q || ''
      // if URL has no equipment_type/grade_effect, fallback to favorite; otherwise use URL (edited)
      const hasEqInUrl = route.query.equipment_type !== undefined
      const hasGeInUrl = route.query.grade_effect !== undefined
      selectedEquipmentTypes.value = hasEqInUrl ? urlEq : [...(fav.equipmentTypes ?? [])]
      selectedGradeEffects.value = hasGeInUrl ? urlGe as GradeEffect[] : [...(fav.gradeEffects ?? [])] as GradeEffect[]
      if (urlSort) sort.value = urlSort as 'recent' | 'price_asc' | 'price_desc'
      else sort.value = (fav.sort as 'recent' | 'price_asc' | 'price_desc') ?? 'recent'
      page.value = route.query.page ? Number(route.query.page) || 1 : 1
      await load(page.value)
    }
  } else if (!isFavView || !favId) {
    if (selectedFavorite.value) {
      selectedFavorite.value = null
      origFavoriteSnapshot.value = null
    }
  }
}

watch(() => route.path, async (newPath, oldPath) => {
  const wasFav = oldPath?.startsWith('/marketplaces/favorites')
  const isFav = newPath.startsWith('/marketplaces/favorites')
  if (isFav) {
    await favStore.fetchFavorites()
    await restoreFavoriteFromUrl()
  } else if (wasFav && newPath === '/marketplaces/list') {
    // Clean defaults when going to list from favorites detail/list
    selectedFavorite.value = null
    origFavoriteSnapshot.value = null
    resetBrowseFiltersToClean()
    await load(1)
  } else if (!isFav) {
    selectedFavorite.value = null
    origFavoriteSnapshot.value = null
  }
})
watch(() => route.query.fav, async () => {
  await restoreFavoriteFromUrl()
})

function syncUrl() {
  const query: Record<string, string> = {}
  if (page.value !== 1) query.page = String(page.value)
  if (limit.value !== 12) query.limit = String(limit.value)
  if (sort.value !== 'recent') query.sort = sort.value
  if (q.value.trim()) query.q = q.value.trim()
  if (selectedEquipmentTypes.value.length) query.equipment_type = selectedEquipmentTypes.value.join(',')
  if (selectedGradeEffects.value.length) query.grade_effect = selectedGradeEffects.value.join(',')
  if (isFavoriteView.value && selectedFavorite.value) query.fav = String(selectedFavorite.value.id)
  const basePath = isFavoriteView.value ? '/marketplaces/favorites' : '/marketplaces/list'
  router.replace({ path: basePath, query })
}
const totalPages = computed(() => Math.max(1, Math.ceil(store.total / limit.value)))
const pageNumbers = computed<(number | string)[]>(() => {
  const total = totalPages.value
  const cur = page.value
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const pages: (number | string)[] = [1]
  if (cur > 3) pages.push('...')
  const start = Math.max(2, cur - 1)
  const end = Math.min(total - 1, cur + 1)
  for (let i = start; i <= end; i++) pages.push(i)
  if (cur < total - 2) pages.push('...')
  pages.push(total)
  return pages.filter((p, idx, arr) => !(p === '...' && arr[idx - 1] === '...'))
})
type FilterChip = { key: string; label: string; clear: () => void }
const filterGroups = computed(() => {
  const groups: { key: string; title: string; chips: FilterChip[]; clearGroup: () => void }[] = []
  if (selectedEquipmentTypes.value.length) groups.push({ key: 'equipmentType', title: 'Equipment type', chips: selectedEquipmentTypes.value.map((v) => ({ key: `equipmentType:${v}`, label: v, clear: () => { selectedEquipmentTypes.value = selectedEquipmentTypes.value.filter((x) => x !== v) } })).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })), clearGroup: () => { selectedEquipmentTypes.value = [] } })
  if (selectedGradeEffects.value.length) groups.push({ key: 'gradeEffect', title: 'Grade effect', chips: selectedGradeEffects.value.map((v) => ({ key: `gradeEffect:${v}`, label: v, clear: () => { selectedGradeEffects.value = selectedGradeEffects.value.filter((x) => x !== v) } })).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })), clearGroup: () => { selectedGradeEffects.value = [] } })
  if (q.value) groups.push({ key: 'q', title: 'Search', chips: [{ key: 'q', label: `“${q.value}”`, clear: () => { q.value = '' } }], clearGroup: () => { q.value = '' } })
  return groups
})
const activeFilterCount = computed(() => filterGroups.value.reduce((n, g) => n + g.chips.length, 0))
const hasActiveFilter = computed(() => q.value.trim().length > 0 || selectedEquipmentTypes.value.length > 0 || selectedGradeEffects.value.length > 0)
function clearAllFilters() { q.value=''; selectedEquipmentTypes.value=[]; selectedGradeEffects.value=[] }

let qDebounce: ReturnType<typeof setTimeout> | null = null
let filterDebounce: ReturnType<typeof setTimeout> | null = null
watch(q, () => {
  if (qDebounce) clearTimeout(qDebounce)
  qDebounce = setTimeout(() => { page.value=1; load(1) }, 1000)
})
watch([() => [...selectedEquipmentTypes.value], () => [...selectedGradeEffects.value]], () => {
  if (filterDebounce) clearTimeout(filterDebounce)
  filterDebounce = setTimeout(() => { page.value=1; load(1) }, 300)
})
async function load(p = page.value) {
  page.value = Math.max(1, p)
  syncUrl()
  await store.fetchList({
    q: q.value || undefined,
    grade_effect: selectedGradeEffects.value.length ? [...selectedGradeEffects.value] : undefined,
    equipment_type: selectedEquipmentTypes.value.length ? [...selectedEquipmentTypes.value] : undefined,
    sort: sort.value,
    page: page.value,
    limit: limit.value,
  })
}
async function triggerAutoSync(mode: 'all' | 'latest' = 'latest', force = false) {
  if (syncing.value) return
  const AUTO_KEY = 'ghostmplay:marketplace:lastAutoSync'
  const MIN_INTERVAL = 60_000
  if (!force) {
    const last = Number(localStorage.getItem(AUTO_KEY) || 0)
    if (Date.now() - last < MIN_INTERVAL) return
  }
  if (!navigator.onLine) return
  syncing.value = true
  syncMode.value = mode
  try {
    const r = await store.refresh(q.value || undefined, mode)
    lastSynced.value = r.synced
    lastMode.value = mode
    if (r.synced > 0) {
      await store.fetchFilterOptions(true)
      pruneSelections()
      await load(page.value)
    }
    localStorage.setItem(AUTO_KEY, String(Date.now()))
  } catch (e) { console.error('auto sync failed', e) } finally { syncing.value = false }
}
watch(() => route.path, (to) => { if (to === '/marketplaces/list' || to === '/marketplaces/favorites') triggerAutoSync('latest') })
function onKeydown(e: KeyboardEvent) {
  const isR = e.code === 'KeyR' || e.key.toLowerCase() === 'r'
  const isF5 = e.code === 'F5' || e.key === 'F5'
  if ((isR && (e.ctrlKey || e.metaKey)) || isF5) {
    if (!route.path.startsWith('/marketplaces')) return
    e.preventDefault()
    triggerAutoSync('latest', true)
  }
}
function pruneSelections() {
  const validTypes = new Set(store.equipmentTypes)
  const validGrades = new Set<string>(store.gradeEffects)
  const nextTypes = selectedEquipmentTypes.value.filter((v) => validTypes.has(v))
  const nextGrades = selectedGradeEffects.value.filter((v) => validGrades.has(v as string))
  if (JSON.stringify(nextTypes) !== JSON.stringify(selectedEquipmentTypes.value)) selectedEquipmentTypes.value = nextTypes
  if (JSON.stringify(nextGrades) !== JSON.stringify(selectedGradeEffects.value)) selectedGradeEffects.value = nextGrades
}
const previewTokenId = ref<number | null>(null)
const previewOpen = ref(false)
const previewFallback = ref<{ name: string; imageUrl: string; equipmentType: string } | null>(null)
function openPreview(it: Item) {
  previewTokenId.value = it.tokenId
  previewFallback.value = { name: it.name, imageUrl: it.imageUrl, equipmentType: it.equipmentType }
  previewOpen.value = true
}

// Favorites actions
function openAddFavorite(){ showAddFavorite.value=true }
async function onSaveFavorite(name:string){
  try{
    await favStore.create({ name, q: q.value.trim() || null, equipmentTypes: [...selectedEquipmentTypes.value], gradeEffects: [...selectedGradeEffects.value], sort: sort.value })
    showAddFavorite.value=false
  }catch(e:unknown){
    // show error via alert? AddFavoriteDialog already checks existingNames; but DB unique may still throw
    const msg = e instanceof Error ? e.message : String(e)
    alert(msg)
  }
}
async function viewFavorite(fav: MarketplaceFavorite){
  selectedFavorite.value = fav
  origFavoriteSnapshot.value = {
    q: fav.q ?? null,
    equipmentTypes: [...(fav.equipmentTypes ?? [])],
    gradeEffects: [...(fav.gradeEffects ?? [])],
    sort: fav.sort ?? 'recent',
  }
  page.value=1
  q.value = fav.q ?? ''
  selectedEquipmentTypes.value = [...(fav.equipmentTypes ?? [])]
  selectedGradeEffects.value = [...(fav.gradeEffects ?? [])] as GradeEffect[]
  sort.value = (fav.sort as 'recent'|'price_asc'|'price_desc') ?? 'recent'
  await load(1)
}
async function updateFavorite(){
  if (!selectedFavorite.value || !isFavoriteDirty.value) return
  updatingFavorite.value = true
  try {
    const updated = await favStore.update(selectedFavorite.value.id, {
      q: q.value.trim() || null,
      equipmentTypes: [...selectedEquipmentTypes.value],
      gradeEffects: [...selectedGradeEffects.value],
      sort: sort.value,
    })
    selectedFavorite.value = updated
    origFavoriteSnapshot.value = {
      q: updated.q ?? null,
      equipmentTypes: [...(updated.equipmentTypes ?? [])],
      gradeEffects: [...(updated.gradeEffects ?? [])],
      sort: updated.sort ?? 'recent',
    }
    await load(1)
  } catch (e: unknown) {
    alert(e instanceof Error ? e.message : String(e))
  } finally {
    updatingFavorite.value = false
  }
}
async function applyFavorite(fav: MarketplaceFavorite){
  selectedFavorite.value = null
  origFavoriteSnapshot.value = null
  q.value = fav.q ?? ''
  selectedEquipmentTypes.value = [...(fav.equipmentTypes ?? [])]
  selectedGradeEffects.value = [...(fav.gradeEffects ?? [])] as GradeEffect[]
  sort.value = (fav.sort as 'recent'|'price_asc'|'price_desc') ?? 'recent'
  page.value=1
  router.replace({ path: '/marketplaces/list', query: {} })
  await load(1)
}
function backToFavorites(){
  selectedFavorite.value=null
  origFavoriteSnapshot.value=null
  favStore.fetchFavorites()
  router.replace({ path: '/marketplaces/favorites' })
}
function startRename(fav: MarketplaceFavorite){ renameTarget.value=fav; renameName.value=fav.name; renameError.value=''; showRename.value=true }
async function doRename(){
  const n = renameName.value.trim()
  if(!n){ renameError.value='Name required'; return }
  if(n.length>50){ renameError.value='Max 50 chars'; return }
  if(favStore.favorites.some(f=> f.id!==renameTarget.value?.id && f.name.toLowerCase()===n.toLowerCase())){ renameError.value=`Favorite "${n}" already exists`; return }
  try{
    await favStore.update(renameTarget.value!.id, { name: n })
    if(selectedFavorite.value && selectedFavorite.value.id===renameTarget.value!.id) selectedFavorite.value.name=n
    showRename.value=false
  }catch(e:unknown){ renameError.value = e instanceof Error ? e.message : String(e) }
}
function confirmDelete(fav: MarketplaceFavorite){ deleteTarget.value=fav; showDelete.value=true }
async function doDelete(){
  if(!deleteTarget.value) return
  const id = deleteTarget.value.id
  const wasDetail = selectedFavorite.value?.id===id
  if(wasDetail) { selectedFavorite.value=null; origFavoriteSnapshot.value=null }
  await favStore.remove(id)
  showDelete.value=false
  if (wasDetail && route.query.fav) {
    router.replace({ path: '/marketplaces/favorites' })
  }
}

onMounted(async () => {
  // Legacy redirect: ?tab=favorite or ?tab=browse → new paths
  const legacyTab = route.query.tab as string | undefined
  if (legacyTab) {
    const { tab: _t, ...rest } = route.query as Record<string, string>
    if (legacyTab === 'favorite') router.replace({ path: '/marketplaces/favorites', query: rest })
    else router.replace({ path: '/marketplaces/list', query: rest })
    return
  }
  await Promise.all([store.fetchFilterOptions(), favStore.fetchFavorites()])
  // If URL has fav param under /favorites (e.g., back from /items/:id), restore detail before first load
  if (route.path.startsWith('/marketplaces/favorites') && route.query.fav) {
    await restoreFavoriteFromUrl()
  } else {
    await load()
  }
  pruneSelections()
  triggerAutoSync('latest')
  window.addEventListener('keydown', onKeydown)
})
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>
