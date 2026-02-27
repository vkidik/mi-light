function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toInt(value, keyName) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Field "${keyName}" must be a number`);
  }

  return Math.trunc(number);
}

function parseHexColor(value) {
  const normalized = value.startsWith("#") ? value.slice(1) : value;
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    throw new Error(`Invalid HEX color: "${value}"`);
  }

  const intValue = parseInt(normalized, 16);
  return {
    r: (intValue >> 16) & 0xff,
    g: (intValue >> 8) & 0xff,
    b: intValue & 0xff
  };
}

function normalizeRgbObject(value) {
  const r = clamp(toInt(value.r, "r"), 0, 255);
  const g = clamp(toInt(value.g, "g"), 0, 255);
  const b = clamp(toInt(value.b, "b"), 0, 255);
  return { r, g, b };
}

function normalizeRgbArray(value) {
  if (value.length !== 3) {
    throw new Error(`RGB array must have 3 items, got ${value.length}`);
  }

  return {
    r: clamp(toInt(value[0], "r"), 0, 255),
    g: clamp(toInt(value[1], "g"), 0, 255),
    b: clamp(toInt(value[2], "b"), 0, 255)
  };
}

function parseColor(input) {
  if (typeof input === "string") {
    return parseHexColor(input.trim());
  }

  if (Array.isArray(input)) {
    return normalizeRgbArray(input);
  }

  if (input && typeof input === "object") {
    return normalizeRgbObject(input);
  }

  throw new Error(
    "Color must be HEX string (#RRGGBB), RGB object ({r,g,b}), or RGB array ([r,g,b])"
  );
}

function rgbToInt({ r, g, b }) {
  return ((r & 0xff) << 16) + ((g & 0xff) << 8) + (b & 0xff);
}

module.exports = {
  clamp,
  parseColor,
  rgbToInt
};

