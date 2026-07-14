/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      colors: {
        surface: {
          0: '#070b0f',  // deepest background
          1: '#0d1117',  // page background
          2: '#161b22',  // card background
          3: '#21262d',  // elevated card / input bg
          4: '#30363d',  // borders / separators
        },
        accent: {
          cyan: '#00d4ff',
          green: '#00ff9d',
          amber: '#ffb700',
          red: '#ff4d4d',
        },
        text: {
          primary: '#e6edf3',
          secondary: '#8b949e',
          muted: '#484f58',
        },
      },
      boxShadow: {
        glow: '0 0 12px 0 rgba(0, 212, 255, 0.15)',
        'glow-green': '0 0 12px 0 rgba(0, 255, 157, 0.15)',
      },
    },
  },
  plugins: [],
}
