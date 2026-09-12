# NyayaVault — Secure Legal Evidence DMS

Local prototype of a **Secure Digital Document Management System** for FIRs, investigation records, witness statements, charge sheets, forensic reports, court filings, and judgments. Evidence files stay off-chain; SHA-256 hashes, versions, custody, access grants, and judicial seals are recorded on `EvidenceRegistry`.

This is a hackathon-style demo, not production evidence storage.

## Run locally

```bash
cp .env.example .env
npm install
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). API: `http://127.0.0.1:3001`.

```bash
npm run smoke
```

## Demo sign-in

Identity is a **session**, not a dropdown. Passwords are hashed with scrypt; cookies are HttpOnly.

| Role | Username | Password |
| --- | --- | --- |
| System Administrator | `admin` | `Nyaya@Admin` |
| Investigating Officer | `officer` | `Nyaya@Officer` |
| Forensic Analyst | `forensic` | `Nyaya@Fsl` |
| Public Prosecutor | `prosecutor` | `Nyaya@Prosecutor` |
| Court Clerk | `court` | `Nyaya@Court` |

Officers and admin can open cases and register documents. Court and admin change case status. Only the court role seals a document. Custodians add versions and transfer custody after they hold the file.

Document access is deliberately strict: even the administrator must receive an on-chain access grant before opening or downloading a document. A current custodian’s own read access cannot be revoked, preventing an inconsistent state where they can modify evidence but cannot retrieve it.

## What the prototype shows

- Authenticated access bound to on-chain roles
- Contract-enforced document access for every role; the API never bypasses it
- Case desk with explicit `openCase` / `caseExists` on the contract
- Document intake, versioning, custody handoff, grants/revokes, integrity verify, judicial seal
- Search and filter across the local ledger
- Audit log of chain-backed actions
- Authority-aware AI assistant with permission-filtered retrieval, safe local fallback, and optional Responses API generation

## Architecture

```text
React / Vite dashboard  →  Express API (session auth)  →  ethers.js  →  Ganache / EVM
                              │                 │
                              └─ uploads/        └─ EvidenceRegistry.sol
                                 data/              hashes + audit state only
```

## Important boundaries

Server-held demo keys, unencrypted local files, and an embedded chain that resets on API restart. Before any real deployment: IdP, wallet/HSM signatures, encrypted object storage, malware scanning, and legal review.

The local API only accepts browser requests from `CLIENT_ORIGIN` (default: `http://127.0.0.1:5173`); change that value in `.env` if you host the dashboard elsewhere. The embedded-chain session is detected on startup, so stale local index rows are cleared after the chain restarts.

## Authority-aware AI assistant

The **AI Access Copilot** gets its identity from the authenticated server session, then checks every document against the existing on-chain `hasAccess` permission before it ranks or describes anything. It works with the existing authorization layer; it does not grant access, search the unfiltered registry, or receive evidence-file contents. It only returns actions the current participant can perform under the contract's current custodian, role, sealed-state, and case-status rules. Questions and document metadata are treated as untrusted data, and AI audit entries retain neither prompts nor evidence content.

It works locally without an API key. To enable optional hosted natural-language generation, add `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`) to `.env`. The hosted request uses `store: false` and receives only the already-authorized, minimal metadata context. The official [Responses API reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create) documents the endpoint and `store` option; model availability is account-dependent.
