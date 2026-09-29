import { ref, watch } from 'vue'

export type Theme = 'light' | 'dark'

const theme = ref<Theme>((localStorage.getItem('ghostmplay:theme') as Theme) || 'light')

function applyTheme(value: Theme) {
  const isDark = value === 'dark'
  document.documentElement.classList.toggle('dark', isDark)
  localStorage.setItem('ghostmplay:theme', value)
}

watch(theme, applyTheme, { immediate: false })

// apply synchronously on import to avoid FOUC
applyTheme(theme.value)

export function useTheme() {
  function toggle() {
    theme.value = theme.value === 'light' ? 'dark' : 'light'
    applyTheme(theme.value)
  }
  function setTheme(value: Theme) {
    theme.value = value
    applyTheme(value)
  }
  return { theme, toggle, setTheme }
}
