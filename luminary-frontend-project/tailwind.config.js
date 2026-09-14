/**
 * Luminary Health design tokens.
 *
 * Ocean Flow: porcelain surfaces, pale blue structure, deep navy text, and a
 * controlled ocean-blue accent. Component code stays on named tokens so the
 * product can migrate as one visual system instead of scattered swatches.
 */
export default {
  content: [
    './index.html',
    './src/**/*.{js,jsx,ts,tsx}',
    './public/**/*.html',
  ],
  theme: {
    fontSize: {
      '2xs': '9px',
      xs: '11px',
      sm: '12px',
      base: '13px',
      md: '14px',
      lg: '16px',
      xl: '19px',
      '2xl': '23px',
    },
    borderRadius: {
      none: '0',
      sm: '5px',
      DEFAULT: '7px',
      md: '10px',
      lg: '13px',
      full: '9999px',
    },
    extend: {
      colors: {
        ink: {
          DEFAULT: '#10233f',
          hover: '#183257',
          soft: '#2b405d',
          on: '#f7fafe',
        },
        body: '#415571',
        muted: '#5f7085',
        faint: '#5f7085',

        canvas: '#f7fafe',
        panel: '#ffffff',
        surface: '#f2f7fd',
        wash: '#eaf4ff',

        line: '#dfeaf6',
        edge: '#cbdced',
        'edge-strong': '#adc7e0',

        brand: {
          DEFAULT: '#075eb8',
          deep: '#075eb8',
          bright: '#56a8ff',
          edge: '#8fc7ff',
          soft: '#eff7ff',
          vivid: '#2188f5',
        },
        teal: {
          DEFAULT: '#0e8fa8',
          deep: '#086b80',
          soft: '#e8f8fb',
          line: '#b7eaf2',
        },

        shell: {
          DEFAULT: '#ffffff',
          on: '#10233f',
          text: '#5f7085',
          muted: '#66788d',
          accent: '#075eb8',
          bright: '#0872de',
        },

        success: {
          DEFAULT: '#1f6f52',
          deep: '#1f6f52',
          bright: '#37a77b',
          soft: '#e9f7f1',
          line: '#bbe5d4',
          edge: '#88d1b4',
        },
        warning: {
          DEFAULT: '#8a5b0c',
          deep: '#7f510c',
          bright: '#d99a35',
          soft: '#fff7e8',
          wash: '#faecd0',
          line: '#efd6a8',
          edge: '#dbb56f',
        },
        danger: {
          DEFAULT: '#b94350',
          deep: '#96323d',
          bright: '#d75c67',
          soft: '#fff0f2',
          line: '#f4c9cf',
          edge: '#e9a7af',
          strong: '#dc8791',
        },
      },
    },
  },
  plugins: [],
}
