import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const cookieName = "reels_admin";

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookies(header = "") {
  return Object.fromEntries(String(header).split(";").map((item) => {
    const separator = item.indexOf("=");
    if (separator < 0) return [item.trim(), ""];
    const value = item.slice(separator + 1).trim();
    try {
      return [item.slice(0, separator).trim(), decodeURIComponent(value)];
    } catch {
      return [item.slice(0, separator).trim(), value];
    }
  }).filter(([key]) => key));
}

export function createAdminAuth(env = process.env) {
  const password = String(env.ADMIN_PASSWORD || "");
  const enabled = Boolean(password);
  const sessionSecret = String(env.ADMIN_SESSION_SECRET || password);
  const sessionSeconds = 12 * 60 * 60;
  const secure = String(env.AUTH_COOKIE_SECURE || "true").toLowerCase() !== "false";
  const attempts = new Map();

  function signature(payload) {
    return createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  }

  function createSession() {
    const payload = Buffer.from(JSON.stringify({
      expiresAt: Date.now() + sessionSeconds * 1000,
      nonce: randomBytes(16).toString("base64url")
    })).toString("base64url");
    return `${payload}.${signature(payload)}`;
  }

  function authenticated(request) {
    if (!enabled) return true;
    const token = cookies(request.headers.cookie)[cookieName] || "";
    const separator = token.lastIndexOf(".");
    if (separator < 1) return false;
    const payload = token.slice(0, separator);
    if (!safeEqual(token.slice(separator + 1), signature(payload))) return false;
    try {
      const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      return Number(session.expiresAt) > Date.now();
    } catch {
      return false;
    }
  }

  function status(request, response) {
    response.json({ data: { enabled, authenticated: authenticated(request) } });
  }

  function login(request, response) {
    if (!enabled) return response.status(204).end();
    const key = request.ip || "unknown";
    const now = Date.now();
    const recent = (attempts.get(key) || []).filter((time) => now - time < 15 * 60 * 1000);
    if (recent.length >= 5) return response.status(429).json({ error: "Слишком много попыток. Попробуйте через 15 минут" });
    if (!safeEqual(request.body?.password, password)) {
      recent.push(now);
      attempts.set(key, recent);
      return response.status(401).json({ error: "Неверный пароль" });
    }
    attempts.delete(key);
    const flags = [`${cookieName}=${encodeURIComponent(createSession())}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${sessionSeconds}`];
    if (secure) flags.push("Secure");
    response.set("Set-Cookie", flags.join("; "));
    response.status(204).end();
  }

  function logout(_request, response) {
    const flags = [`${cookieName}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
    if (secure) flags.push("Secure");
    response.set("Set-Cookie", flags.join("; "));
    response.status(204).end();
  }

  function requireMutation(request, response, next) {
    if (!enabled || authenticated(request)) return next();
    return response.status(401).json({ error: "Для изменений войдите как владелец" });
  }

  return { enabled, authenticated, status, login, logout, requireMutation };
}
