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
- Five-minute in-memory caching and bounded file/commit analysis

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

Use a fine-grained token with read access to public repositories. Never put this value in a `VITE_` variable or browser code. Copy `.env.example` to `.env` and keep `.env` untracked.

## Commands

```sh
npm run dev       # Vite and API in watch mode
npm run build     # Type-check client, build client and compile server
npm start         # Start compiled API
npm test          # Run deterministic analyzer tests
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

`websiteUrl` is optional. The response is newline-delimited JSON: progress records (`type: progress`), then one `type: result` record with an analysis id and normalized report, or a safe `type: error` record. The UI consumes this stream without reloading.

### `GET /api/analysis/:id`

Returns a recent in-memory report. Reports are process-local and are evicted after the cache exceeds 50 entries or when the process restarts.

## Analysis limits and methodology

- GitHub repository trees use the recursive Git Trees API. GitHub may mark a large tree as truncated; that state is surfaced in the dashboard.
- Up to 500 default-branch commits are retrieved. Detailed additions/deletions/files changed are requested for the latest 20 commits to bound API usage; unavailable details are shown as unavailable.
- Up to 20 source/configuration files are sampled for content analysis. The displayed line count is an estimate from sampled non-empty source lines, not a complete repository total. Binary media and common generated/dependency directories are excluded from content sampling.
- Language shares use GitHub's language API byte totals.
- Technology detection is based on observed manifests/configuration and limited source fingerprints; absence means unable to determine.
- Website checks use public HTTP(S) GET requests, reject credentials/local hostnames, disable redirects, apply a timeout, and inspect at most the first 1 MB of HTML. The site can still be unreachable or block automated clients.

### AI Generation Confidence

The score is a deterministic weighted combination of observable signals: code repetition and generic naming, large commit additions, README structure, repository evolution, repeated structures, and boilerplate markers. It includes signal scores and evidence so users can inspect what influenced it.

**The AI-generation score is a heuristic and is not proof of AI authorship.** Similar code can result from templates, conventions, generated files, or human work. A low score does not prove that AI was not used. Sampling and incomplete history can affect the result.

### Project health

The Project Health Score is an internal heuristic informed by README presence, tests, CI configuration, source structure, commit history, and recent activity. It is not an industry standard or a substitute for a security, quality, or maintenance review.

## Security and privacy

- GitHub tokens are only read by the server and are not returned to the client or included in application logs.
- Only public GitHub repositories can be analyzed unless the server token has access; private repository support is not exposed by the URL-only flow.
- Website analysis is limited to public page metadata and resource fingerprints. It does not scan ports, bypass authentication, or exploit the target.
- No source is sent to an external AI service. The AI heuristic runs locally in the application server.
- Website URLs are untrusted input. For public production deployments, enforce egress firewall rules that block private, link-local, and metadata IP ranges as an additional SSRF boundary.

## Current limitations / future improvements

The initial release focuses on default-branch evidence and bounded samples. Potential follow-ups include pagination controls for older commits, a persistent cache, contributor endpoint enrichment, fuller language-aware LOC/comment parsing, HTML/PDF export, and stricter DNS/IP egress validation for website checks.
