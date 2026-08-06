# ACME Client Intake Automation

Local-first, cloud-connected workflow automation for collecting customer information, tracking case progress, and routing documents from WhatsApp to Google Drive.

This project demonstrates a pragmatic DevOps approach to a real ACME business problem: reducing repetitive follow-up, manual document handling, and incomplete customer files without introducing unnecessary infrastructure.

> **Status:** Functional MVP  
> **Runtime:** Windows workstation  
> **Architecture:** Local application + managed cloud storage  
> **Primary interface:** WhatsApp and a local operations dashboard

## Business problem

ACME personnel need to collect long, structured sets of customer information and supporting documents. A completely manual process creates recurring problems:

- Customers are asked for information they already provided in a document.
- Conversations are interrupted and difficult to resume consistently.
- Missing answers are tracked manually.
- Documents must be downloaded, renamed, and organized by hand.
- Staff lack a single view of case status and completion.

The solution turns that process into a persistent, auditable workflow while preserving human review where it adds value.

## Solution overview

- The bot remains silent until the operator sends the exact command `INICIAR BOT` in an individual customer chat.
- Unknown contacts, status messages, broadcasts, and groups receive no automated response.
- ACME obtains the customer's signed authorization before the operator starts the bot; the chat does not repeat that authorization step.
- Questions are delivered one at a time and validated according to their data type.
- Every response and conversation position is persisted, allowing interruption and recovery at any moment.
- Customers can use `SALTAR`, `ALTO`/`PAUSA`/`PAUSAR`/`DETENTE`/`PARA`, `CONTINUAR`, `RESUMEN`, and `PENDIENTES`.
- Passport images and PDF files are placed in a dedicated Google Drive folder for each customer.
- Passport fields are flagged for manual staff review instead of asking the customer to transcribe information already visible in the document.
- A local dashboard exposes case status, completion, answers, notes, custom fields, and Drive links.

This phase intentionally excludes health, criminal, political, government, organizational, and military questions. It does not use OCR or generative AI.

## Architecture

```mermaid
flowchart LR
    O[ACME operator] -->|INICIAR BOT| WA[WhatsApp account]
    C[Customer] <--> WA
    WA <--> WJS[whatsapp-web.js]
    WJS --> FSM[Conversation state engine]
    FSM <--> DB[(SQLite + WAL)]
    WJS --> Q[Persistent document queue]
    Q -->|OAuth 2.0| GD[Google Drive]
    DB <--> API[Fastify local API]
    API <--> UI[Operations dashboard]
    DB --> BK[Consistent local backups]
```

The architecture is deliberately hybrid:

- **Local control plane:** customer records, workflow state, audit events, sessions, and the dashboard remain on the ACME workstation.
- **Cloud document plane:** customer files are organized in Google Drive using narrowly scoped OAuth access.
- **No container dependency:** the MVP runs directly on Windows with Node.js.
- **No database server:** SQLite provides transactions and safe concurrent access while remaining a single portable file.

Detailed design: [architecture](docs/architecture.md) and [engineering decisions](docs/decisions.md).

## Reliability and security controls

- SQLite WAL mode, foreign keys, transactions, and busy-timeout configuration.
- Idempotent WhatsApp message processing.
- Persistent document queue with recovery and exponential retry.
- File-type and file-size validation before upload.
- AES-256-GCM encryption for the Google OAuth token.
- Serialized token writes with Windows-safe replacement and stale-file cleanup.
- Persistent WhatsApp `LocalAuth` session.
- Loopback-only dashboard binding; the application rejects public network binding.
- OAuth request logging disabled so authorization codes do not appear in console output.
- Application data, credentials, sessions, databases, and build output excluded from Git.
- Automated type checking, tests, compilation, dependency auditing, and HTTP smoke testing.

## Technology stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 24 LTS + TypeScript |
| Local API | Fastify |
| Persistence | Built-in `node:sqlite` |
| Messaging | `whatsapp-web.js` + Puppeteer |
| Cloud storage | Google Drive API + OAuth 2.0 |
| Validation | Zod + domain validators |
| Dashboard | Semantic HTML, CSS, and browser JavaScript |
| Quality gates | Node test runner, TypeScript, npm audit, smoke test |

## Repository structure

```text
src/
  domain/                 Conversation engine, field catalog and validation
  infrastructure/         SQLite, WhatsApp, Google Drive and token encryption
  config.ts               Validated environment configuration
  server.ts               Local API and dashboard server
public/                    Operations dashboard
scripts/                   Setup, clean and smoke-test utilities
test/                      Domain and infrastructure tests
docs/                      Architecture and engineering decisions
```

## Local setup

### Prerequisites

- Windows 10 or Windows 11.
- Node.js 24 LTS.
- Google Chrome or Microsoft Edge.
- A dedicated WhatsApp account is recommended.
- A Google Cloud project with Google Drive API enabled.

### 1. Install and create local configuration

```powershell
npm.cmd install
npm.cmd run setup
```

The setup command copies `.env.example` to `.env` and generates a unique encryption key. Never commit `.env`.

### 2. Configure Google OAuth

Create an OAuth 2.0 client of type **Web application** and register a redirect URI that exactly matches the local configuration. Example:

```text
PORT=3188
GOOGLE_REDIRECT_URI=http://127.0.0.1:3188/auth/google/callback
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
ORGANIZATION_NAME=ACME
```

The full callback belongs under **Authorized redirect URIs**. If a JavaScript origin is configured, it contains only `http://127.0.0.1:3188`.

### 3. Start the application

Double-click `INICIAR_MVP.cmd` or run:

```powershell
npm.cmd run dev
```

Open `http://127.0.0.1:<PORT>`, authorize Google Drive, and scan the WhatsApp QR code.

### 4. Install automatic Windows startup

After the first successful interactive connection, install the supervised production task:

```powershell
npm.cmd run windows:install
```

The task starts at Windows sign-in under the current user, without storing the Windows password. Its supervisor:

- builds and launches the production application with a hidden window;
- prevents duplicate bot instances;
- restarts Node after a crash;
- probes the local API and WhatsApp runtime every 15 seconds;
- restarts the process after three consecutive unhealthy checks;
- relies on SQLite transactions, the persisted conversation cursor, the document queue, LocalAuth, and the encrypted Drive token to resume safely.

Check it at any time with:

```powershell
npm.cmd run windows:status
```

Supervisor and application logs are stored in `.data/logs/`.

## Operational workflow

1. The operator opens an individual WhatsApp conversation.
2. The operator sends `INICIAR BOT` from the linked account.
3. The bot begins immediately because ACME already holds the signed authorization.
4. The state engine asks only the next applicable question.
5. A passport photo or PDF is queued and uploaded to the customer's Drive folder.
6. Staff complete passport-derived fields manually from the dashboard.
7. The dashboard tracks completion and highlights cases requiring review.

Sending `INICIAR BOT` again does not reset an active case.

## Customer commands

| Command | Behavior |
|---|---|
| `SALTAR` | Marks the current answer as pending and advances |
| `PAUSAR` | Stops questions without losing progress |
| `ALTO`, `PAUSA`, `DETENTE`, `PARA` | Pause aliases with the same behavior as `PAUSAR` |
| `CONTINUAR` | Resumes from persisted state |
| `RESUMEN` | Returns completion by section |
| `PENDIENTES` | Lists missing customer-provided information |
| `AYUDA` | Displays available commands |
| `BORRAR MIS DATOS` | Creates a staff-reviewed deletion request |

## Quality gates

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run smoke
npm.cmd audit --audit-level=high
```

GitHub Actions runs dependency auditing, type checking, the automated test suite, a clean production build, and an HTTP smoke test on every push and pull request.

## Local data and recovery

Runtime data is written under `.data/`:

```text
.data/
  bot.sqlite               Customer data and workflow state
  whatsapp-session/        Persistent linked-device session
  google-token.enc         Encrypted Google OAuth credentials
  backups/                 On-demand SQLite backups
  logs/                    Windows supervisor and production logs
```

The live SQLite database should not be synchronized directly by OneDrive or another file-sync agent. Back up closed or application-generated copies to a separate encrypted location.

## Evolution path

The local architecture remains appropriate while one operator uses one workstation. A future platform phase would be triggered by remote access, multiple staff members, high availability, or centralized operations. That phase could introduce:

- Scheduled encrypted off-device backups.
- Authentication, MFA, and role-based access control.
- Centralized metrics, structured logs, and alerting.
- Managed PostgreSQL and object storage for multi-user access.
- A supported messaging API if operational risk outweighs the convenience of WhatsApp Web.
- Automated retention and verified deletion workflows.

## Constraints

`whatsapp-web.js` is not affiliated with or officially supported by WhatsApp. The integration can require maintenance after WhatsApp Web changes, and account restrictions remain possible. This project should use a dedicated account and must not be used for unsolicited or bulk messaging.

The dashboard is intentionally local and has no remote-user authentication. Do not expose it directly to the Internet by changing the host binding.
