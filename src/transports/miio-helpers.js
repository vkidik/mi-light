const LIGHT_PROPS = [
  "power",
  "bright",
  "ct",
  "rgb",
  "hue",
  "sat",
  "color_mode",
  "name"
];

function normalizeDuration(duration, fallback = 400) {
  if (duration === undefined || duration === null) {
    return fallback;
  }

  const normalized = Number(duration);
  if (!Number.isFinite(normalized) || normalized < 0) {
    return fallback;
  }

  return Math.trunc(normalized);
}

function unwrapMiioResult(response) {
  if (response && typeof response === "object" && Array.isArray(response.result)) {
    return response.result;
  }

  return response;
}

function parseNumberish(value) {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string" && value !== "") {
    const maybe = Number(value);
    if (Number.isFinite(maybe)) {
      return maybe;
    }
  }

  return value;
}

function mapPropsByNames(propNames, rawPayload) {
  const raw = unwrapMiioResult(rawPayload);
  const values = Array.isArray(raw) ? raw : [];
  const mapped = {};

  for (let index = 0; index < propNames.length; index += 1) {
    const key = propNames[index];
    mapped[key] = parseNumberish(values[index]);
  }

  return mapped;
}

function mapLightProps(rawPayload) {
  return mapPropsByNames(LIGHT_PROPS, rawPayload);
}

module.exports = {
  LIGHT_PROPS,
  mapPropsByNames,
  mapLightProps,
  normalizeDuration,
  parseNumberish,
  unwrapMiioResult
};
