import crypto from "node:crypto";

export const demoAccounts = [
  { username: "admin", password: "Nyaya@Admin", actorKey: "administrator", label: "System Administrator" },
  { username: "officer", password: "Nyaya@Officer", actorKey: "investigatingOfficer", label: "Investigating Officer" },
  { username: "forensic", password: "Nyaya@Fsl", actorKey: "forensicAnalyst", label: "Forensic Analyst" },
  { username: "prosecutor", password: "Nyaya@Prosecutor", actorKey: "prosecutor", label: "Public Prosecutor" },
  { username: "court", password: "Nyaya@Court", actorKey: "courtClerk", label: "Court Clerk" }
];

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE_NAME = "nv_session";
const secret = process.env.SESSION_SECRET || "nyayavault-local-demo-secret";
const passwordSalt = "nyayavault-demo-salt-v1";
const sessions = new Map();

const users = demoAccounts.map((account) => ({
  username: account.username,
  actorKey: account.actorKey,
  label: account.label,
  passwordHash: crypto.scryptSync(account.password, passwordSalt, 64)
}));

function parseCookies(header = "") {
  const cookies = {};
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key) cookies[key] = decodeURIComponent(rest.join("="));
  }
  return cookies;
}

function sign(value) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function sessionCookie(id) {
  const value = `${id}.${sign(id)}`;
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

function clearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

function readSessionId(req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!raw || !raw.includes(".")) return null;
  const [id, mac] = raw.split(".");
  const expected = sign(id);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return id;
}

export function getSession(req) {
  const id = readSessionId(req);
  if (!id) return null;
  const session = sessions.get(id);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(id);
    return null;
  }
  return session;
}

export function requireAuth(req, _res, next) {
  const session = getSession(req);
  if (!session) {
    const error = new Error("Sign in required");
    error.status = 401;
    return next(error);
  }
  req.session = session;
  next();
}

export function authenticate(username, password) {
  const user = users.find((item) => item.username === String(username || "").trim().toLowerCase());
  if (!user) return null;
  const candidate = crypto.scryptSync(String(password || ""), passwordSalt, 64);
  if (!crypto.timingSafeEqual(candidate, user.passwordHash)) return null;
  return { username: user.username, actorKey: user.actorKey, label: user.label };
}

export function createSession(res, user) {
  const id = crypto.randomUUID();
  sessions.set(id, { ...user, expiresAt: Date.now() + SESSION_TTL_MS });
  res.setHeader("Set-Cookie", sessionCookie(id));
  return { username: user.username, actorKey: user.actorKey, label: user.label };
}

export function destroySession(req, res) {
  const id = readSessionId(req);
  if (id) sessions.delete(id);
  res.setHeader("Set-Cookie", clearCookie());
}

export const publicDemoLogins = demoAccounts.map(({ username, password, label, actorKey }) => ({
  username, password, label, actorKey
}));
