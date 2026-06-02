import { ref, watch } from 'vue'

const STORAGE_KEY = 'anovel-appearance'
const LEGACY_THEME_KEY = 'anovel-theme'

export interface AppearanceSettings {
  theme: string
  fontSize: number
  uiScale: number
  spacing: number
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: 'dark',
  fontSize: 14,
  uiScale: 100,
  spacing: 115
}

export const ALL_THEMES = [
  'light', 'dark', 'cupcake', 'bumblebee', 'emerald', 'corporate',
  'synthwave', 'retro', 'cyberpunk', 'valentine', 'halloween',
  'garden', 'forest', 'aqua', 'lofi', 'pastel', 'fantasy',
  'wireframe', 'black', 'luxury', 'dracula', 'cmyk', 'autumn',
  'business', 'acid', 'lemonade', 'night', 'coffee', 'winter',
  'dim', 'nord', 'sunset'
] as const

const THEME_LABELS: Record<string, string> = {
  light: '浅色',
  dark: '深色',
  cupcake: 'Cupcake',
  bumblebee: 'Bumblebee',
  emerald: 'Emerald',
  corporate: 'Corporate',
  synthwave: 'Synthwave',
  retro: 'Retro',
  cyberpunk: 'Cyberpunk',
  valentine: 'Valentine',
  halloween: 'Halloween',
  garden: 'Garden',
  forest: 'Forest',
  aqua: 'Aqua',
  lofi: 'Lo-Fi',
  pastel: 'Pastel',
  fantasy: 'Fantasy',
  wireframe: 'Wireframe',
  black: 'Black',
  luxury: 'Luxury',
  dracula: 'Dracula',
  cmyk: 'CMYK',
  autumn: 'Autumn',
  business: 'Business',
  acid: 'Acid',
  lemonade: 'Lemonade',
  night: 'Night',
  coffee: 'Coffee',
  winter: 'Winter',
  dim: 'Dim',
  nord: 'Nord',
  sunset: 'Sunset'
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function normalize(settings: Partial<AppearanceSettings>): AppearanceSettings {
  return {
    theme: ALL_THEMES.includes(settings.theme as typeof ALL_THEMES[number])
      ? settings.theme!
      : DEFAULT_APPEARANCE.theme,
    fontSize: round1(clamp(settings.fontSize ?? DEFAULT_APPEARANCE.fontSize, 12, 20)),
    uiScale: round1(clamp(settings.uiScale ?? DEFAULT_APPEARANCE.uiScale, 80, 120)),
    spacing: round1(clamp(settings.spacing ?? DEFAULT_APPEARANCE.spacing, 75, 125))
  }
}

export function getThemeLabel(theme: string): string {
  return THEME_LABELS[theme] ?? theme
}

export function loadAppearanceSettings(): AppearanceSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      return normalize(JSON.parse(raw) as Partial<AppearanceSettings>)
    }
  } catch {
    // ignore invalid storage
  }

  const legacyTheme = localStorage.getItem(LEGACY_THEME_KEY)
  return normalize({
    ...DEFAULT_APPEARANCE,
    theme: legacyTheme && ALL_THEMES.includes(legacyTheme as typeof ALL_THEMES[number])
      ? legacyTheme
      : DEFAULT_APPEARANCE.theme
  })
}

export function applyAppearanceSettings(settings: AppearanceSettings): void {
  const normalized = normalize(settings)
  const root = document.documentElement

  root.setAttribute('data-theme', normalized.theme)
  root.style.setProperty('--font-size-base', `${normalized.fontSize}px`)
  root.style.setProperty('--ui-scale', String(normalized.uiScale / 100))
  root.style.setProperty('--spacing-scale', String(normalized.spacing / 100))

  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  localStorage.setItem(LEGACY_THEME_KEY, normalized.theme)
}

const appearance = ref<AppearanceSettings>(loadAppearanceSettings())
let initialized = false

export function useAppearanceSettings() {
  if (!initialized && typeof document !== 'undefined') {
    applyAppearanceSettings(appearance.value)
    initialized = true
  }

  function update(partial: Partial<AppearanceSettings>) {
    appearance.value = normalize({ ...appearance.value, ...partial })
    applyAppearanceSettings(appearance.value)
  }

  function reset() {
    appearance.value = { ...DEFAULT_APPEARANCE }
    applyAppearanceSettings(appearance.value)
  }

  return {
    appearance,
    update,
    reset,
    apply: () => applyAppearanceSettings(appearance.value)
  }
}

export function initAppearanceSettings(): void {
  const settings = loadAppearanceSettings()
  applyAppearanceSettings(settings)
  appearance.value = settings
  initialized = true
}

export function watchAppearanceSettings(onChange?: () => void) {
  return watch(
    appearance,
    () => {
      applyAppearanceSettings(appearance.value)
      onChange?.()
    },
    { deep: true }
  )
}
