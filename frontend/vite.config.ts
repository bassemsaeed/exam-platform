import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Minimal client: no Tailwind, no router. Backend contract lives in src/lib/.
export default defineConfig({
  plugins: [react()],
})
