import { buildApp } from "./app";
import { configWarnings, loadConfig, loadDotEnv } from "./config";

loadDotEnv();

const config = loadConfig();
const { app } = await buildApp({ config, startWorker: true, logger: true });

try {
  await app.listen({ port: config.port, host: config.host });
  const ttlSeconds = Math.round(config.ttlMs / 1000);
  app.log.info(
    {
      ttlSeconds,
      ttlSource: config.ttlSource,
      host: config.host,
      port: config.port,
      production: config.production,
      databasePath: config.databasePath,
      mailProvider: config.mail.providerUrl,
      worker: config.worker.enabled,
      ops: config.opsEnabled,
      opsToken: config.opsToken !== null,
      trustProxy: config.trustProxy,
      web: config.webDistPath ?? false,
    },
    "PAS API gotowe",
  );
  // Osobna, czytelna linia: tryb testowy prowadzącego wymaga TTL ok. 2 minut.
  app.log.info(
    `Efektywny TTL rezerwacji: ${ttlSeconds} s (${(ttlSeconds / 60).toFixed(1)} min), źródło: ${config.ttlSource}`,
  );
  for (const warning of configWarnings(config)) {
    app.log.warn(warning);
  }
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

const SHUTDOWN_TIMEOUT_MS = 10_000;

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Zamykam API…");
  // Wiszący request nie może trzymać procesu w nieskończoność.
  setTimeout(() => {
    app.log.warn("Zamykanie trwa za długo — kończę proces.");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  await app.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
