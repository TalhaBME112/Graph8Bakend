# Graph8 Workspace

Angular frontend and Node.js backend for the Graph8-connected tender marketplace, BidFlow, Buyer Deal Rooms, Campaign Learning Lab, and Run My Goal.

The working application is in `Graph8Frontend/`. Its Node server provides the application API and serves the compiled frontend. `Graph8Bakend/` contains the original ASP.NET starter project.

## Run locally

Requires Node.js 20.19+ and npm.

```powershell
cd Graph8Frontend
npm ci
Copy-Item .env.example .env
# Set G8_API_KEY in .env using your own Graph8 credential.
npm run build
npm run server
```

Open http://localhost:4301/#tenders. See [the application README](Graph8Frontend/README.md) for workflow details, configuration, and limitations.

## Tests

```powershell
cd Graph8Frontend
npm run test:server
npm run test:market-browser
npm run test:e2e
```

Local API keys, accounts, uploaded documents, databases, encryption keys, logs, and build artifacts are excluded from Git. A fresh checkout starts without the local test accounts or tender records. Configure the server credential and use the application bootstrap flow to create its first administrator.
