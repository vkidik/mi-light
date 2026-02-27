const fs = require("node:fs");
const path = require("node:path");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function loadJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in config file "${filePath}": ${error.message}`);
  }
}

function validateAndNormalizeConfig(config, configPath) {
  assert(config && typeof config === "object", "Config must be a JSON object");
  assert(Array.isArray(config.devices), 'Config must contain "devices" array');
  assert(config.devices.length > 0, 'Config "devices" array must not be empty');
  const configDir = path.dirname(configPath);

  const cloud = {
    enabled: Boolean(config.cloud && config.cloud.enabled),
    username: config.cloud ? config.cloud.username : undefined,
    password: config.cloud ? config.cloud.password : undefined,
    country: config.cloud && config.cloud.country ? config.cloud.country : "cn",
    interactiveAuth: config.cloud && config.cloud.interactiveAuth !== undefined
      ? Boolean(config.cloud.interactiveAuth)
      : false,
    sessionFile: config.cloud && typeof config.cloud.sessionFile === "string" && config.cloud.sessionFile.trim() !== ""
      ? path.resolve(configDir, config.cloud.sessionFile.trim())
      : path.resolve(configDir, ".mi-cloud-session.json"),
    captchaImagePath: config.cloud && typeof config.cloud.captchaImagePath === "string" && config.cloud.captchaImagePath.trim() !== ""
      ? path.resolve(configDir, config.cloud.captchaImagePath.trim())
      : path.resolve(process.cwd(), "xiaomi-captcha.jpg")
  };

  const names = new Set();
  const devices = config.devices.map((device, index) => {
    assert(device && typeof device === "object", `Device #${index + 1} must be an object`);
    assert(typeof device.name === "string" && device.name.trim() !== "", `Device #${index + 1} must have non-empty "name"`);

    const name = device.name.trim();
    assert(!names.has(name), `Duplicate device name: "${name}"`);
    names.add(name);

    const transport = device.transport || "lan";
    assert(transport === "lan" || transport === "cloud", `Device "${name}": "transport" must be "lan" or "cloud"`);

    if (transport === "lan") {
      assert(typeof device.address === "string" && device.address.trim() !== "", `Device "${name}" (lan) requires "address"`);
      assert(typeof device.token === "string" && device.token.trim() !== "", `Device "${name}" (lan) requires "token"`);
    }

    if (transport === "cloud") {
      assert(device.id !== undefined && device.id !== null && `${device.id}`.trim() !== "", `Device "${name}" (cloud) requires "id"`);
      if (cloud.enabled) {
        assert(typeof cloud.username === "string" && cloud.username, 'Cloud is enabled but "cloud.username" is missing');
        assert(typeof cloud.password === "string" && cloud.password, 'Cloud is enabled but "cloud.password" is missing');
      }
    }

    return {
      ...device,
      name,
      transport
    };
  });

  const hasCloudDevices = devices.some((device) => device.transport === "cloud");
  if (hasCloudDevices) {
    assert(cloud.enabled, 'At least one device uses "cloud" transport, set "cloud.enabled": true');
    assert(typeof cloud.username === "string" && cloud.username, 'Cloud transport requires "cloud.username"');
    assert(typeof cloud.password === "string" && cloud.password, 'Cloud transport requires "cloud.password"');
  }

  const groups = config.groups && typeof config.groups === "object" ? config.groups : {};
  for (const [groupName, members] of Object.entries(groups)) {
    assert(Array.isArray(members), `Group "${groupName}" must be an array`);
    for (const member of members) {
      assert(typeof member === "string" && names.has(member), `Group "${groupName}" references unknown device "${member}"`);
    }
  }

  const port = Number(process.env.PORT || config.port || 3000);
  assert(Number.isInteger(port) && port > 0 && port <= 65535, `"port" must be an integer in range 1..65535`);

  const requestTimeoutMs = Number(process.env.MI_LIGHT_REQUEST_TIMEOUT_MS || config.requestTimeoutMs || 12000);
  assert(
    Number.isInteger(requestTimeoutMs) && requestTimeoutMs >= 1000 && requestTimeoutMs <= 120000,
    '"requestTimeoutMs" must be an integer in range 1000..120000'
  );

  return {
    port,
    requestTimeoutMs,
    cloud,
    devices,
    groups,
    configPath
  };
}

function loadConfig() {
  const configPath = process.env.MI_LIGHT_CONFIG
    ? path.resolve(process.env.MI_LIGHT_CONFIG)
    : path.resolve(process.cwd(), "config/lights.json");

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Config file "${configPath}" not found. Copy config/lights.example.json to config/lights.json and fill your devices`
    );
  }

  const json = loadJsonFile(configPath);
  return validateAndNormalizeConfig(json, configPath);
}

module.exports = {
  loadConfig
};
