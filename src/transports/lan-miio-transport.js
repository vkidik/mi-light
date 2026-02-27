const miio = require("miio");

const { clamp, parseColor, rgbToInt } = require("../utils/color");
const {
  LIGHT_PROPS,
  mapPropsByNames,
  mapLightProps,
  normalizeDuration,
  unwrapMiioResult
} = require("./miio-helpers");

const STATUS_CALL_TIMEOUT_MS = 3000;
const COMMAND_CALL_TIMEOUT_MS = 3500;
const TOGGLE_POWER_READ_TIMEOUT_MS = 1200;
const STATUS_PROP_VARIANTS = [
  LIGHT_PROPS,
  ["power", "bright", "ct", "rgb"],
  ["power"]
];
const MIOT_POWER_CANDIDATES = [
  { siid: 2, piid: 1 },
  { siid: 3, piid: 1 }
];
const MIOT_BRIGHTNESS_CANDIDATES = [
  { siid: 2, piid: 3 },
  { siid: 3, piid: 3 }
];
const MIOT_TEMPERATURE_CANDIDATES = [
  { siid: 2, piid: 4 },
  { siid: 3, piid: 4 },
  { siid: 2, piid: 5 },
  { siid: 3, piid: 5 }
];
const MIOT_COLOR_CANDIDATES = [
  { siid: 2, piid: 5 },
  { siid: 3, piid: 5 },
  { siid: 2, piid: 4 },
  { siid: 3, piid: 4 }
];
const MIOT_STATUS_QUERY_VARIANTS = [
  [
    { siid: 2, piid: 1 },
    { siid: 2, piid: 3 },
    { siid: 2, piid: 4 },
    { siid: 2, piid: 5 },
    { siid: 2, piid: 2 }
  ],
  [
    { siid: 3, piid: 1 },
    { siid: 3, piid: 3 },
    { siid: 3, piid: 4 },
    { siid: 3, piid: 5 },
    { siid: 3, piid: 2 }
  ],
  [{ siid: 2, piid: 1 }],
  [{ siid: 3, piid: 1 }]
];

async function promiseWithTimeout(promise, timeoutMs, message) {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }

  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        if (typeof timer.unref === "function") {
          timer.unref();
        }
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });
}

async function callWithVariants(device, method, variants, options = {}) {
  if (typeof device.call !== "function") {
    throw new Error(`Device does not support raw call("${method}")`);
  }

  const timeoutMs = options.timeoutMs;
  let lastError = null;
  for (const params of variants) {
    try {
      const result = await promiseWithTimeout(
        device.call(method, params),
        timeoutMs,
        `miIO method "${method}" timed out`
      );
      return unwrapMiioResult(result);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`miIO method "${method}" failed: ${lastError ? lastError.message : "unknown error"}`);
}

function requireFiniteNumber(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Field "${fieldName}" must be a finite number`);
  }
  return number;
}

function isTimeoutError(error) {
  if (!error) {
    return false;
  }

  const message = error.message ? String(error.message).toLowerCase() : String(error).toLowerCase();
  return error.code === "timeout" || message.includes("timed out") || message.includes("timeout");
}

function isBusyError(error) {
  if (!error) {
    return false;
  }

  const message = error.message ? String(error.message).toLowerCase() : String(error).toLowerCase();
  return message.includes("busy");
}

function isUnsupportedMethodError(error) {
  if (!error) {
    return false;
  }

  const message = error.message ? String(error.message).toLowerCase() : String(error).toLowerCase();
  return message.includes("unknown method") || message.includes("method not found") || message.includes("not support");
}

function normalizePowerValue(value) {
  if (value === true || value === 1 || value === "on" || value === "ON") {
    return "on";
  }

  if (value === false || value === 0 || value === "off" || value === "OFF") {
    return "off";
  }

  return value;
}

function mapMiotStatus(rawPayload) {
  const raw = unwrapMiioResult(rawPayload);
  if (!Array.isArray(raw)) {
    return null;
  }

  const mapped = {};
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }

    if (item.code !== undefined && item.code !== 0) {
      continue;
    }

    const piid = Number(item.piid);
    const value = item.value;
    const numeric = Number(value);
    const hasNumeric = Number.isFinite(numeric);
    switch (piid) {
      case 1:
        mapped.power = normalizePowerValue(value);
        break;
      case 2:
        mapped.color_mode = hasNumeric ? numeric : value;
        break;
      case 3:
        if (hasNumeric && numeric >= 1 && numeric <= 100) {
          mapped.bright = numeric;
        }
        break;
      case 4:
        if (hasNumeric && numeric >= 1700 && numeric <= 6500) {
          mapped.ct = numeric;
        } else if (hasNumeric && numeric >= 0 && numeric <= 0xffffff) {
          mapped.rgb = numeric;
        }
        break;
      case 5:
        if (hasNumeric && numeric >= 0 && numeric <= 0xffffff) {
          mapped.rgb = numeric;
        } else if (hasNumeric && numeric >= 1700 && numeric <= 6500 && mapped.ct === undefined) {
          mapped.ct = numeric;
        }
        break;
      default:
        break;
    }
  }

  if (Object.keys(mapped).length === 0) {
    return null;
  }

  return mapped;
}

function normalizeModel(deviceConfig) {
  if (!deviceConfig || !deviceConfig.model) {
    return "";
  }

  return String(deviceConfig.model).trim().toLowerCase();
}

function isPhilipsStripModel(deviceConfig) {
  return normalizeModel(deviceConfig).startsWith("philips.light.strip");
}

function shouldPreferMiotFirst(deviceConfig) {
  if (deviceConfig && deviceConfig.preferMiot === true) {
    return true;
  }

  return isPhilipsStripModel(deviceConfig);
}

function reorderCandidatesByPiids(candidates, preferredPiids) {
  if (!Array.isArray(candidates) || candidates.length <= 1) {
    return candidates;
  }

  const seen = new Set();
  const ordered = [];

  for (const preferredPiid of preferredPiids) {
    for (const candidate of candidates) {
      const key = `${candidate.siid}:${candidate.piid}`;
      if (candidate.piid === preferredPiid && !seen.has(key)) {
        seen.add(key);
        ordered.push(candidate);
      }
    }
  }

  for (const candidate of candidates) {
    const key = `${candidate.siid}:${candidate.piid}`;
    if (!seen.has(key)) {
      seen.add(key);
      ordered.push(candidate);
    }
  }

  return ordered;
}

function getMiotTemperatureCandidates(deviceConfig) {
  if (isPhilipsStripModel(deviceConfig)) {
    return reorderCandidatesByPiids(MIOT_TEMPERATURE_CANDIDATES, [5, 4]);
  }

  return MIOT_TEMPERATURE_CANDIDATES;
}

function getMiotColorCandidates(deviceConfig) {
  if (isPhilipsStripModel(deviceConfig)) {
    return reorderCandidatesByPiids(MIOT_COLOR_CANDIDATES, [4, 5]);
  }

  return MIOT_COLOR_CANDIDATES;
}

function normalizeDeviceDid(device) {
  const did = device && (device.did || device.id || device.deviceId || device.miioDeviceId);
  if (did === undefined || did === null || `${did}`.trim() === "") {
    return null;
  }

  return String(did);
}

function buildMiotSetVariants(device, candidates, values) {
  const did = normalizeDeviceDid(device);
  const variants = [];

  for (const candidate of candidates) {
    for (const value of values) {
      variants.push([{ siid: candidate.siid, piid: candidate.piid, value }]);
      if (did) {
        variants.push([{ did, siid: candidate.siid, piid: candidate.piid, value }]);
      }
    }
  }

  return variants;
}

function isMiotSetResultOk(raw) {
  const result = unwrapMiioResult(raw);

  if (result === "ok") {
    return true;
  }

  if (Array.isArray(result)) {
    if (result.length === 0) {
      return false;
    }

    if (result.every((item) => typeof item === "string" && item.toLowerCase() === "ok")) {
      return true;
    }

    if (
      result.every(
        (item) =>
          item &&
          typeof item === "object" &&
          ((item.code !== undefined && item.code === 0) || (item.result !== undefined && item.result === "ok"))
      )
    ) {
      return true;
    }
  }

  if (result && typeof result === "object" && result.code !== undefined) {
    return result.code === 0;
  }

  return false;
}

class LanMiioTransport {
  constructor() {
    this.cache = new Map();
  }

  cacheKey(deviceConfig) {
    return `${deviceConfig.address}|${deviceConfig.token}`;
  }

  async getDevice(deviceConfig) {
    const key = this.cacheKey(deviceConfig);
    if (this.cache.has(key)) {
      return this.cache.get(key);
    }

    const device = await miio.device({
      address: deviceConfig.address,
      token: deviceConfig.token,
      model: deviceConfig.model
    });

    this.cache.set(key, device);
    return device;
  }

  async reconnectDevice(deviceConfig) {
    const key = this.cacheKey(deviceConfig);
    const existing = this.cache.get(key);
    if (existing && typeof existing.destroy === "function") {
      existing.destroy();
    }
    this.cache.delete(key);
    return this.getDevice(deviceConfig);
  }

  async trySetMiotProperty(device, candidates, values) {
    const variants = buildMiotSetVariants(device, candidates, values);
    let lastError = null;

    for (const params of variants) {
      try {
        const raw = await callWithVariants(device, "set_properties", [params], {
          timeoutMs: COMMAND_CALL_TIMEOUT_MS
        });

        if (isMiotSetResultOk(raw)) {
          return raw;
        }

        lastError = new Error(`miIO method "set_properties" returned non-ok result: ${JSON.stringify(raw)}`);
      } catch (error) {
        lastError = error;
        if (isBusyError(error)) {
          await sleep(150);
        }
      }
    }

    throw lastError || new Error('miIO command failed for method "set_properties"');
  }

  async executeMiotWithReconnect(deviceConfig, device, miotFn) {
    let activeDevice = device;
    try {
      return await miotFn(activeDevice);
    } catch (miotError) {
      if (isTimeoutError(miotError) || isBusyError(miotError)) {
        activeDevice = await this.reconnectDevice(deviceConfig);
        return miotFn(activeDevice);
      }

      throw miotError;
    }
  }

  async runLegacyWithMiotFallback(deviceConfig, legacyFn, miotFn, options = {}) {
    const preferMiot = Boolean(options.preferMiot && miotFn);
    let device = await this.getDevice(deviceConfig);
    let miotFirstError = null;

    if (preferMiot) {
      try {
        return await this.executeMiotWithReconnect(deviceConfig, device, miotFn);
      } catch (error) {
        miotFirstError = error;
        try {
          device = await this.reconnectDevice(deviceConfig);
        } catch {
          // Continue with current device instance when reconnect fails.
        }
      }
    }

    let legacyError = null;

    try {
      if (legacyFn) {
        return await legacyFn(device);
      }
    } catch (error) {
      legacyError = error;
    }

    if (miotFn && !preferMiot && (isTimeoutError(legacyError) || isBusyError(legacyError) || isUnsupportedMethodError(legacyError))) {
      try {
        device = await this.reconnectDevice(deviceConfig);
      } catch {
        // Continue with existing device instance if reconnect fails.
      }

      return this.executeMiotWithReconnect(deviceConfig, device, miotFn);
    }

    if (legacyError && miotFirstError) {
      throw new Error(`Both MIoT and legacy control failed: MIoT: ${miotFirstError.message}; legacy: ${legacyError.message}`);
    }

    if (legacyError) {
      throw legacyError;
    }

    if (miotFirstError) {
      throw miotFirstError;
    }

    throw new Error("miIO command failed: no available command strategy");
  }

  async tryReadStatusByVariants(device) {
    let lastError = null;

    for (const props of STATUS_PROP_VARIANTS) {
      try {
        const raw = await callWithVariants(device, "get_prop", [props], {
          timeoutMs: STATUS_CALL_TIMEOUT_MS
        });
        const mapped = mapPropsByNames(props, raw);
        if (mapped.saturation !== undefined && mapped.sat === undefined) {
          mapped.sat = mapped.saturation;
        }
        return mapped;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('miIO status read failed for method "get_prop"');
  }

  async tryReadStatusByMiot(device) {
    let lastError = null;
    for (const query of MIOT_STATUS_QUERY_VARIANTS) {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const raw = await callWithVariants(device, "get_properties", [query], {
            timeoutMs: STATUS_CALL_TIMEOUT_MS
          });
          const mapped = mapMiotStatus(raw);
          if (mapped) {
            return mapped;
          }
          break;
        } catch (error) {
          lastError = error;
          if (isBusyError(error) && attempt < 3) {
            await sleep(150 * attempt);
            continue;
          }
          break;
        }
      }
    }

    throw lastError || new Error('miIO status read failed for method "get_properties"');
  }

  async tryReadPowerQuick(device) {
    try {
      const raw = await callWithVariants(device, "get_prop", [["power"]], {
        timeoutMs: TOGGLE_POWER_READ_TIMEOUT_MS
      });
      const values = Array.isArray(raw) ? raw : [raw];
      const normalized = normalizePowerValue(values[0]);
      if (normalized === "on" || normalized === "off") {
        return normalized;
      }
    } catch {
      // Continue with MIoT power read.
    }

    let lastError = null;
    const queries = [[{ siid: 2, piid: 1 }], [{ siid: 3, piid: 1 }]];
    for (const query of queries) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const raw = await callWithVariants(device, "get_properties", [query], {
            timeoutMs: TOGGLE_POWER_READ_TIMEOUT_MS
          });
          const mapped = mapMiotStatus(raw);
          if (mapped && (mapped.power === "on" || mapped.power === "off")) {
            return mapped.power;
          }
          break;
        } catch (error) {
          lastError = error;
          if (isBusyError(error) && attempt < 2) {
            await sleep(120);
            continue;
          }
          break;
        }
      }
    }

    throw lastError || new Error("Unable to read current power state for toggle");
  }

  async status(deviceConfig) {
    const attemptRead = async (device) => {
      try {
        const raw = await callWithVariants(device, "get_prop", [LIGHT_PROPS], {
          timeoutMs: STATUS_CALL_TIMEOUT_MS
        });
        return mapLightProps(raw);
      } catch {
        // Continue with more tolerant status strategies below.
      }

      try {
        return await this.tryReadStatusByVariants(device);
      } catch {
        // Continue with MIoT status strategy below.
      }

      return this.tryReadStatusByMiot(device);
    };

    let device = await this.getDevice(deviceConfig);
    try {
      return await attemptRead(device);
    } catch (firstError) {
      if (!isTimeoutError(firstError)) {
        return {
          warning: "Fallback status returned, get_prop failed",
          error: firstError.message
        };
      }

      try {
        device = await this.reconnectDevice(deviceConfig);
        return await attemptRead(device);
      } catch (secondError) {
        return {
          warning: "Fallback status returned, get_prop failed after reconnect retry",
          error: secondError.message
        };
      }
    }
  }

  async on(deviceConfig, payload = {}) {
    const duration = normalizeDuration(payload.duration);

    await this.runLegacyWithMiotFallback(
      deviceConfig,
      async (device) => {
        if (typeof device.setPower === "function") {
          await promiseWithTimeout(
            device.setPower(true),
            COMMAND_CALL_TIMEOUT_MS,
            'miIO method "setPower" timed out'
          );
          return;
        }

        await callWithVariants(
          device,
          "set_power",
          [
            ["on", "smooth", duration],
            ["on"]
          ],
          { timeoutMs: COMMAND_CALL_TIMEOUT_MS }
        );
      },
      async (device) => {
        await this.trySetMiotProperty(device, MIOT_POWER_CANDIDATES, [true, 1]);
      },
      { preferMiot: shouldPreferMiotFirst(deviceConfig) }
    );

    return { ok: true };
  }

  async setPowerState(deviceConfig, power, payload = {}) {
    const normalized = String(power).toLowerCase();
    if (normalized === "on") {
      await this.on(deviceConfig, payload);
      return { ok: true, power: "on" };
    }

    if (normalized === "off") {
      await this.off(deviceConfig, payload);
      return { ok: true, power: "off" };
    }

    throw new Error(`Invalid target power state "${power}"`);
  }

  async prepareToggle(deviceConfig) {
    let device = await this.getDevice(deviceConfig);

    try {
      const currentPower = await this.tryReadPowerQuick(device);
      return currentPower === "on" ? "off" : "on";
    } catch (firstError) {
      if (!isTimeoutError(firstError) && !isBusyError(firstError)) {
        throw firstError;
      }

      device = await this.reconnectDevice(deviceConfig);
      const currentPower = await this.tryReadPowerQuick(device);
      return currentPower === "on" ? "off" : "on";
    }
  }

  async off(deviceConfig, payload = {}) {
    const duration = normalizeDuration(payload.duration);

    await this.runLegacyWithMiotFallback(
      deviceConfig,
      async (device) => {
        if (typeof device.setPower === "function") {
          await promiseWithTimeout(
            device.setPower(false),
            COMMAND_CALL_TIMEOUT_MS,
            'miIO method "setPower" timed out'
          );
          return;
        }

        await callWithVariants(
          device,
          "set_power",
          [
            ["off", "smooth", duration],
            ["off"]
          ],
          { timeoutMs: COMMAND_CALL_TIMEOUT_MS }
        );
      },
      async (device) => {
        await this.trySetMiotProperty(device, MIOT_POWER_CANDIDATES, [false, 0]);
      },
      { preferMiot: shouldPreferMiotFirst(deviceConfig) }
    );

    return { ok: true };
  }

  async toggle(deviceConfig) {
    const nextPower = await this.prepareToggle(deviceConfig);
    return this.setPowerState(deviceConfig, nextPower, {});
  }

  async brightness(deviceConfig, payload) {
    const value = clamp(requireFiniteNumber(payload.value, "value"), 0, 100);
    const duration = normalizeDuration(payload.duration);

    if (value === 0) {
      return this.off(deviceConfig, payload);
    }

    await this.runLegacyWithMiotFallback(
      deviceConfig,
      async (device) => {
        if (typeof device.setBrightness === "function") {
          await promiseWithTimeout(
            device.setBrightness(value),
            COMMAND_CALL_TIMEOUT_MS,
            'miIO method "setBrightness" timed out'
          );
          return;
        }

        await callWithVariants(
          device,
          "set_bright",
          [
            [value, "smooth", duration],
            [value]
          ],
          { timeoutMs: COMMAND_CALL_TIMEOUT_MS }
        );
      },
      async (device) => {
        await this.trySetMiotProperty(device, MIOT_BRIGHTNESS_CANDIDATES, [value]);
      },
      { preferMiot: shouldPreferMiotFirst(deviceConfig) }
    );

    return { ok: true };
  }

  async temperature(deviceConfig, payload) {
    const value = clamp(requireFiniteNumber(payload.value, "value"), 1700, 6500);
    const duration = normalizeDuration(payload.duration);

    await this.runLegacyWithMiotFallback(
      deviceConfig,
      async (device) => {
        if (typeof device.setColorTemperature === "function") {
          await promiseWithTimeout(
            device.setColorTemperature(value),
            COMMAND_CALL_TIMEOUT_MS,
            'miIO method "setColorTemperature" timed out'
          );
          return;
        }

        await callWithVariants(
          device,
          "set_ct_abx",
          [
            [value, "smooth", duration],
            [value]
          ],
          { timeoutMs: COMMAND_CALL_TIMEOUT_MS }
        );
      },
      async (device) => {
        await this.trySetMiotProperty(device, getMiotTemperatureCandidates(deviceConfig), [value]);
      },
      { preferMiot: shouldPreferMiotFirst(deviceConfig) }
    );

    return { ok: true };
  }

  async color(deviceConfig, payload) {
    const duration = normalizeDuration(payload.duration);
    const rgb = parseColor(payload.color);
    const rgbInt = rgbToInt(rgb);

    await this.runLegacyWithMiotFallback(
      deviceConfig,
      async (device) => {
        await callWithVariants(
          device,
          "set_rgb",
          [
            [rgbInt, "smooth", duration],
            [rgbInt]
          ],
          { timeoutMs: COMMAND_CALL_TIMEOUT_MS }
        );
      },
      async (device) => {
        await this.trySetMiotProperty(device, getMiotColorCandidates(deviceConfig), [rgbInt]);
      },
      { preferMiot: shouldPreferMiotFirst(deviceConfig) }
    );

    return {
      ok: true,
      rgb
    };
  }

  async execute(deviceConfig, command, payload = {}) {
    switch (command) {
      case "status":
        return this.status(deviceConfig);
      case "on":
        return this.on(deviceConfig, payload);
      case "off":
        return this.off(deviceConfig, payload);
      case "toggle":
        return this.toggle(deviceConfig, payload);
      case "brightness":
        return this.brightness(deviceConfig, payload);
      case "temperature":
        return this.temperature(deviceConfig, payload);
      case "color":
        return this.color(deviceConfig, payload);
      default:
        throw new Error(`Unsupported command for LAN transport: "${command}"`);
    }
  }

  async disconnectAll() {
    for (const device of this.cache.values()) {
      if (device && typeof device.destroy === "function") {
        device.destroy();
      }
    }
    this.cache.clear();
  }
}

module.exports = {
  LanMiioTransport
};
