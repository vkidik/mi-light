class LightService {
  constructor(config, transports) {
    this.config = config;
    this.lanTransport = transports.lanTransport;
    this.cloudTransport = transports.cloudTransport;
    this.devicesByName = new Map(config.devices.map((device) => [device.name, device]));
    this.requestTimeoutMs = config.requestTimeoutMs || 12000;
  }

  listGroups() {
    return this.config.groups;
  }

  resolveTarget(targetName) {
    if (!targetName) {
      return this.config.devices;
    }

    if (this.devicesByName.has(targetName)) {
      return [this.devicesByName.get(targetName)];
    }

    if (Object.prototype.hasOwnProperty.call(this.config.groups, targetName)) {
      const unique = new Map();
      for (const name of this.config.groups[targetName]) {
        unique.set(name, this.devicesByName.get(name));
      }
      return Array.from(unique.values());
    }

    throw new Error(`Unknown light target "${targetName}". Use device name or group name`);
  }

  selectTransport(deviceConfig) {
    if (deviceConfig.transport === "cloud") {
      if (!this.cloudTransport) {
        throw new Error(`Device "${deviceConfig.name}" requires cloud transport, but cloud is disabled`);
      }
      return this.cloudTransport;
    }

    return this.lanTransport;
  }

  async executeWithTimeout(promise, timeoutMs, message) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return promise;
    }

    let timer = null;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(message));
          }, timeoutMs);

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

  async executeToggleSynchronized(targetName, targets, payload = {}) {
    const togglePlanTimeoutMs = Math.max(1000, Math.min(this.requestTimeoutMs, 3000));
    const plansByDeviceName = new Map();

    await Promise.all(
      targets.map(async (deviceConfig) => {
        const transport = this.selectTransport(deviceConfig);
        if (typeof transport.prepareToggle !== "function" || typeof transport.setPowerState !== "function") {
          return;
        }

        try {
          const nextPower = await this.executeWithTimeout(
            transport.prepareToggle(deviceConfig),
            togglePlanTimeoutMs,
            `Toggle planning timed out after ${togglePlanTimeoutMs}ms`
          );
          plansByDeviceName.set(deviceConfig.name, { nextPower });
        } catch (error) {
          plansByDeviceName.set(deviceConfig.name, { error });
        }
      })
    );

    const items = await Promise.all(
      targets.map(async (deviceConfig) => {
        const planned = plansByDeviceName.get(deviceConfig.name);
        try {
          if (planned && planned.error) {
            throw planned.error;
          }

          const transport = this.selectTransport(deviceConfig);
          const plan = planned;
          const executionPromise =
            plan && plan.nextPower !== undefined && typeof transport.setPowerState === "function"
              ? transport.setPowerState(deviceConfig, plan.nextPower, payload)
              : transport.execute(deviceConfig, "toggle", payload);

          const result = await this.executeWithTimeout(
            executionPromise,
            this.requestTimeoutMs,
            `Command "toggle" timed out after ${this.requestTimeoutMs}ms`
          );

          return {
            device: deviceConfig.name,
            transport: deviceConfig.transport,
            ok: true,
            result
          };
        } catch (error) {
          return {
            device: deviceConfig.name,
            transport: deviceConfig.transport,
            ok: false,
            error: error.message
          };
        }
      })
    );

    const success = items.filter((item) => item.ok).length;
    return {
      target: targetName || "all",
      command: "toggle",
      success,
      failed: items.length - success,
      items
    };
  }

  async execute(targetName, command, payload = {}) {
    const targets = this.resolveTarget(targetName);

    if (command === "toggle" && targets.length > 1) {
      return this.executeToggleSynchronized(targetName, targets, payload);
    }

    const items = await Promise.all(
      targets.map(async (deviceConfig) => {
        try {
          const transport = this.selectTransport(deviceConfig);
          const result = await this.executeWithTimeout(
            transport.execute(deviceConfig, command, payload),
            this.requestTimeoutMs,
            `Command "${command}" timed out after ${this.requestTimeoutMs}ms`
          );
          return {
            device: deviceConfig.name,
            transport: deviceConfig.transport,
            ok: true,
            result
          };
        } catch (error) {
          return {
            device: deviceConfig.name,
            transport: deviceConfig.transport,
            ok: false,
            error: error.message
          };
        }
      })
    );

    const success = items.filter((item) => item.ok).length;
    return {
      target: targetName || "all",
      command,
      success,
      failed: items.length - success,
      items
    };
  }

  async applyState(targetName, state) {
    const steps = [];

    if (state.power !== undefined) {
      const powerValue = typeof state.power === "boolean" ? (state.power ? "on" : "off") : String(state.power).toLowerCase();
      if (powerValue === "on" || powerValue === "off" || powerValue === "toggle") {
        steps.push(await this.execute(targetName, powerValue, state));
      } else {
        throw new Error('state.power must be one of: "on", "off", "toggle", true, false');
      }
    }

    if (state.brightness !== undefined) {
      steps.push(await this.execute(targetName, "brightness", { value: state.brightness, duration: state.duration }));
    }

    if (state.temperature !== undefined) {
      steps.push(await this.execute(targetName, "temperature", { value: state.temperature, duration: state.duration }));
    }

    if (state.color !== undefined) {
      steps.push(await this.execute(targetName, "color", { color: state.color, duration: state.duration }));
    }

    return {
      target: targetName || "all",
      command: "state",
      steps
    };
  }

  async shutdown() {
    await this.lanTransport.disconnectAll();
    if (this.cloudTransport) {
      await this.cloudTransport.disconnectAll();
    }
  }
}

module.exports = {
  LightService
};
