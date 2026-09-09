import crypto from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import ganache from "ganache";
import solc from "solc";
import { ethers } from "ethers";

const rootDir = process.cwd();
const mnemonic = "test test test test test test test test test test test junk";
const deploymentPath = path.join(rootDir, "data", "deployment.json");
const artifactCachePath = path.join(rootDir, "data", "EvidenceRegistry.artifact.json");

const actorSetup = [
  { key: "administrator", label: "System Administrator", role: "ADMIN", index: 0 },
  { key: "investigatingOfficer", label: "Investigating Officer", role: "OFFICER", index: 1 },
  { key: "forensicAnalyst", label: "Forensic Analyst", role: "FSL", index: 2 },
  { key: "prosecutor", label: "Public Prosecutor", role: "PROSECUTOR", index: 3 },
  { key: "courtClerk", label: "Court Clerk", role: "COURT", index: 4 }
];

let runtime;

function findImport(importPath) {
  const candidate = path.resolve(rootDir, "node_modules", importPath);
  try {
    return { contents: readFileSync(candidate, "utf8") };
  } catch {
    return { error: `Unable to resolve Solidity import: ${importPath}` };
  }
}

async function compileContract() {
  const source = await fs.readFile(path.join(rootDir, "contracts", "EvidenceRegistry.sol"), "utf8");
  const sourceHash = crypto.createHash("sha256").update(source).digest("hex");
  try {
    const cached = JSON.parse(await fs.readFile(artifactCachePath, "utf8"));
    if (cached.sourceHash === sourceHash && cached.abi && cached.bytecode) {
      return { abi: cached.abi, bytecode: cached.bytecode };
    }
  } catch { /* compile a fresh artifact */ }
  const input = {
    language: "Solidity",
    sources: { "EvidenceRegistry.sol": { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
    }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }));
  const errors = output.errors?.filter((item) => item.severity === "error") ?? [];
  if (errors.length) throw new Error(errors.map((item) => item.formattedMessage).join("\n"));
  const artifact = output.contracts["EvidenceRegistry.sol"].EvidenceRegistry;
  const compiled = { sourceHash, abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}` };
  await fs.mkdir(path.dirname(artifactCachePath), { recursive: true });
  await fs.writeFile(artifactCachePath, JSON.stringify(compiled));
  return compiled;
}

async function readDeployment() {
  try {
    return JSON.parse(await fs.readFile(deploymentPath, "utf8"));
  } catch {
    return null;
  }
}

async function saveDeployment(deployment) {
  await fs.mkdir(path.dirname(deploymentPath), { recursive: true });
  await fs.writeFile(deploymentPath, JSON.stringify(deployment, null, 2));
}

async function createProvider() {
  if (process.env.RPC_URL) {
    return { provider: new ethers.JsonRpcProvider(process.env.RPC_URL), embedded: false };
  }
  const eip1193 = ganache.provider({
    logging: { quiet: true },
    wallet: { mnemonic, totalAccounts: 10, defaultBalance: 1_000 },
    chain: { chainId: 1337 }
  });
  return { provider: new ethers.BrowserProvider(eip1193), embedded: true };
}

async function deployOrReuse(provider, artifact, forceDeploy) {
  const network = await provider.getNetwork();
  const existing = forceDeploy ? null : await readDeployment();
  if (existing?.chainId === network.chainId.toString()) {
    const code = await provider.getCode(existing.address);
    if (code !== "0x") return existing.address;
  }
  const deployer = await provider.getSigner(0);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
  const deployed = await factory.deploy();
  await deployed.waitForDeployment();
  const address = await deployed.getAddress();
  await saveDeployment({ address, chainId: network.chainId.toString(), deployedAt: new Date().toISOString() });
  return address;
}

async function configureRoles(contract, signers) {
  const admin = contract.connect(signers[0]);
  const roleByName = {
    OFFICER: await contract.OFFICER_ROLE(),
    FSL: await contract.FSL_ROLE(),
    PROSECUTOR: await contract.PROSECUTOR_ROLE(),
    COURT: await contract.COURT_ROLE()
  };
  for (const actor of actorSetup.filter((item) => item.role !== "ADMIN")) {
    const address = await signers[actor.index].getAddress();
    const role = roleByName[actor.role];
    if (!(await contract.hasRole(role, address))) {
      await (await admin.grantRole(role, address)).wait();
    }
  }
}

export async function getChain() {
  if (runtime) return runtime;
  const artifact = await compileContract();
  const { provider, embedded } = await createProvider();
  const signers = await Promise.all(actorSetup.map((actor) => provider.getSigner(actor.index)));
  const address = await deployOrReuse(provider, artifact, process.env.RESET_CHAIN === "true" || embedded);
  const contract = new ethers.Contract(address, artifact.abi, provider);
  await configureRoles(contract, signers);
  const actors = await Promise.all(actorSetup.map(async (actor) => ({
    key: actor.key,
    label: actor.label,
    role: actor.role,
    address: await signers[actor.index].getAddress()
  })));
  // Embedded Ganache is recreated on every API start. Its deterministic
  // accounts can produce the same contract address, so retain a per-process
  // identity to stop the local index from surviving a fresh chain.
  runtime = { provider, contract, signers, actors, embedded, address, abi: artifact.abi, sessionId: embedded ? crypto.randomUUID() : address.toLowerCase() };
  return runtime;
}

export const documentTypes = ["FIR", "WITNESS_STATEMENT", "CHARGESHEET", "FORENSIC_REPORT", "COURT_ORDER", "OTHER"];
export const caseStatuses = ["OPEN", "UNDER_TRIAL", "CLOSED", "ARCHIVED"];
export const asNumber = (value) => Number(value);
export const toHexId = (namespace, reference) => ethers.keccak256(ethers.toUtf8Bytes(`${namespace}:${reference.trim().toUpperCase()}`));
export const sha256 = (data) => ethers.sha256(data);

export async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return `0x${hash.digest("hex")}`;
}
