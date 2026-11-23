# Reproducible, Content-Addressed Static Build

OracleDesk supports bit-for-bit reproducible, content-addressed static builds (`next build` with `output: "export"`). This allows any operator or auditor to compile the frontend from source and verify that the resulting static files exactly match the published deployment.

## 1. Overview & Guarantees

- **Bit-for-Bit Determinism**: Given the same commit SHA, Node.js toolchain (`.nvmrc`), lockfile (`package-lock.json`), and release environment (`.env.release`), `next build` generates an identical set of static assets in `out/`.
- **Content Addressing**: Every file in the export is hashed using SHA-256 and recorded into a sorted, deterministic `manifest.json`.
- **IPFS Distribution**: The static export can be hosted on IPFS as a directory with a CIDv1 root.
- **What It Proves**: Proves the deployed static assets strictly originate from the audited git commit without build-step tampering.
- **What It Does NOT Prove**: It does not guarantee that dependencies or commit source code are free of logic vulnerabilities.

## 2. Dynamic Routes & Static Export

The application features client-side dynamic routes:
- `/agent/[address]`
- `/market/[id]/trades`
- `/market/[id]/trace-history`

Under static export (`output: "export"`), these routes export a fallback placeholder via `generateStaticParams()` and dynamically read route parameters on the client using `useParams()` from `next/navigation`.

## 3. Retired Routes

The 7 demo routes retired in Issue #49:
- `/wallet-demo` → `/portfolio/wallets`
- `/buy-yes-demo` → `/markets`
- `/buy-no-demo` → `/markets`
- `/execution-terminal` → `/markets`
- `/transaction-status` → `/tx`
- `/transaction-success` → `/tx`
- `/transaction-failed` → `/tx`

Because Next.js static export does not support server-level `redirects()`, these routes are served as static HTML pages (`<StaticRedirect>`) with standard `<meta http-equiv="refresh">` and client-side router redirects.

## 4. Release Environment (.env.release)

Next.js inlines `NEXT_PUBLIC_*` variables at compile time. To prevent environment drift:
- The authoritative release configuration is checked into `.env.release`.
- Verifiers and CI copy `.env.release` to `.env.production.local` before building.
- No secrets, private keys, or credentials exist in `.env.release`.

## 5. Local Verification Procedure

To verify a commit or release:

```bash
# Run verification script against any commit or tag
./scripts/verify-build.sh HEAD
```

The script:
1. Clones the commit into two separate clean directories.
2. Compiles using the pinned toolchain and `.env.release`.
3. Runs `scripts/generate-manifest.mjs`.
4. Performs a recursive `diff -r out/` to ensure bit-for-bit equality.

## 6. CI Deployment & Secrets Configuration

The GitHub Actions workflow `.github/workflows/publish-static-build.yml` triggers on release tags (`v*.*.*`) or manual dispatch.

### Required Secrets & Settings:
- **Sigstore OIDC**: Enabled via workflow `permissions: id-token: write` (no secrets needed for keyless signing).
- **IPFS Pinning (Optional)**: If automated IPFS publishing is desired, configure `IPFS_PINNING_SERVICE_TOKEN` in GitHub Repository Secrets.
