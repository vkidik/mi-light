const express = require("express");

const { loadConfig } = require("./config");
const { LightService } = require("./light-service");
const { LanMiioTransport } = require("./transports/lan-miio-transport");
const { CloudMiHomeTransport } = require("./transports/cloud-mihome-transport");

function parseFiniteNumber(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Field "${fieldName}" must be a number`);
  }
  return number;
}

function withAsync(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function requireBodyField(body, fieldName) {
  if (!body || body[fieldName] === undefined || body[fieldName] === null) {
    throw new Error(`Request body must contain "${fieldName}"`);
  }
}

async function main() {
  const config = loadConfig();
  const lanTransport = new LanMiioTransport();
  const cloudTransport = config.cloud.enabled ? new CloudMiHomeTransport(config.cloud) : null;
  const lightService = new LightService(config, { lanTransport, cloudTransport });

  const app = express();
  app.use(express.json({ limit: "256kb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/v1/groups", (_req, res) => {
    res.json({ groups: lightService.listGroups() });
  });

  app.get(
    "/api/v1/light/status/:target?",
    withAsync(async (req, res) => {
      const result = await lightService.execute(req.params.target, "status");
      res.json(result);
    })
  );

  app.post(
    "/api/v1/light/on/:target?",
    withAsync(async (req, res) => {
      const result = await lightService.execute(req.params.target, "on", req.body || {});
      res.json(result);
    })
  );

  app.post(
    "/api/v1/light/off/:target?",
    withAsync(async (req, res) => {
      const result = await lightService.execute(req.params.target, "off", req.body || {});
      res.json(result);
    })
  );

  app.post(
    "/api/v1/light/toggle/:target?",
    withAsync(async (req, res) => {
      const result = await lightService.execute(req.params.target, "toggle", req.body || {});
      res.json(result);
    })
  );

  app.post(
    "/api/v1/light/brightness/:target?",
    withAsync(async (req, res) => {
      requireBodyField(req.body, "value");
      const value = parseFiniteNumber(req.body.value, "value");
      if (value < 0 || value > 100) {
        throw new Error('Field "value" for brightness must be in range 0..100');
      }

      const result = await lightService.execute(req.params.target, "brightness", {
        value,
        duration: req.body.duration
      });
      res.json(result);
    })
  );

  app.post(
    "/api/v1/light/temperature/:target?",
    withAsync(async (req, res) => {
      requireBodyField(req.body, "value");
      const value = parseFiniteNumber(req.body.value, "value");
      if (value < 1700 || value > 6500) {
        throw new Error('Field "value" for temperature must be in range 1700..6500');
      }

      const result = await lightService.execute(req.params.target, "temperature", {
        value,
        duration: req.body.duration
      });
      res.json(result);
    })
  );

  app.post(
    "/api/v1/light/color/:target?",
    withAsync(async (req, res) => {
      requireBodyField(req.body, "color");
      const result = await lightService.execute(req.params.target, "color", {
        color: req.body.color,
        duration: req.body.duration
      });
      res.json(result);
    })
  );

  app.post(
    "/api/v1/light/state/:target?",
    withAsync(async (req, res) => {
      if (!req.body || typeof req.body !== "object") {
        throw new Error("Request body must be a JSON object");
      }

      const result = await lightService.applyState(req.params.target, req.body);
      res.json(result);
    })
  );

  app.use((error, _req, res, _next) => {
    const message = error && error.message ? error.message : "Unhandled server error";
    res.status(400).json({ ok: false, error: message });
  });

  const server = app.listen(config.port, () => {
    process.stdout.write(
      `mi-light-controller started on http://localhost:${config.port}\nConfig: ${config.configPath}\n`
    );
  });

  let shuttingDown = false;

  async function closeServerWithDeadline(deadlineMs = 4000) {
    if (typeof server.closeIdleConnections === "function") {
      server.closeIdleConnections();
    }

    await Promise.race([
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
      new Promise((resolve) => {
        setTimeout(() => {
          if (typeof server.closeAllConnections === "function") {
            server.closeAllConnections();
          }
          resolve();
        }, deadlineMs);
      })
    ]);
  }

  async function shutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    process.stdout.write(`\nReceived ${signal}, shutting down...\n`);

    const forceExitTimer = setTimeout(() => {
      process.stderr.write("Shutdown timeout reached, forcing process exit.\n");
      process.exit(1);
    }, 10000);
    forceExitTimer.unref();

    let exitCode = 0;
    try {
      await closeServerWithDeadline();
    } catch (error) {
      exitCode = 1;
      process.stderr.write(`HTTP server shutdown error: ${error.message}\n`);
    }

    try {
      await lightService.shutdown();
    } catch (error) {
      exitCode = 1;
      process.stderr.write(`Transport shutdown error: ${error.message}\n`);
    }

    clearTimeout(forceExitTimer);
    process.exit(exitCode);
  }

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
