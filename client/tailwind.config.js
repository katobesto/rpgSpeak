/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // CSS variable-driven accent system
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          muted: 'var(--accent-muted)',
        },
        surface: {
          0: 'var(--surface-0)',
          1: 'var(--surface-1)',
          2: 'var(--surface-2)',
          3: 'var(--surface-3)',
        },
        border: 'var(--border)',
        'text-primary': 'var(--text-primary)',
        'text-secondary': 'var(--text-secondary)',
        'text-muted': 'var(--text-muted)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      animation: {
        'fade-in': 'fadeIn 0.15s ease-in-out',
        'slide-up': 'slideUp 0.2s ease-out',
        'pulse-dot': 'pulseDot 1.4s ease-in-out infinite',
        typing: 'typing 1.2s steps(3, end) infinite',
        'msg-highlight': 'msgHighlight 2s ease-out forwards',
        'think-dot': 'thinkDot 1.2s ease-in-out infinite',
        'brain-spin': 'brainSpin 2.5s linear infinite',
        'think-scan': 'thinkScan 2s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: { from: { opacity: '0' }, to: { opacity: '1' } },
        slideUp: { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        msgHighlight: {
          '0%':   { backgroundColor: 'rgba(139,92,246,0.18)' },
          '60%':  { backgroundColor: 'rgba(139,92,246,0.10)' },
          '100%': { backgroundColor: 'transparent' },
        },
        pulseDot: {
          '0%, 80%, 100%': { transform: 'scale(0)', opacity: '0.5' },
          '40%': { transform: 'scale(1)', opacity: '1' },
        },
        thinkDot: {
          '0%, 70%, 100%': { transform: 'translateY(0)', opacity: '0.4' },
          '35%': { transform: 'translateY(-4px)', opacity: '1' },
        },
        brainSpin: {
          '0%':   { transform: 'rotate(0deg) scale(1)' },
          '25%':  { transform: 'rotate(90deg) scale(1.1)' },
          '50%':  { transform: 'rotate(180deg) scale(1)' },
          '75%':  { transform: 'rotate(270deg) scale(1.1)' },
          '100%': { transform: 'rotate(360deg) scale(1)' },
        },
        thinkScan: {
          '0%, 100%': { opacity: '0.5', transform: 'scaleX(0.7)' },
          '50%':      { opacity: '1',   transform: 'scaleX(1)' },
        },
        typing: {
          '0%': { content: '.' },
          '33%': { content: '..' },
          '66%': { content: '...' },
        },
      },
    },
  },
  plugins: [],
};
