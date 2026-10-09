// Loads .env if present. Imported first so every other module sees the values.
try { process.loadEnvFile(); } catch { /* no .env file: use real environment */ }
