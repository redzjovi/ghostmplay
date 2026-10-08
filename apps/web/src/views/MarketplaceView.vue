<template>
  <div class="p-5 space-y-3">
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-2xl font-semibold">Marketplace</h2>
      <!-- Passive only. The sync controls live on the admin Data page; this stays so
           an admin who kicked off a run still sees the data moving. -->
      <span v-if="sync.isAdmin" class="text-xs text-muted-foreground">{{ lastSyncedLabel }}</span>
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
                <PopoverContent class="w-64 p-0" align="start">
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
                <PopoverContent class="w-56 p-0" align="start">
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
                <Input v-model="q" placeholder="Please enter your search term." class="pl-8" @keyup.enter="applyFilters()" />
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

            <div class="flex gap-2 items-center flex-wrap">
              <Button variant="default" size="sm" @click="applyFilters()">Apply</Button>
              <Button variant="ghost" size="sm" @click="clearAllFilters()">Clear</Button>
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

        <div v-if="mkt.running && sync.isAdmin" class="text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 class="h-4 w-4 animate-spin" />
          Syncing {{ syncModeLabel(mkt.mode) }}…
        </div>
        <Alert v-if="sync.error" variant="destructive" class="py-2">
          <AlertDescription>{{ sync.error }}</AlertDescription>
        </Alert>
        <p class="text-sm text-muted-foreground">Total: {{ store.total }} · Showing {{ store.items.length }}<span v-if="mkt.lastSynced!==null"> · Last sync ({{ syncModeLabel(mkt.mode) }}): {{ mkt.lastSynced }} new</span> · Page {{ page }}/{{ totalPages }}</p>

        <div :class="viewMode==='grid' ? 'grid gap-3 grid-cols-[repeat(auto-fill,minmax(200px,1fr))]' : 'flex flex-col gap-1.5'">
          <Card v-for="it in (store.items as Item[])" :key="it.tokenId" :class="[viewMode==='list' ? 'flex flex-row items-center gap-2 overflow-hidden' : 'flex flex-col gap-2 overflow-hidden', isSoldOut(it) ? 'opacity-60' : '']">
            <router-link :to="`/items/${it.tokenId}`" class="block overflow-hidden leading-[0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring relative group" :class="viewMode==='list' ? 'rounded-l-lg w-12 shrink-0' : 'rounded-t-md'" :aria-label="`View ${it.name} details`" :title="it.name">
              <Badge v-if="isSoldOut(it)" variant="destructive" class="absolute top-1.5 left-1.5 z-10 text-[10px] px-1.5 py-0.5">Sold Out</Badge>
              <div class="absolute inset-0 z-10 grid place-items-center pointer-events-none transition-colors group-hover:bg-black/20" :class="viewMode==='list' ? 'hidden' : 'opacity-0 group-hover:opacity-100 focus-visible-within:opacity-100'"><Button variant="secondary" size="icon" class="pointer-events-auto h-9 w-9 rounded-full bg-background/95 shadow-lg hover:opacity-100" title="Preview" aria-label="Preview" @click.stop.prevent="openPreview(it)"><Eye class="h-4 w-4" /></Button></div>
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
              <span class="min-w-0 flex-1 truncate text-sm font-medium"><router-link :to="`/items/${it.tokenId}`" class="hover:text-primary hover:underline underline-offset-2" :title="it.name">{{ it.name }}</router-link></span>
              <span class="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{{ it.equipmentType }}</span>
              <span class="shrink-0 whitespace-nowrap text-xs text-muted-foreground">Lv {{ it.level }}</span>
              <span class="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{{ it.gradeEffect }}</span>
              <span class="w-10 shrink-0 whitespace-nowrap text-right text-xs text-muted-foreground">{{ it.enchant ? '+' + it.enchant : '–' }}</span>
              <Button variant="ghost" size="icon" class="shrink-0 h-7 w-7" title="Preview" aria-label="Preview" @click.stop="openPreview(it)"><Eye class="h-4 w-4" /></Button>
            </template>
            <div v-else class="flex flex-col gap-1 min-w-0 px-3">
              <CardTitle class="text-sm leading-tight truncate"><router-link :to="`/items/${it.tokenId}`" class="hover:text-primary hover:underline underline-offset-2" :title="it.name">{{ it.name }}</router-link></CardTitle>
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

        <ListPagination :page="page" :limit="limit" :total="store.total" @update:page="goToPage" />
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
                  <PopoverContent class="w-64 p-0" align="start">
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
                  <PopoverContent class="w-56 p-0" align="start">
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
                  <Input v-model="q" placeholder="Please enter your search term." class="pl-8" @keyup.enter="applyFilters()" />
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

            <!-- The card is a form: nothing here reaches the list until Apply, so a
                 half-typed search never pushes a history entry. Page size and sort
                 sit outside it and apply immediately. -->
            <div class="flex gap-2 items-center flex-wrap">
              <Button variant="default" size="sm" @click="applyFilters()">Apply</Button>
              <Button variant="ghost" size="sm" @click="clearAllFilters()">Clear</Button>
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

          <div v-if="mkt.running && sync.isAdmin" class="text-sm text-muted-foreground flex items-center gap-2"><Loader2 class="h-4 w-4 animate-spin" /> Syncing {{ syncModeLabel(mkt.mode) }} …</div>
          <div class="text-sm text-muted-foreground">Total: {{ store.total }} · Showing {{ store.items.length }} · Page {{ page }}/{{ totalPages }}</div>
          <div :class="viewMode==='grid' ? 'grid gap-3 grid-cols-[repeat(auto-fill,minmax(200px,1fr))]' : 'flex flex-col gap-1.5'">
            <Card v-for="it in (store.items as Item[])" :key="it.tokenId" :class="[viewMode==='list' ? 'flex flex-row items-center gap-2 overflow-hidden' : 'flex flex-col gap-2 overflow-hidden', isSoldOut(it) ? 'opacity-60' : '']">
              <router-link :to="`/items/${it.tokenId}`" class="block overflow-hidden leading-[0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring relative group" :class="viewMode==='list' ? 'rounded-l-lg w-12 shrink-0' : 'rounded-t-md'" :aria-label="`View ${it.name} details`" :title="it.name">
                <Badge v-if="isSoldOut(it)" variant="destructive" class="absolute top-1.5 left-1.5 z-10 text-[10px] px-1.5 py-0.5">Sold Out</Badge>
                <div class="absolute inset-0 z-10 grid place-items-center pointer-events-none transition-colors group-hover:bg-black/20" :class="viewMode==='list' ? 'hidden' : 'opacity-0 group-hover:opacity-100 focus-visible-within:opacity-100'"><Button variant="secondary" size="icon" class="pointer-events-auto h-9 w-9 rounded-full bg-background/95 shadow-lg hover:opacity-100" title="Preview" aria-label="Preview" @click.stop.prevent="openPreview(it)"><Eye class="h-4 w-4" /></Button></div>
                <AspectRatio :ratio="1" class="relative w-full bg-muted overflow-hidden rounded-md">
                  <Skeleton v-if="hasImage(it) && !imageLoaded(imageKey(it)) && !imageFailed(imageKey(it))" class="absolute inset-0 h-full w-full rounded-md" />
                  <div v-if="!hasImage(it) || imageFailed(imageKey(it))" class="absolute inset-0 grid place-items-center bg-muted p-2 text-center"><div class="space-y-1"><div class="text-xs font-medium text-muted-foreground line-clamp-2 px-1">{{ it.name }}</div><div class="text-[10px] text-muted-foreground/60">No Image</div></div></div>
                  <img v-if="hasImage(it) && !imageFailed(imageKey(it))" :key="imageKey(it)" :src="normalizeImageUrl(it.imageUrl)" :alt="it.name" class="h-full w-full object-cover" :class="{ 'opacity-0': !imageLoaded(imageKey(it)), 'opacity-100 transition-opacity': imageLoaded(imageKey(it)) }" decoding="async" @load="markImageLoaded(imageKey(it))" @error="(e:any)=>onImageError(e, imageKey(it))" />
                </AspectRatio>
              </router-link>
              <template v-if="viewMode==='list'">
                <span class="min-w-0 flex-1 truncate text-sm font-medium"><router-link :to="`/items/${it.tokenId}`" class="hover:text-primary hover:underline underline-offset-2" :title="it.name">{{ it.name }}</router-link></span>
                <span class="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{{ it.equipmentType }}</span>
                <span class="shrink-0 whitespace-nowrap text-xs text-muted-foreground">Lv {{ it.level }}</span>
                <span class="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{{ it.gradeEffect }}</span>
                <span class="w-10 shrink-0 whitespace-nowrap text-right text-xs text-muted-foreground">{{ it.enchant ? '+' + it.enchant : '–' }}</span>
                <Button variant="ghost" size="icon" class="shrink-0 h-7 w-7" title="Preview" aria-label="Preview" @click.stop="openPreview(it)"><Eye class="h-4 w-4" /></Button>
              </template>
              <div v-else class="flex flex-col gap-1 min-w-0 px-3">
                <CardTitle class="text-sm leading-tight truncate"><router-link :to="`/items/${it.tokenId}`" class="hover:text-primary hover:underline underline-offset-2" :title="it.name">{{ it.name }}</router-link></CardTitle>
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
          <ListPagination :page="page" :limit="limit" :total="store.total" @update:page="goToPage" />
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
              <router-link :to="favoriteRoute(fav)" class="text-left text-sm font-medium truncate hover:underline hover:text-primary" :title="fav.name">{{ fav.name }}</router-link>
              <div class="text-[11px] text-muted-foreground leading-none">{{ formatDateTime(fav.createdAt) }}</div>
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
import { ref, computed, watch, onMounted } from 'vue'
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
import { useAuthStore } from '@/stores/auth'
import { useSyncStore } from '@/stores/sync'
import type { GradeEffect, MarketplaceFavorite } from '@ghostmplay/shared'
import ItemPreviewDialog from '@/components/ItemPreviewDialog.vue'
import AddFavoriteDialog from '@/components/AddFavoriteDialog.vue'
import ListPagination from '@/components/ListPagination.vue'
import {
  MARKET_PAGE_SIZES,
  MARKET_DEFAULT_LIMIT,
  MARKET_LIMIT_KEY,
  buildMarketQuery,
  clampPage,
  joinCsv,
  marketStateFromQuery,
  parseArrayParam,
  totalPageCount,
  type MarketListState,
  type MarketSort,
} from '@/lib/listQuery'
import { formatDateTime, formatPrice } from '@/lib/format'

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
type Item = { tokenId:number; name:string; imageUrl:string; equipmentType:string; level:number; enchant:number; gradeEffect:string; price:number; currency:string; mintTime?: string | null; createdAt?: string | null; soldAt?: string | null; soldPrice?: number | null }
const store = useMarketplaceStore()
const favStore = useFavoritesStore()
// Browsing is public; favorites are per-account. `next` returns the visitor to
// this exact page (filters and all) once they have signed in.
const auth = useAuthStore()
const loadedImages = ref<Set<string>>(new Set())
const errorImages = ref<Set<string>>(new Set())
function imageKey(it: Item): string { return `${it.tokenId}:${normalizeImageUrl(it.imageUrl)}` }
function markImageLoaded(key: string) { loadedImages.value = new Set(loadedImages.value).add(key) }
function onImageError(e: Event, key: string) { errorImages.value = new Set(errorImages.value).add(key); markImageLoaded(key); (e.target as HTMLImageElement).style.display='none' }
function hasImage(it: Item): boolean { return !!normalizeImageUrl(it.imageUrl) }
function imageLoaded(key: string): boolean { return loadedImages.value.has(key) }
function imageFailed(key: string): boolean { return errorImages.value.has(key) }
// Grid cards only ever come from the list endpoint, which already excludes sold
// items, so there is no fallback here — soldAt should be null for everything shown.
function isSoldOut(it: Item): boolean { return it.soldAt != null }
function favSortLabel(s:string){ if(s==='price_asc') return 'Price low → high'; if(s==='price_desc') return 'Price high → low'; return 'Recently registered' }

const route = useRoute()
const router = useRouter()

// The URL is the source of truth for everything that shapes the result set. These
// refs mirror it and are rewritten from it on every route change; edits a user
// makes in the filter card stay local until Apply turns them into a navigation.
const initialState = marketStateFromQuery(route.query, localStorage.getItem(MARKET_LIMIT_KEY))
const q = ref(initialState.q)
const sort = ref<MarketSort>(initialState.sort)
const page = ref(initialState.page)
const limit = ref(initialState.limit)
const equipmentType = ref(initialState.equipmentType)
const gradeEffect = ref(initialState.gradeEffect)
const selectedFavoriteId = ref<number | null>(initialState.fav)

// Array views of the CSV filter state, for the checkbox lists and the API query.
const selectedEquipmentTypes = computed(() => parseArrayParam(equipmentType.value))
const selectedGradeEffects = computed(() => parseArrayParam(gradeEffect.value) as GradeEffect[])

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
  const next = i >= 0 ? selectedEquipmentTypes.value.filter((x) => x !== v) : [...selectedEquipmentTypes.value, v]
  equipmentType.value = joinCsv(next)
}
function toggleGrade(v: string) {
  const i = selectedGradeEffects.value.indexOf(v as GradeEffect)
  const next = i >= 0 ? selectedGradeEffects.value.filter((x) => x !== v) : [...selectedGradeEffects.value, v as GradeEffect]
  gradeEffect.value = joinCsv(next as string[])
}

const viewMode = ref<'grid' | 'list'>((localStorage.getItem('ghostmplay:marketplace:viewMode') as 'grid' | 'list') || 'grid')
watch(viewMode, (v) => localStorage.setItem('ghostmplay:marketplace:viewMode', v))

// Sync runs in the background server-side and is admin-only; see stores/sync.ts.
// The controls live on the admin Data page. This view only reads its own kind's
// status, so a history backfill neither shows up here nor reports its item count
// as the marketplace's.
const sync = useSyncStore()
const mkt = computed(() => sync.forKind('marketplace'))
const PAGE_SIZES = MARKET_PAGE_SIZES

const isFavoriteView = computed(() => route.path.startsWith('/marketplaces/favorites'))
const basePath = computed(() => (isFavoriteView.value ? '/marketplaces/favorites' : '/marketplaces/list'))
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

/** Snapshot of the filter refs as the URL currently represents them. */
function currentState(): MarketListState {
  return {
    page: page.value,
    limit: limit.value,
    sort: sort.value,
    q: q.value.trim(),
    equipmentType: equipmentType.value,
    gradeEffect: gradeEffect.value,
    fav: isFavoriteView.value ? selectedFavoriteId.value : null,
  }
}

function applyState(s: MarketListState) {
  q.value = s.q
  sort.value = s.sort
  page.value = s.page
  limit.value = s.limit
  equipmentType.value = s.equipmentType
  gradeEffect.value = s.gradeEffect
  selectedFavoriteId.value = s.fav
}

/**
 * True when `query` already describes the current route. Both sides are compared
 * as CSV so `?a=1&a=2` and `?a=1,2` are the same place. This is what makes
 * `commit` idempotent, so a watcher that fires while `applyState` is writing the
 * refs cannot push a duplicate entry.
 */
function routeMatches(path: string, query: Record<string, string>): boolean {
  if (path !== route.path) return false
  const keys = new Set([...Object.keys(route.query), ...Object.keys(query)])
  for (const k of keys) {
    if (parseArrayParam(route.query[k]).join(',') !== parseArrayParam(query[k]).join(',')) return false
  }
  return true
}

/**
 * Write a change to the URL. Push by default so Back undoes it; `replace` is for
 * corrections that should not add an entry (mount-time normalisation, clamping an
 * out-of-range page).
 */
function commit(patch: Partial<MarketListState> = {}, opts: { replace?: boolean; path?: string } = {}) {
  // Any change other than paging invalidates the current page.
  const paged = patch.page !== undefined ? patch : { ...patch, page: 1 }
  const next = { ...currentState(), ...paged }
  const path = opts.path ?? basePath.value
  const query = buildMarketQuery(next)
  // Nothing to navigate to. The route watcher below is what loads the new state,
  // so skipping here also skips the refetch.
  if (routeMatches(path, query)) return
  void (opts.replace ? router.replace({ path, query }) : router.push({ path, query }))
}

const totalPages = computed(() => totalPageCount(store.total, limit.value))

type FilterChip = { key: string; label: string; clear: () => void }
const filterGroups = computed(() => {
  const groups: { key: string; title: string; chips: FilterChip[]; clearGroup: () => void }[] = []
  if (selectedEquipmentTypes.value.length) groups.push({ key: 'equipmentType', title: 'Equipment type', chips: selectedEquipmentTypes.value.map((v) => ({ key: `equipmentType:${v}`, label: v, clear: () => { equipmentType.value = joinCsv(selectedEquipmentTypes.value.filter((x) => x !== v)) } })).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })), clearGroup: () => { equipmentType.value = '' } })
  if (selectedGradeEffects.value.length) groups.push({ key: 'gradeEffect', title: 'Grade effect', chips: selectedGradeEffects.value.map((v) => ({ key: `gradeEffect:${v}`, label: v, clear: () => { gradeEffect.value = joinCsv(selectedGradeEffects.value.filter((x) => x !== v)) } })).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })), clearGroup: () => { gradeEffect.value = '' } })
  if (q.value.trim()) groups.push({ key: 'q', title: 'Search', chips: [{ key: 'q', label: `“${q.value.trim()}”`, clear: () => { q.value = '' } }], clearGroup: () => { q.value = '' } })
  return groups
})
const activeFilterCount = computed(() => filterGroups.value.reduce((n, g) => n + g.chips.length, 0))
const hasActiveFilter = computed(() => q.value.trim().length > 0 || selectedEquipmentTypes.value.length > 0 || selectedGradeEffects.value.length > 0)

/** Submit the filter card. Everything above Apply is staged until this runs. */
function applyFilters() {
  commit({ q: q.value.trim(), equipmentType: equipmentType.value, gradeEffect: gradeEffect.value })
}
function clearAllFilters() {
  q.value = ''
  equipmentType.value = ''
  gradeEffect.value = ''
  commit({ q: '', equipmentType: '', gradeEffect: '' })
}

/** Fetches the page the refs currently describe. Never touches the URL. */
async function fetchPage() {
  await store.fetchList({
    q: q.value.trim() || undefined,
    grade_effect: selectedGradeEffects.value.length ? [...selectedGradeEffects.value] : undefined,
    equipment_type: selectedEquipmentTypes.value.length ? [...selectedEquipmentTypes.value] : undefined,
    sort: sort.value,
    page: page.value,
    limit: limit.value,
  })
  // A page past the end (out-of-range link, or a filter that shrank the result
  // set) would otherwise leave an empty grid under "Page 12/3". Replace rather
  // than push: the entry the user is on should end up valid. The route watcher
  // picks the corrected page up and refetches, so no explicit reload here.
  const last = clampPage(page.value, store.total, limit.value)
  if (last !== page.value) {
    page.value = last
    commit({ page: last }, { replace: true })
  }
}

function goToPage(p: number) {
  commit({ page: Math.max(1, p) })
}

// Sort and page size sit outside the filter card and apply immediately.
watch(sort, (v) => commit({ sort: v }))
watch(limit, (v) => {
  localStorage.setItem(MARKET_LIMIT_KEY, String(v))
  commit({ limit: v })
})

// Read straight from the sync store rather than snapshotting after a self-triggered
// run: the store already polls while anything is in flight, so this is current
// whether the run was started here, on the Data page, or by the cron.
const lastSyncedLabel = computed(() => {
  const at = mkt.value.lastFinishedAt
  if (!at) return 'Not synced yet'
  const n = mkt.value.lastSynced
  return `Last sync: ${formatDateTime(at)}${n === null ? '' : ` · ${n} new`}`
})

function syncModeLabel(mode: string | null | undefined): string {
  if (mode === 'all') return 'Full'
  if (mode === 'latest') return 'Latest'
  return ''
}
/**
 * Drop filter values the server no longer offers. Silent, like the original: a
 * filter that has quietly become unavailable should not add a history entry.
 */
function pruneSelections() {
  const validTypes = new Set(store.equipmentTypes)
  const validGrades = new Set<string>(store.gradeEffects)
  const nextTypes = selectedEquipmentTypes.value.filter((v) => validTypes.has(v))
  const nextGrades = selectedGradeEffects.value.filter((v) => validGrades.has(v as string))
  if (nextTypes.join() !== selectedEquipmentTypes.value.join()) equipmentType.value = joinCsv(nextTypes)
  if (nextGrades.join() !== selectedGradeEffects.value.join()) gradeEffect.value = joinCsv(nextGrades as string[])
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
/** Sends a signed-out visitor to the login form, remembering where they were. */
function requireAuth(): boolean {
  if (auth.isAuthenticated) return true
  void router.push({ name: 'login', query: { next: route.fullPath } })
  return false
}
function openAddFavorite(){ if(!requireAuth()) return; showAddFavorite.value=true }
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
/**
 * Where a favorite lives: the favorites route carrying that favorite's own
 * filters. Rendered as a router-link `to` so the browser gets a real href and
 * open-in-new-tab, middle click and ctrl/cmd click all work, while a plain click
 * stays a same-tab push. The route watcher re-derives the selected favorite from
 * this URL, so nothing needs to be set here.
 */
function favoriteRoute(fav: MarketplaceFavorite){
  return {
    path: '/marketplaces/favorites',
    query: buildMarketQuery({
      ...currentState(),
      page: 1,
      fav: fav.id,
      q: fav.q ?? '',
      equipmentType: joinCsv(fav.equipmentTypes ?? []),
      gradeEffect: joinCsv(fav.gradeEffects ?? []),
      sort: (fav.sort as MarketSort) ?? 'recent',
    }),
  }
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
  } catch (e: unknown) {
    alert(e instanceof Error ? e.message : String(e))
  } finally {
    updatingFavorite.value = false
  }
}
async function applyFavorite(fav: MarketplaceFavorite){
  selectedFavorite.value = null
  origFavoriteSnapshot.value = null
  commit({
    page: 1,
    fav: null,
    q: fav.q ?? '',
    equipmentType: joinCsv(fav.equipmentTypes ?? []),
    gradeEffect: joinCsv(fav.gradeEffects ?? []),
    sort: (fav.sort as MarketSort) ?? 'recent',
  }, { path: '/marketplaces/list' })
}
function backToFavorites(){
  selectedFavorite.value=null
  origFavoriteSnapshot.value=null
  void favStore.fetchFavorites()
  commit({ fav: null, q: '', equipmentType: '', gradeEffect: '' }, { path: '/marketplaces/favorites' })
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
    commit({ fav: null, q: '', equipmentType: '', gradeEffect: '' }, { path: '/marketplaces/favorites' })
  }
}

// The single place state is derived from the URL. Back, Forward, a pushed filter
// change and a fresh load all arrive here, which is why they can never disagree
// about what page is showing.
watch(
  () => route.fullPath,
  async () => {
    const next = marketStateFromQuery(route.query, localStorage.getItem(MARKET_LIMIT_KEY))
    applyState(next)
    if (!isFavoriteView.value || !next.fav) {
      selectedFavorite.value = null
      origFavoriteSnapshot.value = null
    } else {
      await syncSelectedFavorite(next.fav)
    }
    await fetchPage()
    pruneSelections()
  },
)

/**
 * Load a favorite and adopt its stored filters for the parts the URL left unset,
 * so `/favorites?fav=3` shows the favorite rather than an unfiltered list.
 */
async function syncSelectedFavorite(favId: number) {
  if (!favStore.favorites.length) await favStore.fetchFavorites()
  const fav = favStore.favorites.find((f) => f.id === favId)
  if (!fav) {
    selectedFavorite.value = null
    origFavoriteSnapshot.value = null
    return
  }
  if (selectedFavorite.value?.id !== favId) {
    selectedFavorite.value = fav
    origFavoriteSnapshot.value = {
      q: fav.q ?? null,
      equipmentTypes: [...(fav.equipmentTypes ?? [])],
      gradeEffects: [...(fav.gradeEffects ?? [])],
      sort: fav.sort ?? 'recent',
    }
  }
  // Anything the URL does not mention falls back to the favorite's own value.
  if (!route.query.equipment_type) equipmentType.value = joinCsv(fav.equipmentTypes ?? [])
  if (!route.query.grade_effect) gradeEffect.value = joinCsv(fav.gradeEffects ?? [])
  if (!route.query.q && fav.q) q.value = fav.q
  if (!route.query.sort) sort.value = (fav.sort as MarketSort) ?? 'recent'
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
  // Filters are public; favorites are not. Fetching them in the same Promise.all
  // would reject on 401 for a guest and skip the first load, leaving the list empty.
  await store.fetchFilterOptions()
  if (auth.isAuthenticated) await favStore.fetchFavorites().catch(() => {})
  // No-op for non-admins: the store checks the role and the endpoints are 403 anyway.
  void sync.start()

  // A bare URL carries no page size, but one may be remembered from a previous
  // visit. Replace (never push) so the URL becomes shareable without adding an
  // entry the user never asked for. The replace lands in the route watcher, which
  // does the first load — hence the flag instead of a fetch on both paths.
  const normalized = buildMarketQuery(currentState())
  const needsNormalize = !routeMatches(basePath.value, normalized)
  if (needsNormalize) router.replace({ path: basePath.value, query: normalized })

  if (selectedFavoriteId.value) await syncSelectedFavorite(selectedFavoriteId.value)
  if (!needsNormalize) await fetchPage()
  pruneSelections()
})
</script>
