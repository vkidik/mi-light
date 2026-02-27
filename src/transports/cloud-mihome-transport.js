const { clamp, parseColor, rgbToInt } = require("../utils/color");
const {
  LIGHT_PROPS,
  mapLightProps,
  normalizeDuration,
  unwrapMiioResult
} = require("./miio-helpers");
const {
  applySession,
  loadSessionFromFile,
  loginWithChallenges,
  saveSessionToFile
} = require("./micloud-auth");

let mihome = null;

function getMiHomeLibrary() {
  if (!mihome) {
    mihome = require("node-mihome");
  }
  return mihome;
}

function requireFiniteNumber(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Field "${fieldName}" must be a finite number`);
  }
  return number;
}

function hasDefinedValue(object) {
  return Object.values(object).some((value) => value !== undefined && value !== null);
}

function isCloudVirtualLightGroup(deviceConfig) {
  const model = deviceConfig && deviceConfig.model ? String(deviceConfig.model) : "";
  return model.startsWith("mijia.light.group");
}

function cloudGroupControlError(deviceConfig) {
  return `Cloud virtual light group "${deviceConfig.name}" is not reliable for direct control. Use local API group target with member devices (for example: "bedroom").`;
}

class CloudMiHomeTransport {
  constructor(cloudConfig = {}) {
    this.cloudConfig = cloudConfig;
    this.initialized = false;
    this.initPromise = null;
    this.options = {
      country: cloudConfig.country || "cn"
    };
    this.sessionFile = cloudConfig.sessionFile;
    this.captchaImagePath = cloudConfig.captchaImagePath;
    this.interactiveAuth = cloudConfig.interactiveAuth !== false;
  }

  async init() {
    if (this.initialized) {
      return;
    }

    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.initInternal();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  async initInternal() {
    if (this.initialized) {
      return;
    }

    const username = this.cloudConfig.username;
    const password = this.cloudConfig.password;
    if (!username || !password) {
      throw new Error('Cloud transport requires "cloud.username" and "cloud.password" in config');
    }

    const miHomeApi = getMiHomeLibrary();
    const protocol = miHomeApi.miCloudProtocol;

    const cachedSession = this.sessionFile ? loadSessionFromFile(this.sessionFile) : null;
    if (cachedSession) {
      applySession(protocol, cachedSession, { username });
      if (await this.validateSession()) {
        this.initialized = true;
        return;
      }
      this.clearProtocolSession(protocol);
    }

    try {
      await protocol.login(username, password);
      if (await this.validateSession()) {
        this.persistCurrentSession(username);
        this.initialized = true;
        return;
      }
      this.clearProtocolSession(protocol);
    } catch (error) {
      if (!this.isStep2Error(error)) {
        throw error;
      }
      this.clearProtocolSession(protocol);
    }

    const session = await loginWithChallenges(protocol, {
      username,
      password,
      allowInteractive: this.interactiveAuth,
      captchaImagePath: this.captchaImagePath,
      logger: (message) => {
        process.stdout.write(`[CloudAuth] ${message}\n`);
      }
    });

    if (this.sessionFile) {
      saveSessionToFile(this.sessionFile, session);
    }
    this.initialized = true;
  }

  isStep2Error(error) {
    const message = error && error.message ? error.message : String(error);
    return message.includes("Login step 2 failed");
  }

  async validateSession() {
    const miHomeApi = getMiHomeLibrary();
    try {
      const devices = await miHomeApi.miCloudProtocol.getDevices([], {
        country: this.options.country
      });
      return Array.isArray(devices);
    } catch {
      return false;
    }
  }

  persistCurrentSession(username) {
    if (!this.sessionFile) {
      return;
    }

    const protocol = getMiHomeLibrary().miCloudProtocol;
    saveSessionToFile(this.sessionFile, {
      username,
      ssecurity: protocol.ssecurity,
      userId: protocol.userId,
      serviceToken: protocol.serviceToken,
      createdAt: new Date().toISOString()
    });
  }

  clearProtocolSession(protocol) {
    try {
      if (protocol.isLoggedIn) {
        protocol.logout();
      }
    } catch {
      // Fallback to raw cleanup below.
    }

    protocol.username = null;
    protocol.password = null;
    protocol.ssecurity = null;
    protocol.userId = null;
    protocol.serviceToken = null;
  }

  async miioCall(deviceConfig, method, params) {
    await this.init();
    const miHomeApi = getMiHomeLibrary();
    const options = {
      country: deviceConfig.country || this.options.country
    };

    const response = await miHomeApi.miCloudProtocol.miioCall(
      deviceConfig.id,
      method,
      params,
      options
    );

    return unwrapMiioResult(response);
  }

  async status(deviceConfig) {
    try {
      const raw = await this.miioCall(deviceConfig, "get_prop", LIGHT_PROPS);
      const mapped = mapLightProps(raw);
      if (hasDefinedValue(mapped)) {
        return mapped;
      }

      return {
        warning: "Cloud status is empty for this device model",
        raw
      };
    } catch (error) {
      return {
        warning: "Fallback status returned, cloud get_prop failed",
        error: error.message
      };
    }
  }

  async on(deviceConfig, payload = {}) {
    if (isCloudVirtualLightGroup(deviceConfig)) {
      throw new Error(cloudGroupControlError(deviceConfig));
    }

    const duration = normalizeDuration(payload.duration);
    await this.miioCall(deviceConfig, "set_power", ["on", "smooth", duration]);
    return { ok: true };
  }

  async off(deviceConfig, payload = {}) {
    if (isCloudVirtualLightGroup(deviceConfig)) {
      throw new Error(cloudGroupControlError(deviceConfig));
    }

    const duration = normalizeDuration(payload.duration);
    await this.miioCall(deviceConfig, "set_power", ["off", "smooth", duration]);
    return { ok: true };
  }

  async toggle(deviceConfig) {
    if (isCloudVirtualLightGroup(deviceConfig)) {
      throw new Error(cloudGroupControlError(deviceConfig));
    }

    await this.miioCall(deviceConfig, "toggle", []);
    return { ok: true };
  }

  async brightness(deviceConfig, payload) {
    if (isCloudVirtualLightGroup(deviceConfig)) {
      throw new Error(cloudGroupControlError(deviceConfig));
    }

    const value = clamp(requireFiniteNumber(payload.value, "value"), 0, 100);
    const duration = normalizeDuration(payload.duration);

    if (value === 0) {
      return this.off(deviceConfig, payload);
    }

    await this.miioCall(deviceConfig, "set_bright", [value, "smooth", duration]);
    return { ok: true };
  }

  async temperature(deviceConfig, payload) {
    if (isCloudVirtualLightGroup(deviceConfig)) {
      throw new Error(cloudGroupControlError(deviceConfig));
    }

    const value = clamp(requireFiniteNumber(payload.value, "value"), 1700, 6500);
    const duration = normalizeDuration(payload.duration);
    await this.miioCall(deviceConfig, "set_ct_abx", [value, "smooth", duration]);
    return { ok: true };
  }

  async color(deviceConfig, payload) {
    if (isCloudVirtualLightGroup(deviceConfig)) {
      throw new Error(cloudGroupControlError(deviceConfig));
    }

    const duration = normalizeDuration(payload.duration);
    const rgb = parseColor(payload.color);
    const rgbInt = rgbToInt(rgb);
    await this.miioCall(deviceConfig, "set_rgb", [rgbInt, "smooth", duration]);
    return { ok: true, rgb };
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
        return this.toggle(deviceConfig);
      case "brightness":
        return this.brightness(deviceConfig, payload);
      case "temperature":
        return this.temperature(deviceConfig, payload);
      case "color":
        return this.color(deviceConfig, payload);
      default:
        throw new Error(`Unsupported command for cloud transport: "${command}"`);
    }
  }

  async disconnectAll() {
    this.initialized = false;
    this.initPromise = null;

    const miHomeApi = getMiHomeLibrary();
    if (!miHomeApi || !miHomeApi.miCloudProtocol) {
      return;
    }

    try {
      if (miHomeApi.miCloudProtocol.isLoggedIn) {
        miHomeApi.miCloudProtocol.logout();
      }
    } catch {
      // Ignore logout errors during shutdown.
    }
  }
}

module.exports = {
  CloudMiHomeTransport
};
