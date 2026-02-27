const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const querystring = require("node:querystring");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");

function parseMiJson(text) {
  return JSON.parse(text.startsWith("&&&START&&&") ? text.slice("&&&START&&&".length) : text);
}

function getSetCookieArray(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function updateCookies(cookieJar, headers) {
  const cookies = getSetCookieArray(headers);
  for (const cookieStr of cookies) {
    const firstPart = cookieStr.split(";")[0];
    const eq = firstPart.indexOf("=");
    if (eq > 0) {
      const key = firstPart.slice(0, eq).trim();
      const value = firstPart.slice(eq + 1).trim();
      cookieJar.set(key, value);
    }
  }
}

function getCookieHeader(cookieJar) {
  return Array.from(cookieJar.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

async function ask(question) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function fetchStep1(protocol, cookieJar) {
  const response = await fetch("https://account.xiaomi.com/pass/serviceLogin?sid=xiaomiio&_json=true", {
    headers: {
      "User-Agent": protocol.USERAGENT,
      Cookie: getCookieHeader(cookieJar)
    }
  });

  updateCookies(cookieJar, response.headers);
  const text = await response.text();
  const json = parseMiJson(text);
  if (!json._sign) {
    throw new Error(`Login step1 failed: ${text}`);
  }

  return { sign: json._sign };
}

async function fetchStep2(protocol, cookieJar, { username, password, sign, captCode }) {
  const formData = {
    hash: crypto.createHash("md5").update(password).digest("hex").toUpperCase(),
    _json: "true",
    sid: "xiaomiio",
    callback: "https://sts.api.io.mi.com/sts",
    qs: "%3Fsid%3Dxiaomiio%26_json%3Dtrue",
    _sign: sign,
    user: username
  };

  if (captCode) {
    formData.captCode = captCode;
  }

  const response = await fetch("https://account.xiaomi.com/pass/serviceLoginAuth2", {
    method: "POST",
    body: querystring.stringify(formData),
    headers: {
      "User-Agent": protocol.USERAGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: getCookieHeader(cookieJar)
    }
  });

  updateCookies(cookieJar, response.headers);
  const text = await response.text();
  return {
    httpStatus: response.status,
    response: parseMiJson(text)
  };
}

async function fetchCaptcha(protocol, cookieJar, captchaUrl, captchaImagePath) {
  const fullUrl = captchaUrl.startsWith("http")
    ? captchaUrl
    : `https://account.xiaomi.com${captchaUrl}`;

  const response = await fetch(fullUrl, {
    headers: {
      "User-Agent": protocol.USERAGENT,
      Cookie: getCookieHeader(cookieJar)
    }
  });

  updateCookies(cookieJar, response.headers);
  if (!response.ok) {
    throw new Error(`Failed to load captcha: ${response.status} ${response.statusText}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(captchaImagePath), { recursive: true });
  fs.writeFileSync(captchaImagePath, bytes);
}

async function fetchStep3(protocol, cookieJar, locationUrl) {
  const response = await fetch(locationUrl, {
    headers: {
      "User-Agent": protocol.USERAGENT,
      Cookie: getCookieHeader(cookieJar)
    }
  });

  updateCookies(cookieJar, response.headers);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Login step3 failed (${response.status}): ${text}`);
  }
}

async function doEmail2faFlow(protocol, cookieJar, notificationUrl, logger) {
  const headers = {
    "User-Agent": protocol.USERAGENT,
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: getCookieHeader(cookieJar)
  };

  const openStart = await fetch(notificationUrl, { headers, redirect: "manual" });
  updateCookies(cookieJar, openStart.headers);

  const context = new URL(notificationUrl).searchParams.get("context");
  if (!context) {
    throw new Error("Xiaomi 2FA context is missing in notificationUrl");
  }

  const listUrl = new URL("https://account.xiaomi.com/identity/list");
  listUrl.searchParams.set("sid", "xiaomiio");
  listUrl.searchParams.set("context", context);
  listUrl.searchParams.set("_locale", "en_US");
  const listResponse = await fetch(listUrl, {
    headers: {
      ...headers,
      Cookie: getCookieHeader(cookieJar)
    }
  });
  updateCookies(cookieJar, listResponse.headers);

  const sendUrl = new URL("https://account.xiaomi.com/identity/auth/sendEmailTicket");
  sendUrl.searchParams.set("_dc", String(Date.now()));
  sendUrl.searchParams.set("sid", "xiaomiio");
  sendUrl.searchParams.set("context", context);
  sendUrl.searchParams.set("mask", "0");
  sendUrl.searchParams.set("_locale", "en_US");

  const sendBody = querystring.stringify({
    retry: "0",
    icode: "",
    _json: "true",
    ick: cookieJar.get("ick") || ""
  });

  const sendResponse = await fetch(sendUrl, {
    method: "POST",
    headers: {
      ...headers,
      Cookie: getCookieHeader(cookieJar)
    },
    body: sendBody
  });
  updateCookies(cookieJar, sendResponse.headers);

  const sendText = await sendResponse.text();
  let sendJson = {};
  try {
    sendJson = parseMiJson(sendText);
  } catch {
    sendJson = {};
  }
  if (sendJson.code && sendJson.code !== 0) {
    throw new Error(
      `Xiaomi sendEmailTicket failed: code=${sendJson.code} desc=${sendJson.description || sendJson.desc || "unknown"}`
    );
  }

  logger("\nCloud login requires email verification.");
  const code = await ask("Enter Xiaomi email verification code: ");
  if (!code) {
    throw new Error("2FA code is required");
  }

  const verifyUrl = new URL("https://account.xiaomi.com/identity/auth/verifyEmail");
  verifyUrl.searchParams.set("_flag", "8");
  verifyUrl.searchParams.set("_json", "true");
  verifyUrl.searchParams.set("sid", "xiaomiio");
  verifyUrl.searchParams.set("context", context);
  verifyUrl.searchParams.set("mask", "0");
  verifyUrl.searchParams.set("_locale", "en_US");

  const verifyBody = querystring.stringify({
    _flag: "8",
    ticket: code,
    trust: "false",
    _json: "true",
    ick: cookieJar.get("ick") || ""
  });

  const verifyResponse = await fetch(verifyUrl, {
    method: "POST",
    headers: {
      ...headers,
      Cookie: getCookieHeader(cookieJar)
    },
    body: verifyBody,
    redirect: "manual"
  });
  updateCookies(cookieJar, verifyResponse.headers);

  const verifyText = await verifyResponse.text();
  let finishLocation = verifyResponse.headers.get("location");
  try {
    const verifyJson = parseMiJson(verifyText);
    if (!finishLocation && verifyJson.location) {
      finishLocation = verifyJson.location;
    }
    if (verifyJson.code && verifyJson.code !== 0) {
      throw new Error(
        `Xiaomi verifyEmail failed: code=${verifyJson.code} desc=${verifyJson.description || verifyJson.desc || "unknown"}`
      );
    }
  } catch {
    // Ignore JSON parse errors and continue with fallback checks.
  }

  if (!finishLocation) {
    const checkUrl = new URL("https://account.xiaomi.com/identity/result/check");
    checkUrl.searchParams.set("sid", "xiaomiio");
    checkUrl.searchParams.set("context", context);
    checkUrl.searchParams.set("_locale", "en_US");
    const checkResponse = await fetch(checkUrl, {
      headers: {
        ...headers,
        Cookie: getCookieHeader(cookieJar)
      },
      redirect: "manual"
    });
    updateCookies(cookieJar, checkResponse.headers);
    finishLocation = checkResponse.headers.get("location") || checkResponse.url;
  }

  if (finishLocation) {
    let currentUrl = finishLocation;
    for (let hop = 0; hop < 5; hop += 1) {
      const hopResponse = await fetch(currentUrl, {
        headers: {
          ...headers,
          Cookie: getCookieHeader(cookieJar)
        },
        redirect: "manual"
      });
      updateCookies(cookieJar, hopResponse.headers);

      const location = hopResponse.headers.get("location");
      if (location && hopResponse.status >= 300 && hopResponse.status < 400) {
        currentUrl = location.startsWith("http") ? location : new URL(location, currentUrl).toString();
        continue;
      }
      break;
    }
  }
}

function isStep2Success(step2) {
  return Boolean(step2.response.ssecurity && step2.response.userId && step2.response.location);
}

function isCaptchaRequired(step2) {
  return step2.response.code === 87001 && step2.response.captchaUrl;
}

function isIdentityVerificationRequired(step2) {
  return Boolean(step2.response.notificationUrl) && !isStep2Success(step2);
}

function ensureInteractiveAllowed(allowInteractive) {
  if (!allowInteractive) {
    throw new Error("Cloud login requires captcha/2FA. Enable cloud.interactiveAuth to finish login once.");
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Cloud login requires interactive terminal for captcha/2FA. Start server in TTY or prefill session file."
    );
  }
}

async function resolveStep2Challenges(
  protocol,
  cookieJar,
  username,
  password,
  { allowInteractive, captchaImagePath, logger }
) {
  const { sign: initialSign } = await fetchStep1(protocol, cookieJar);
  let sign = initialSign;
  let lastCaptchaCode;
  let step2 = await fetchStep2(protocol, cookieJar, {
    username,
    password,
    sign,
    captCode: lastCaptchaCode
  });

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    if (isStep2Success(step2)) {
      return step2;
    }

    if (isCaptchaRequired(step2)) {
      ensureInteractiveAllowed(allowInteractive);
      await fetchCaptcha(protocol, cookieJar, step2.response.captchaUrl, captchaImagePath);
      logger(`Cloud login captcha required. Open image: ${captchaImagePath}`);
      lastCaptchaCode = await ask("Enter captcha code: ");
      sign = step2.response._sign || sign;
      step2 = await fetchStep2(protocol, cookieJar, {
        username,
        password,
        sign,
        captCode: lastCaptchaCode
      });
      continue;
    }

    if (isIdentityVerificationRequired(step2)) {
      ensureInteractiveAllowed(allowInteractive);
      logger("Additional Xiaomi verification required.");
      await doEmail2faFlow(protocol, cookieJar, step2.response.notificationUrl, logger);
      sign = step2.response._sign || sign;
      step2 = await fetchStep2(protocol, cookieJar, {
        username,
        password,
        sign,
        captCode: lastCaptchaCode
      });
      continue;
    }

    return step2;
  }

  throw new Error("Login step2 did not complete after 10 attempts");
}

function applySession(protocol, session, { username, password } = {}) {
  protocol.username = username || session.username || null;
  protocol.password = password || null;
  protocol.ssecurity = session.ssecurity;
  protocol.userId = session.userId;
  protocol.serviceToken = session.serviceToken;
}

function normalizeSession(session) {
  if (!session || typeof session !== "object") {
    return null;
  }

  if (!session.ssecurity || !session.userId || !session.serviceToken) {
    return null;
  }

  return {
    username: session.username || null,
    ssecurity: session.ssecurity,
    userId: session.userId,
    serviceToken: session.serviceToken,
    createdAt: session.createdAt || new Date().toISOString()
  };
}

function loadSessionFromFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return normalizeSession(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveSessionToFile(filePath, session) {
  const normalized = normalizeSession(session);
  if (!normalized) {
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
}

async function loginWithChallenges(protocol, options) {
  const captchaImagePath = options.captchaImagePath || path.resolve(process.cwd(), "xiaomi-captcha.jpg");
  const cookieJar = new Map([
    ["sdkVersion", "accountsdk-18.8.15"],
    ["deviceId", protocol.CLIENT_ID]
  ]);

  const step2 = await resolveStep2Challenges(
    protocol,
    cookieJar,
    options.username,
    options.password,
    {
      allowInteractive: options.allowInteractive !== false,
      captchaImagePath,
      logger: options.logger || ((message) => process.stdout.write(`${message}\n`))
    }
  );

  if (!isStep2Success(step2)) {
    throw new Error(
      `Cloud login failed. code=${step2.response.code} desc=${step2.response.description || step2.response.desc || "unknown"}`
    );
  }

  await fetchStep3(protocol, cookieJar, step2.response.location);
  const serviceToken = cookieJar.get("serviceToken");
  if (!serviceToken) {
    throw new Error("Cloud login failed: serviceToken is missing after step3");
  }

  const session = {
    username: options.username,
    ssecurity: step2.response.ssecurity,
    userId: step2.response.userId,
    serviceToken,
    createdAt: new Date().toISOString()
  };

  applySession(protocol, session, {
    username: options.username,
    password: options.password
  });
  return session;
}

module.exports = {
  applySession,
  loadSessionFromFile,
  loginWithChallenges,
  saveSessionToFile
};
