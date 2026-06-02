/** @type {import('tailwindcss').Config} */

// DaisyUI v5 uses CSS custom properties (oklch) for colors.
// Tailwind v3 cannot generate opacity-modifier utilities (e.g. text-primary/70)
// for CSS variable colors. This plugin generates them via color-mix().
function daisyOpacityPlugin({ addUtilities }) {
  const colors = [
    'primary', 'primary-content',
    'secondary', 'secondary-content',
    'accent', 'accent-content',
    'neutral', 'neutral-content',
    'base-100', 'base-200', 'base-300', 'base-content',
    'info', 'info-content',
    'success', 'success-content',
    'warning', 'warning-content',
    'error', 'error-content',
  ]
  const opacities = [5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90]
  const utils = {}

  for (const color of colors) {
    const varName = `--color-${color}`
    // Plain utilities (ensure they exist even when only used with opacity modifier)
    utils[`.bg-${color}`] = { 'background-color': `var(${varName})` }
    utils[`.text-${color}`] = { color: `var(${varName})` }
    utils[`.border-${color}`] = { 'border-color': `var(${varName})` }
    utils[`.ring-${color}`] = { '--tw-ring-color': `var(${varName})` }

    // Opacity-modifier variants via color-mix
    for (const pct of opacities) {
      const mix = `color-mix(in oklab, var(${varName}) ${pct}%, transparent)`
      utils[`.bg-${color}\\/${pct}`] = { 'background-color': mix }
      utils[`.text-${color}\\/${pct}`] = { color: mix }
      utils[`.border-${color}\\/${pct}`] = { 'border-color': mix }
    }
  }
  addUtilities(utils, { respectPrefix: true, respectImportant: true })
}

export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{vue,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'Arial', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'monospace']
      },
      fontSize: {
        xs: ['0.75rem', { lineHeight: '1rem' }],
        sm: ['0.875rem', { lineHeight: '1.25rem' }],
        base: ['1rem', { lineHeight: '1.5rem' }],
        lg: ['1.125rem', { lineHeight: '1.75rem' }],
        xl: ['1.25rem', { lineHeight: '1.75rem' }],
        '2xl': ['1.5rem', { lineHeight: '2rem' }],
        '3xl': ['1.875rem', { lineHeight: '2.25rem' }]
      }
    }
  },
  plugins: [
    require('daisyui').default({
      themes: 'all',
      root: ':root'
    }),
    daisyOpacityPlugin,
  ],
  darkMode: ['class', '[data-theme="dark"]']
}
