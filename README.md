# RepoScope

RepoScope is a full-stack repository intelligence application. It retrieves public GitHub data through the official REST API, samples repository source and configuration files, and presents maintainable, evidence-based analysis in a responsive dashboard.

## Features

- Repository metadata, topics, language byte totals, recursive tree, and default-branch commit history
- Source and configuration file sampling with line estimates and file explorer
- Commit classification, contributor counts, and monthly activity
- Technology fingerprints from manifests and configuration
- Deterministic AI Generation Confidence estimates with signal breakdown, evidence, and limitations
- Optional safe public website inspection and technology overlap comparison
- Internal Project Health Heuristic
- JSON report export
- Optional in-memory ZIP upload analysis with no extraction or code execution
- Typed NDJSON progress events and separate source, evidence-confidence, and repository-coverage metrics
- Five-minute in-memory GitHub caching and configurable, balanced file sampling

## Architecture

```text
React + TypeScript + Vite
  → Express API (typed NDJSON analysis progress)
    → Repository analyzer
      → GitHub REST service adapters (repository, tree, languages, commits)
      → deterministic analyzers (AI signals, health, technology)
      → optional public website inspector
```

The browser receives normalized internal report objects, not GitHub API responses. GitHub access and `GITHUB_TOKEN` remain server-side. The analyzer boundary allows future implementations without a frontend dependency on a specific provider.

## Requirements and setup

- Node.js 20 or newer
- npm

```sh
npm install
cp .env.example .env
npm run dev
```

The web app runs at `http://localhost:5173`; the API runs at `http://localhost:5000`.

### Environment

| Variable | Purpose |
| --- | --- |
| `GITHUB_TOKEN` | Optional server-side GitHub token. Public repositories work without it, subject to GitHub's unauthenticated rate limits. |
| `PORT` | API port (default `5000`). |
| `CLIENT_ORIGIN` | Allowed browser origin for CORS (default `http://localhost:5173`). |
| `ANALYSIS_MAX_FILES` | Source/config files sampled per analysis (default `25`, hard cap `500`). |
| `ANALYSIS_MAX_FILE_BYTES` | Maximum bytes read per source file (default `250000`, hard cap `2000000`). |
| `ZIP_MAX_UPLOAD_BYTES` | Maximum uploaded ZIP size (default `26214400`, hard cap `104857600`). |
| `ZIP_MAX_ENTRIES` | Maximum archive files and folders (default `3000`, hard cap `20000`). |
| `ZIP_MAX_UNCOMPRESSED_BYTES` | Maximum total expanded archive size (default `104857600`, hard cap `524288000`). |
| `ZIP_MAX_COMPRESSION_RATIO` | Maximum allowed expansion ratio for large archive entries (default `200`, hard cap `1000`). |

Use a fine-grained token with read access to public repositories. Never put this value in a `VITE_` variable or browser code. Copy `.env.example` to `.env` and keep `.env` untracked.

## Commands

```sh
npm run dev       # Vite and API in watch mode
npm run build     # Type-check client, build client and compile server
npm start         # Start compiled API
npm test          # Run analyzer, API integration, and UI accessibility-contract tests
```

For production, serve the Vite `dist/` output with a static host and run the compiled API behind the same origin or configure the frontend proxy at the deployment edge. Set `CLIENT_ORIGIN` to the exact trusted origin.

## API

### `GET /api/health`

Returns `{ "status": "ok" }`.

### `POST /api/analyze`

Request JSON:

```json
{
  "repositoryUrl": "https://github.com/owner/repository",
  "websiteUrl": "https://example.com"
}
```

`websiteUrl` is optional. The response is newline-delimited JSON with typed progress events, then one `type: result` record with an analysis id and normalized report, or a safe `type: error` record. The UI consumes the stream without reloading. Progress includes actual stage status and observed file/commit counts.

### `GET /api/analysis/:id`

Returns a recent in-memory report. Reports are process-local and are evicted after the cache exceeds 50 entries or when the process restarts.

### `POST /api/analyze/zip`

Multipart form-data with one `archive` field containing a `.zip` file. The endpoint validates archive paths, symlinks, entry counts, declared expansion size, and suspicious compression ratios. It reads eligible UTF-8 source/config files in memory, never extracts the archive, and never runs uploaded code. The stream reports ZIP-specific progress; commit-history steps are omitted.

## Analysis limits and methodology

- GitHub repository trees use the recursive Git Trees API. GitHub may mark a large tree as truncated; that state is surfaced in the dashboard.
- Up to 500 default-branch commits are retrieved. Detailed additions/deletions/files changed are requested for the latest 20 commits to bound API usage; unavailable details are shown as unavailable.
- `ANALYSIS_MAX_FILES` source/configuration files are sampled using configuration prioritization and round-robin source-folder sampling. Per-file byte limits are also configurable. `analysisFiles` records analyzed, skipped, and inaccessible paths with reasons. README files provide context but are excluded from ordinary source signals. Lockfiles, generated/minified files, vendored/dependency folders, build output, unsupported formats, binary content, and oversized files are excluded and reported.
- GitHub trees can be truncated. In that case repository discovery coverage is marked incomplete and evidence confidence is reduced. GitHub content-fetch failures remain visible as inaccessible rather than becoming empty source. Commit history is bounded to the latest 500 commits and detailed additions/deletions are fetched for the latest 20; the report discloses the retrieved and detailed counts.
- ZIP uploads default to 25 MiB compressed, 3,000 entries, and 100 MiB total declared expanded content. Per-file and sampled-file limits use the analysis settings above. Runtime hard caps prevent unsafe configuration values. Upload bytes are held in memory only and cleared after request processing; no temporary extraction directory is created.
- Language shares use GitHub's language API byte totals.
- Technology detection is based on observed manifests/configuration and limited source fingerprints; absence means unable to determine.
- Website checks use public HTTP(S) GET requests, reject credentials/local hostnames, disable redirects, apply a timeout, and inspect at most the first 1 MB of HTML. The site can still be unreachable or block automated clients.

### AI-generation estimate and evidence confidence

The observed signal score combines available evidence using normalized weights: explicit AI/tool attribution in a source comment (40%), exact repeated four-line blocks across files (15%), repeated multi-property object shapes (10%), commit-change concentration (20%), and a short generic commit-message list (15%). Signals requiring missing commit metadata are excluded and remaining available signals are reweighted; missing history therefore does not lower the source-signal score by itself. Repeated structures and commit patterns are weak observations with common human-written explanations. README text is excluded from source-code evidence.

The dashboard distinguishes three concepts:

- **AI-generation estimate:** a deterministic observed-signal score and band, not a statistically calibrated probability.
- **Evidence confidence:** completeness of the source sample and available GitHub metadata. ZIP reports mark commit history not applicable.
- **Analysis/repository coverage:** discovered, eligible, analyzed, skipped, inaccessible files, and retrieved/detailed commit counts.

When there is too little readable source or history to support even a descriptive repository-level estimate, the report says **Insufficient evidence**. The same heuristic output is deterministic for identical inputs. Tests use a hand-written local fixture (origin documented inline) and a synthetic, explicitly attributed marker fixture; these fixtures verify behavior and are not a validated AI-vs-human benchmark.

**The AI-generation score is a heuristic and is not proof of AI authorship.** Similar code can result from templates, conventions, generated files, or human work. A low score does not prove that AI was not used. Sampling and incomplete history can affect the result.

### Project health

The Project Health Score is an internal heuristic informed by README presence, tests, CI configuration, source structure, commit history, and recent activity. It is not an industry standard or a substitute for a security, quality, or maintenance review.

## Security and privacy

- GitHub tokens are only read by the server and are not returned to the client or included in application logs.
- Only public GitHub repositories can be analyzed unless the server token has access; private repository support is not exposed by the URL-only flow.
- Website analysis is limited to public page metadata and resource fingerprints. It does not scan ports, bypass authentication, or exploit the target.
- No source is sent to an external AI service. The deterministic heuristic runs locally in the application server.
- ZIP handling uses in-memory multipart uploads and streaming entry reads. Path traversal and symlink entries are rejected; source is never extracted or executed. Keep the configurable upload and expansion limits appropriate for the host.
- Public website DNS results are validated and the selected public address is pinned for the HTTP request; redirects are not followed. Continue to apply outbound network restrictions in production.
- Website URLs are untrusted input. For public production deployments, enforce egress firewall rules that block private, link-local, and metadata IP ranges as an additional SSRF boundary.

## Current limitations / future improvements

Analysis is limited to the default branch and a bounded recent commit sample. Source heuristics are not a reliable authorship detector and have not been calibrated against a representative labeled corpus. ZIP archives have no Git history unless a user separately analyzes the repository through GitHub. Browser screenshot automation is not included in the current toolchain; layout adapts at desktop, tablet, and mobile breakpoints and the reveal/ambient effects respect `prefers-reduced-motion`.
