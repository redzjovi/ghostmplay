import { computed, ref, watch } from 'vue'

/** What the visitor picked: an explicit theme, or "whatever the OS is set to". */
export type ThemePreference = 'light' | 'dark' | 'system'

/** The theme actually in effect once `system` has been resolved. */
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'ghostmplay:theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

function readPreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system'
  // Anything unrecognized (including a missing key) falls back to system, so a
  // value written by an older build — or a corrupted one — never sticks.
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored === 'light' || stored === 'dark' ? stored : 'system'
}

const preference = ref<ThemePreference>(readPreference())
const media = typeof window !== 'undefined' ? window.matchMedia(DARK_QUERY) : null
const systemDark = ref(media?.matches ?? false)

function resolve(pref: ThemePreference, systemIsDark: boolean): ResolvedTheme {
  return pref === 'system' ? (systemIsDark ? 'dark' : 'light') : pref
}

const theme = computed<ResolvedTheme>(() => resolve(preference.value, systemDark.value))

function apply() {
  document.documentElement.classList.toggle('dark', theme.value === 'dark')
}

// Applied on import so a reload lands on the saved theme before mount (no FOUC).
// main.ts imports this module for that reason.
apply()

watch([preference, systemDark], ([pref]) => {
  localStorage.setItem(STORAGE_KEY, pref)
  document.documentElement.classList.toggle('dark', theme.value === 'dark')
})

// "system" has to track the OS while the tab is open, not just at load.
media?.addEventListener('change', (event) => {
  systemDark.value = event.matches
})

/**
 * `preference` is what the visitor chose (bind it to the appearance control),
 * `theme` is the resolved light/dark in effect.
 */
export function useTheme() {
  function setPreference(value: ThemePreference) {
    preference.value = value
  }
  return { preference, theme, setPreference }
}
