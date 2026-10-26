import { buildApp } from "./app";
import { loadConfig, loadDotEnv } from "./config";

loadDotEnv();

const config = loadConfig();
const { app } = await buildApp({ config, startWorker: true, logger: true });

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    {
      ttlSeconds: Math.round(config.ttlMs / 1000),
      databasePath: config.databasePath,
      mailProvider: config.mail.providerUrl,
      worker: config.worker.enabled,
      ops: config.opsEnabled,
    },
    "PAS API gotowe",
  );
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Zamykam API…");
  await app.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
