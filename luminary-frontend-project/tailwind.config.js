/**
 * Luminary Health design tokens.
 *
 * Ocean Flow 2 / Clinical Glass: porcelain surfaces, pale blue structure, deep
 * navy text, and a controlled ocean-blue accent, with translucent layers where
 * a surface genuinely floats above another. Component code stays on named
 * tokens so the product migrates as one visual system instead of scattered
 * swatches. `npm run verify:tokens` rejects values outside these scales.
 *
 * Legacy step names (2xs…2xl, rounded-sm/md/lg) are kept and re-valued so
 * existing screens move with the system; the semantic names below them are
 * what new and migrated components should reach for.
 */
export default {
  content: [
    './index.html',
    './src/**/*.{js,jsx,ts,tsx}',
    './public/**/*.html',
  ],
  theme: {
    fontFamily: {
      sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Inter', 'system-ui', 'sans-serif'],
      mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
    },
    fontSize: {
      // Legacy steps. Body and table text keep their size so dense screens
      // stay dense; the smallest step and the heading steps move toward the
      // Clinical Glass scale.
      '2xs': '10px',
      xs: '11px',
      sm: '12px',
      base: '13px',
      md: '14px',
      lg: '17px',
      xl: '20px',
      '2xl': '28px',
      // Clinical Glass semantic scale. Body text is `copy`, not `body`:
      // `body` is already a text colour, and Tailwind would emit both rules
      // for `text-body`, silently resizing every muted paragraph.
      micro: '11px',
      caption: '12px',
      small: '13px',
      copy: '14px',
      'copy-lg': '15px',
      control: '14px',
      section: '17px',
      heading: '20px',
      page: '28px',
      'page-lg': '32px',
      metric: '28px',
      display: '36px',
    },
    borderRadius: {
      none: '0',
      xs: '6px',
      sm: '8px',
      DEFAULT: '10px',
      md: '12px',
      lg: '14px',
      xl: '16px',
      '2xl': '20px',
      '3xl': '24px',
      '4xl': '28px',
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

        canvas: '#f5f8fc',
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
      boxShadow: {
        // Blue-tinted, low, and layered: depth you perceive without noticing.
        hairline: '0 1px 2px rgba(20,40,70,0.03)',
        card: 'inset 0 1px 0 rgba(255,255,255,0.65), 0 1px 2px rgba(20,40,70,0.03), 0 8px 24px -18px rgba(20,60,100,0.14)',
        raised: 'inset 0 1px 0 rgba(255,255,255,0.65), 0 1px 2px rgba(20,40,70,0.03), 0 12px 32px rgba(20,60,100,0.08)',
        float: 'inset 0 1px 0 rgba(255,255,255,0.70), 0 2px 6px rgba(20,40,70,0.04), 0 22px 48px -12px rgba(20,60,100,0.18)',
        modal: 'inset 0 1px 0 rgba(255,255,255,0.75), 0 2px 8px rgba(20,40,70,0.05), 0 32px 72px -16px rgba(20,60,100,0.26)',
        control: 'inset 0 1px 0 rgba(255,255,255,0.55), 0 1px 2px rgba(20,40,70,0.06)',
        focus: '0 0 0 3px rgba(33,136,245,0.10)',
        'nav-active': 'inset 0 0 0 1px rgba(7,94,184,0.06), inset 0 1px 0 rgba(255,255,255,0.50)',
      },
      backdropBlur: {
        subtle: '18px',
        glass: '22px',
        elevated: '28px',
      },
      backdropSaturate: {
        subtle: '1.25',
        glass: '1.35',
        elevated: '1.45',
      },
      height: {
        'control-sm': '32px',
        control: '38px',
        'control-lg': '42px',
        nav: '38px',
      },
      minHeight: {
        'control-sm': '32px',
        control: '38px',
        'control-lg': '42px',
      },
      width: {
        'control-sm': '32px',
        control: '38px',
      },
      transitionDuration: {
        DEFAULT: '180ms',
        instant: '80ms',
        fast: '120ms',
        normal: '180ms',
        slow: '240ms',
      },
      transitionTimingFunction: {
        DEFAULT: 'cubic-bezier(.2,.8,.2,1)',
        fluid: 'cubic-bezier(.2,.8,.2,1)',
        spring: 'cubic-bezier(.34,1.3,.64,1)',
      },
      letterSpacing: {
        heading: '-0.015em',
        title: '-0.025em',
      },
      zIndex: {
        header: '20',
        backdrop: '30',
        menu: '40',
        modal: '50',
        palette: '55',
        toast: '60',
      },
      keyframes: {
        'lh-modal-in': {
          '0%': { opacity: '0', transform: 'translateY(4px) scale(.975)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'lh-pop-in': {
          '0%': { opacity: '0', transform: 'translateY(-2px) scale(.98)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'lh-fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'lh-toast-in': {
          '0%': { opacity: '0', transform: 'translate(-50%, 6px) scale(.98)' },
          '100%': { opacity: '1', transform: 'translate(-50%, 0) scale(1)' },
        },
        'lh-shimmer': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'modal-in': 'lh-modal-in 200ms cubic-bezier(.2,.8,.2,1) both',
        'pop-in': 'lh-pop-in 160ms cubic-bezier(.2,.8,.2,1) both',
        'fade-in': 'lh-fade-in 180ms cubic-bezier(.2,.8,.2,1) both',
        'toast-in': 'lh-toast-in 220ms cubic-bezier(.2,.8,.2,1) both',
        shimmer: 'lh-shimmer 1.6s linear infinite',
      },
    },
  },
  plugins: [],
}
