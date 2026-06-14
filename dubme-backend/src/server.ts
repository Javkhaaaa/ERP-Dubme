import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { sweepStaleCache } from "./pipeline.js";

const app = Fastify({
  logger: {
    level: config.nodeEnv === "production" ? "info" : "debug",
  },
});

await app.register(cors, {
  origin: config.webOrigin,
  credentials: true,
});

await app.register(registerJobRoutes, { prefix: "/api" });

app.get("/health", async () => ({ ok: true, env: config.nodeEnv }));

// Reclaim disk from abandoned EDITING jobs: sweep the local video cache on
// startup and hourly thereafter.
void sweepStaleCache();
setInterval(() => void sweepStaleCache(), 60 * 60 * 1000);

try {
  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(`dubme api listening on :${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
