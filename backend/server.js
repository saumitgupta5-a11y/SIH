import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import { ethers } from "ethers";
import { authenticate, createSession, destroySession, getSession, publicDemoLogins, requireAuth } from "./auth.js";
import { asNumber, caseStatuses, documentTypes, getChain, sha256, sha256File, toHexId } from "./chain.js";

dotenv.config();
const app = express();
const port = Number(process.env.PORT || 3001);
const rootDir = process.cwd();
const dataDir = path.join(rootDir, "data");
const uploadDir = path.join(rootDir, "uploads");
const storePath = path.join(dataDir, "registry.json");

let memoryStore = null;
let writeQueue = Promise.resolve();

const allowedOrigins = (process.env.CLIENT_ORIGIN || "http://127.0.0.1:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.disable("x-powered-by");
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed"));
  },
  credentials: true,
  methods: ["GET", "POST"],
  optionsSuccessStatus: 204
}));
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  next();
});
app.use(express.json({ limit: "1mb" }));

const diskUpload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, callback) => {
      try { await fs.mkdir(uploadDir, { recursive: true }); callback(null, uploadDir); } catch (error) { callback(error); }
    },
    filename: (_req, file, callback) => {
      const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, "_");
      callback(null, `${Date.now()}-${crypto.randomUUID()}-${safeName || "document.bin"}`);
    }
  }),
  limits: { fileSize: 15 * 1024 * 1024 }
});
const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function errorMessage(error) {
  return error?.revert?.args?.[0] || error?.info?.error?.message || error?.info?.error?.data?.message || error?.shortMessage || error?.reason || error?.message || "Request failed";
}

function cleanReference(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  if (value.trim().length > 100) throw new Error(`${label} must be 100 characters or fewer`);
  return value.trim();
}

function emptyStore(contractAddress = null, chainContext = null) {
  return { contractAddress, chainContext, cases: [], documents: [], activity: [] };
}

async function loadStore() {
  if (memoryStore) return memoryStore;
  await fs.mkdir(dataDir, { recursive: true });
  try { memoryStore = JSON.parse(await fs.readFile(storePath, "utf8")); }
  catch { memoryStore = emptyStore(); }
  return memoryStore;
}

async function saveStore(store) {
  memoryStore = store;
  await fs.mkdir(dataDir, { recursive: true });
  const temp = `${storePath}.tmp`;
  await fs.writeFile(temp, JSON.stringify(store, null, 2));
  await fs.rename(temp, storePath);
}

function withWriteLock(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch((error) => { console.error(error); });
  return run;
}

async function ensureStoreForChain(chain) {
  const store = await loadStore();
  const chainContext = chain.sessionId;
  if (store.chainContext !== chainContext) {
    // An embedded Ganache node is intentionally ephemeral. Its prior ledger
    // cannot validate a fresh contract deployment, so do not expose stale rows.
    memoryStore = emptyStore(chain.address, chainContext);
    await saveStore(memoryStore);
    return;
  }
  if (!store.contractAddress || !store.chainContext) {
    store.contractAddress = chain.address;
    store.chainContext = chainContext;
    await saveStore(store);
  }
}

function pushActivity(store, entry) {
  store.activity.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), ...entry });
  store.activity = store.activity.slice(0, 250);
}

async function actorFrom(req) {
  const actorKey = req.session?.actorKey;
  if (!actorKey) {
    const error = new Error("Sign in required");
    error.status = 401;
    throw error;
  }
  const chain = await getChain();
  const actor = chain.actors.find((item) => item.key === actorKey);
  if (!actor) throw new Error("Choose a valid demo participant");
  const index = chain.actors.findIndex((item) => item.key === actorKey);
  return { chain, actor, signer: chain.signers[index] };
}

function txInfo(receipt) {
  return { transactionHash: receipt.hash, blockNumber: Number(receipt.blockNumber) };
}

async function ensureDocumentAccess(req, documentId) {
  const { chain, actor } = await actorFrom(req);
  const canRead = await chain.contract.hasAccess(documentId, actor.address);
  if (!canRead) {
    const error = new Error("This participant has not been granted access to this document");
    error.status = 403;
    throw error;
  }
  return { chain, actor };
}

function findIndexedDocument(store, documentId) {
  const document = store.documents.find((item) => item.documentId.toLowerCase() === documentId.toLowerCase());
  if (!document) {
    const error = new Error("Document is not in this local registry. It may have been registered outside this MVP server.");
    error.status = 404;
    throw error;
  }
  return document;
}

async function documentView(document, chain) {
  const [details, versions, custody, status] = await Promise.all([
    chain.contract.getDocument(document.documentId),
    chain.contract.getAllVersions(document.documentId),
    chain.contract.getAllCustodyHistory(document.documentId),
    chain.contract.caseStatus(document.caseId)
  ]);
  return {
    ...document,
    docType: documentTypes[asNumber(details[1])],
    currentCustodian: details[2],
    sealed: details[3],
    caseStatus: caseStatuses[asNumber(status)],
    versions: versions.map((version) => ({
      hash: version.documentHash,
      metadataURI: version.metadataURI,
      version: asNumber(version.version),
      createdBy: version.createdBy,
      timestamp: new Date(asNumber(version.timestamp) * 1000).toISOString()
    })),
    custody: custody.map((event) => ({
      from: event.from,
      to: event.to,
      action: event.action,
      timestamp: new Date(asNumber(event.timestamp) * 1000).toISOString()
    }))
  };
}

async function removeUploaded(file) {
  if (file?.path) await fs.unlink(file.path).catch(() => undefined);
}

app.get("/api/health", async (_req, res, next) => {
  try {
    const chain = await getChain();
    res.json({ ok: true, contractAddress: chain.address, chain: chain.embedded ? "embedded Ganache (resets on restart)" : "configured RPC" });
  } catch (error) { next(error); }
});

app.post("/api/login", (req, res, next) => {
  try {
    const user = authenticate(req.body?.username, req.body?.password);
    if (!user) {
      const error = new Error("Invalid username or password");
      error.status = 401;
      throw error;
    }
    const session = createSession(res, user);
    res.json({ user: session, demoAccounts: publicDemoLogins });
  } catch (error) { next(error); }
});

app.post("/api/logout", (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

app.get("/api/session", (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Sign in required", demoAccounts: publicDemoLogins });
  res.json({ user: { username: session.username, actorKey: session.actorKey, label: session.label }, demoAccounts: publicDemoLogins });
});

app.get("/api/login-options", (_req, res) => {
  res.json({ demoAccounts: publicDemoLogins });
});

app.use("/api", (req, res, next) => {
  if (req.path === "/health" || req.path === "/login" || req.path === "/logout" || req.path === "/session" || req.path === "/login-options") return next();
  return requireAuth(req, res, next);
});

app.get("/api/config", async (_req, res, next) => {
  try {
    const chain = await getChain();
    res.json({ contractAddress: chain.address, actors: chain.actors, documentTypes, caseStatuses, embeddedChain: chain.embedded });
  } catch (error) { next(error); }
});

app.get("/api/cases", async (_req, res, next) => {
  try {
    const [store, chain] = await Promise.all([loadStore(), getChain()]);
    const counts = new Map();
    for (const doc of store.documents) counts.set(doc.caseId, (counts.get(doc.caseId) || 0) + 1);
    const statuses = store.cases.length ? await chain.contract.getCaseStatuses(store.cases.map((item) => item.caseId)) : [];
    const cases = store.cases.map((item, index) => ({
      ...item,
      status: caseStatuses[asNumber(statuses[index])],
      documentCount: counts.get(item.caseId) || 0
    }));
    res.json(cases.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  } catch (error) { next(error); }
});

app.post("/api/cases", async (req, res, next) => {
  try {
    const reference = cleanReference(req.body.reference, "Case reference");
    const title = cleanReference(req.body.title, "Case title");
    const { chain, actor, signer } = await actorFrom(req);
    const caseId = toHexId("case", reference);
    const created = await withWriteLock(async () => {
      const store = await loadStore();
      if (store.cases.some((item) => item.caseId === caseId)) {
        const error = new Error("That case reference already exists");
        error.status = 409;
        throw error;
      }
      const receipt = await (await chain.contract.connect(signer).openCase(caseId)).wait();
      const entry = { caseId, reference, title, createdAt: new Date().toISOString(), createdBy: actor.key };
      store.cases.push(entry);
      pushActivity(store, { type: "CASE_OPENED", actor: actor.label, caseId, description: `Opened case ${reference}`, ...txInfo(receipt) });
      await saveStore(store);
      return { ...entry, status: "OPEN", ...txInfo(receipt) };
    });
    res.status(201).json(created);
  } catch (error) { next(error); }
});

app.post("/api/cases/:caseId/status", async (req, res, next) => {
  try {
    const status = Number(req.body.status);
    if (!Number.isInteger(status) || status < 0 || status >= caseStatuses.length) throw new Error("Choose a valid case status");
    const { chain, actor, signer } = await actorFrom(req);
    const updated = await withWriteLock(async () => {
      const store = await loadStore();
      const caseEntry = store.cases.find((item) => item.caseId.toLowerCase() === req.params.caseId.toLowerCase());
      if (!caseEntry) {
        const error = new Error("Case not found");
        error.status = 404;
        throw error;
      }
      const receipt = await (await chain.contract.connect(signer).setCaseStatus(caseEntry.caseId, status)).wait();
      pushActivity(store, { type: "CASE_STATUS_CHANGED", actor: actor.label, caseId: caseEntry.caseId, description: `Changed ${caseEntry.reference} to ${caseStatuses[status]}`, ...txInfo(receipt) });
      await saveStore(store);
      return { caseId: caseEntry.caseId, status: caseStatuses[status], ...txInfo(receipt) };
    });
    res.json(updated);
  } catch (error) { next(error); }
});

app.get("/api/documents", async (req, res, next) => {
  try {
    const [store, { chain, actor }] = await Promise.all([loadStore(), actorFrom(req)]);
    const caseId = req.query.caseId?.toLowerCase();
    const candidates = store.documents.filter((item) => !caseId || item.caseId.toLowerCase() === caseId);
    let accessible = candidates;
    if (candidates.length) {
      const flags = await chain.contract.hasAccessBatch(candidates.map((doc) => doc.documentId), actor.address);
      accessible = candidates.filter((_, index) => flags[index]);
    }
    res.json(accessible.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  } catch (error) { next(error); }
});

app.post("/api/documents", diskUpload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw new Error("Choose a document file");
    const caseReference = cleanReference(req.body.caseReference, "Case reference");
    const documentReference = cleanReference(req.body.documentReference, "Document reference");
    const title = cleanReference(req.body.title, "Document title");
    const type = Number(req.body.docType);
    if (!Number.isInteger(type) || !documentTypes[type]) throw new Error("Choose a valid document type");
    const { chain, actor, signer } = await actorFrom(req);
    const created = await withWriteLock(async () => {
      const store = await loadStore();
      const caseEntry = store.cases.find((item) => item.reference.toUpperCase() === caseReference.toUpperCase());
      if (!caseEntry) throw new Error("Create the case before registering its documents");
      const documentId = toHexId("document", `${caseEntry.caseId}:${documentReference}`);
      if (store.documents.some((item) => item.documentId === documentId)) {
        const error = new Error("That document reference already exists in this case");
        error.status = 409;
        throw error;
      }
      const fileHash = await sha256File(req.file.path);
      const metadataURI = `local://documents/${req.file.filename}`;
      const receipt = await (await chain.contract.connect(signer).registerDocument(documentId, caseEntry.caseId, type, fileHash, metadataURI)).wait();
      const entry = {
        documentId, caseId: caseEntry.caseId, caseReference: caseEntry.reference, documentReference, title,
        createdAt: new Date().toISOString(), createdBy: actor.key, initialHash: fileHash,
        files: [{ version: 1, storedName: req.file.filename, originalName: req.file.originalname, mimeType: req.file.mimetype, size: req.file.size, hash: fileHash, uploadedAt: new Date().toISOString() }]
      };
      store.documents.push(entry);
      pushActivity(store, { type: "DOCUMENT_REGISTERED", actor: actor.label, caseId: entry.caseId, documentId, description: `Registered ${title} as version 1`, ...txInfo(receipt) });
      await saveStore(store);
      return { ...entry, ...txInfo(receipt) };
    });
    res.status(201).json(created);
  } catch (error) { await removeUploaded(req.file); next(error); }
});

app.get("/api/documents/:documentId", async (req, res, next) => {
  try {
    const store = await loadStore();
    const indexed = findIndexedDocument(store, req.params.documentId);
    const { chain } = await ensureDocumentAccess(req, indexed.documentId);
    res.json(await documentView(indexed, chain));
  } catch (error) { next(error); }
});

app.post("/api/documents/:documentId/versions", diskUpload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw new Error("Choose the revised file");
    const { chain, actor, signer } = await actorFrom(req);
    const created = await withWriteLock(async () => {
      const store = await loadStore();
      const indexed = findIndexedDocument(store, req.params.documentId);
      const hash = await sha256File(req.file.path);
      const metadataURI = `local://documents/${req.file.filename}`;
      const receipt = await (await chain.contract.connect(signer).addVersion(indexed.documentId, hash, metadataURI)).wait();
      const version = indexed.files.length + 1;
      indexed.files.push({ version, storedName: req.file.filename, originalName: req.file.originalname, mimeType: req.file.mimetype, size: req.file.size, hash, uploadedAt: new Date().toISOString() });
      pushActivity(store, { type: "VERSION_CREATED", actor: actor.label, caseId: indexed.caseId, documentId: indexed.documentId, description: `Added version ${version} to ${indexed.title}`, ...txInfo(receipt) });
      await saveStore(store);
      return { version, hash, ...txInfo(receipt) };
    });
    res.status(201).json(created);
  } catch (error) { await removeUploaded(req.file); next(error); }
});

app.post("/api/documents/:documentId/verify", memoryUpload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw new Error("Choose a file to verify");
    const version = Number(req.body.version);
    if (!Number.isInteger(version) || version < 1) throw new Error("Choose a valid version");
    const store = await loadStore();
    const indexed = findIndexedDocument(store, req.params.documentId);
    const { chain } = await ensureDocumentAccess(req, indexed.documentId);
    const hash = sha256(req.file.buffer);
    const verified = await chain.contract.verifyVersion(indexed.documentId, version, hash);
    res.json({ verified, version, computedHash: hash, documentId: indexed.documentId });
  } catch (error) { next(error); }
});

app.post("/api/documents/:documentId/custody", async (req, res, next) => {
  try {
    const action = cleanReference(req.body.action, "Custody action");
    const { chain, actor, signer } = await actorFrom(req);
    const recipient = chain.actors.find((item) => item.key === req.body.toActor);
    if (!recipient) throw new Error("Choose a valid custody recipient");
    const transferred = await withWriteLock(async () => {
      const store = await loadStore();
      const indexed = findIndexedDocument(store, req.params.documentId);
      const receipt = await (await chain.contract.connect(signer).transferCustody(indexed.documentId, recipient.address, action)).wait();
      pushActivity(store, { type: "CUSTODY_TRANSFERRED", actor: actor.label, caseId: indexed.caseId, documentId: indexed.documentId, description: `Transferred custody to ${recipient.label}: ${action}`, ...txInfo(receipt) });
      await saveStore(store);
      return { to: recipient, ...txInfo(receipt) };
    });
    res.json(transferred);
  } catch (error) { next(error); }
});

app.post("/api/documents/:documentId/access", async (req, res, next) => {
  try {
    const { chain, actor, signer } = await actorFrom(req);
    const grantee = chain.actors.find((item) => item.key === req.body.granteeActor);
    if (!grantee) throw new Error("Choose a valid participant");
    const updated = await withWriteLock(async () => {
      const store = await loadStore();
      const indexed = findIndexedDocument(store, req.params.documentId);
      const method = req.body.grant === false ? "revokeAccess" : "grantAccess";
      const receipt = await (await chain.contract.connect(signer)[method](indexed.documentId, grantee.address)).wait();
      pushActivity(store, { type: method === "grantAccess" ? "ACCESS_GRANTED" : "ACCESS_REVOKED", actor: actor.label, caseId: indexed.caseId, documentId: indexed.documentId, description: `${method === "grantAccess" ? "Granted" : "Revoked"} access for ${grantee.label}`, ...txInfo(receipt) });
      await saveStore(store);
      return { action: method, grantee, ...txInfo(receipt) };
    });
    res.json(updated);
  } catch (error) { next(error); }
});

app.post("/api/documents/:documentId/seal", async (req, res, next) => {
  try {
    const { chain, actor, signer } = await actorFrom(req);
    const sealed = await withWriteLock(async () => {
      const store = await loadStore();
      const indexed = findIndexedDocument(store, req.params.documentId);
      const receipt = await (await chain.contract.connect(signer).sealDocument(indexed.documentId)).wait();
      pushActivity(store, { type: "DOCUMENT_SEALED", actor: actor.label, caseId: indexed.caseId, documentId: indexed.documentId, description: `Sealed ${indexed.title}; versions and custody are now immutable`, ...txInfo(receipt) });
      await saveStore(store);
      return { sealed: true, ...txInfo(receipt) };
    });
    res.json(sealed);
  } catch (error) { next(error); }
});

app.get("/api/documents/:documentId/download", async (req, res, next) => {
  try {
    const store = await loadStore();
    const indexed = findIndexedDocument(store, req.params.documentId);
    await ensureDocumentAccess(req, indexed.documentId);
    const version = req.query.version ? Number(req.query.version) : indexed.files.at(-1)?.version;
    const file = indexed.files.find((item) => item.version === version);
    if (!file) return res.status(404).json({ error: "File version not found in local storage" });
    const storedName = path.basename(file.storedName);
    const filePath = path.resolve(uploadDir, storedName);
    if (!filePath.startsWith(path.resolve(uploadDir) + path.sep)) return res.status(400).json({ error: "Invalid stored file path" });
    res.download(filePath, file.originalName || storedName);
  } catch (error) { next(error); }
});

app.get("/api/activity", async (req, res, next) => {
  try {
    const [store, { chain, actor }] = await Promise.all([loadStore(), actorFrom(req)]);
    const documentIds = [...new Set(store.activity.filter((entry) => entry.documentId).map((entry) => entry.documentId))];
    const flags = documentIds.length ? await chain.contract.hasAccessBatch(documentIds, actor.address) : [];
    const permittedDocumentIds = new Set(documentIds.filter((_, index) => flags[index]).map((id) => id.toLowerCase()));
    const activity = store.activity.filter((entry) => !entry.documentId || permittedDocumentIds.has(entry.documentId.toLowerCase()));
    res.json(activity.slice(0, 60));
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  const status = error.status || (error instanceof multer.MulterError ? 400 : 400);
  console.error(error);
  res.status(status).json({ error: errorMessage(error) });
});

getChain().then(async (chain) => {
  await ensureStoreForChain(chain);
  app.listen(port, "127.0.0.1", () => {
    console.log(`Evidence Registry API running at http://127.0.0.1:${port}`);
    console.log(`Contract deployed at ${chain.address} (${chain.embedded ? "embedded local chain" : "configured RPC"})`);
    console.table(chain.actors.map(({ key, role, address }) => ({ key, role, address })));
  });
}).catch((error) => {
  console.error("Unable to start Evidence Registry API:", error);
  process.exit(1);
});
