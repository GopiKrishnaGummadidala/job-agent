for (const p of ['.env', '../../.env']) {
  try {
    process.loadEnvFile(p);
  } catch {
    // optional file
  }
}

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 4000),
  databaseUrl: env.DATABASE_URL ?? 'postgres://jobagent_app:app_dev_password@localhost:5433/jobagent',
  migrateUrl: env.MIGRATE_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/jobagent',
  appDbPassword: env.APP_DB_PASSWORD ?? 'app_dev_password',
  webOrigin: env.WEB_ORIGIN ?? 'http://localhost:5173',
  cookieSecure: env.COOKIE_SECURE === 'true',
  scheduler: env.SCHEDULER !== 'off',
  // Browser assist opens a visible browser on the machine running the API, so it is for local use only.
  assist: env.ASSIST === 'local',
  ollamaBaseUrl: env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
  openaiBaseUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  openaiApiKey: env.OPENAI_API_KEY ?? '',
  openaiPriceIn: Number(env.OPENAI_PRICE_IN ?? 0),
  openaiPriceOut: Number(env.OPENAI_PRICE_OUT ?? 0),
};
