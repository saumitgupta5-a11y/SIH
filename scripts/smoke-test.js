import { spawn } from "node:child_process";
import { once } from "node:events";

const port = 3101;
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["backend/server.js"], {
  env: { ...process.env, PORT: String(port), RESET_CHAIN: "true" },
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
server.stdout.on("data", (chunk) => { output += chunk; });
server.stderr.on("data", (chunk) => { output += chunk; });

let cookie = "";

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${base}${path}`, { ...options, headers });
  const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  if (cookies.length) cookie = cookies.map((item) => item.split(";")[0]).join("; ");
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${body.error || response.status}`);
  return body;
}

async function waitForApi() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch { /* still booting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`API did not start:\n${output}`);
}

try {
  await waitForApi();
  const foreignOrigin = await fetch(`${base}/api/health`, { headers: { origin: "https://untrusted.example" } });
  if (foreignOrigin.status !== 400) throw new Error("The API should reject requests from an untrusted browser origin");
  try {
    await request("/api/cases");
    throw new Error("Protected routes should reject anonymous callers");
  } catch (error) {
    if (!String(error.message).includes("Sign in required") && !String(error.message).includes("401")) throw error;
  }
  await request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "Nyaya@Admin" })
  });
  const suffix = Date.now().toString().slice(-6);
  const caseCreated = await request("/api/cases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reference: `SMOKE-${suffix}`, title: "Automated chain-of-custody test" })
  });
  await request("/api/logout", { method: "POST" });
  cookie = "";
  await request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "officer", password: "Nyaya@Officer" })
  });
  const form = new FormData();
  form.append("caseReference", `SMOKE-${suffix}`);
  form.append("documentReference", "DOC-001");
  form.append("title", "Smoke test FIR");
  form.append("docType", "0");
  form.append("file", new Blob(["unaltered evidence file"], { type: "text/plain" }), "evidence.txt");
  const document = await request("/api/documents", { method: "POST", body: form });
  const transfer = await request(`/api/documents/${document.documentId}/custody`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toActor: "forensicAnalyst", action: "Forensic examination" })
  });
  if (!transfer.transactionHash) throw new Error("Custody transfer did not return a transaction hash");
  await request("/api/logout", { method: "POST" });
  cookie = "";
  await request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "forensic", password: "Nyaya@Fsl" })
  });
  const revision = new FormData();
  revision.append("file", new Blob(["forensic annotated evidence file"], { type: "text/plain" }), "evidence-v2.txt");
  await request(`/api/documents/${document.documentId}/versions`, { method: "POST", body: revision });
  const check = new FormData();
  check.append("version", "2");
  check.append("file", new Blob(["forensic annotated evidence file"], { type: "text/plain" }), "evidence-v2.txt");
  const verification = await request(`/api/documents/${document.documentId}/verify`, { method: "POST", body: check });
  if (!verification.verified) throw new Error("Expected version 2 to verify");
  try {
    await request(`/api/documents/${document.documentId}/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ granteeActor: "forensicAnalyst", grant: false })
    });
    throw new Error("Current custodian access must not be revocable");
  } catch (error) {
    if (!String(error.message).includes("Cannot revoke current custodian access")) throw error;
  }
  await request("/api/logout", { method: "POST" });
  cookie = "";
  await request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "court", password: "Nyaya@Court" })
  });
  await request(`/api/documents/${document.documentId}/seal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  await request("/api/logout", { method: "POST" });
  cookie = "";
  await request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "Nyaya@Admin" })
  });
  try {
    await request(`/api/documents/${document.documentId}`);
    throw new Error("An administrator without a contract access grant must not read the document");
  } catch (error) {
    if (!String(error.message).includes("not been granted access")) throw error;
  }
  await request("/api/logout", { method: "POST" });
  cookie = "";
  await request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "forensic", password: "Nyaya@Fsl" })
  });
  const detail = await request(`/api/documents/${document.documentId}`);
  if (!detail.sealed || detail.versions.length !== 2 || detail.custody.length !== 1 || caseCreated.status !== "OPEN") throw new Error("Unexpected final contract state");
  console.log("Smoke test passed: authentication, case creation, registration, custody, versioning, verification, and sealing work end-to-end.");
} finally {
  server.kill("SIGTERM");
  await once(server, "exit").catch(() => undefined);
}
