import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/package-experiment-schema.ts',
  out: './src/db/package-experiment-migrations',
  dialect: 'sqlite',
})
