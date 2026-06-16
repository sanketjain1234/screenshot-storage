# Implementation Plan — Test Script Generator

## Overview

A **NestJS REST API** that accepts a screen recording (file upload or public URL), processes it through the Gemini Video Understanding API, extracts steps with timestamps, captures screenshots via ffmpeg, and returns a structured test script. No frontend — the contract is the API, documented via Swagger/OpenAPI at `/api/docs`.

---

## 1. API Consumer Journey

```
[Optional: save a column config]
  POST /column-configs  →  { configId }

         ┌──────────────────────────────────┐
         │  Choose one input method         │
         │                                  │
         │  A) POST /jobs/upload            │
         │     (multipart video file)       │
         │                                  │
         │  B) POST /jobs/from-url          │
         │     ({ url, configId? })         │
         └──────────────────────────────────┘
                        │
                        ▼
         { jobId, status: "PENDING" }   ← returns immediately

[Poll for result]
  GET /jobs/:jobId
  →  { jobId, status, steps?, error? }

[On COMPLETED]
  {
    jobId,
    status: "COMPLETED",
    steps: [
      {
        stepNumber, action, description,
        expectedResult, timestampSeconds,
        screenshotBase64,
        ...customColumns   ← from saved ColumnConfig
      }
    ]
  }
```

### Why async (job pattern) over sync response
- Gemini processing + ffmpeg extraction takes **10–60s**.
- A synchronous response timeouts at load balancers (typically 30s default) and is not retriable.
- The job pattern is observable, retriable, and the API contract stays stable even if we add a queue later.

---

## 2. Handling Video Files

### Method A — File Upload (`POST /jobs/upload`)
- Accepts `multipart/form-data` with a `video` field and an optional `configId` field.
- Multer writes to a **temp directory on disk** (never to memory — videos can be large).
- Multer enforces `fileSize` limit at the HTTP layer before any processing begins.

### Method B — Public URL (`POST /jobs/from-url`)
- Accepts JSON body `{ url: string, configId?: string }`.
- Backend downloads the video server-side — the API key never touches the client.
- URL validation is kept simple: **domain whitelist** of commonly used video hosting services.

**Whitelisted domains:**
```
drive.google.com
dl.dropboxusercontent.com / dropbox.com
storage.googleapis.com
s3.amazonaws.com / *.s3.amazonaws.com
loom.com / www.loom.com
```

Direct video URLs (ending in `.mp4`, `.mov`, `.webm`) from any domain are also accepted.
Any URL not matching the whitelist or a direct video extension is rejected with `400 Bad Request`.

> This is intentionally simple. Full SSRF protection (private IP blocking, etc.) is tracked in **Future Work**.

### Video Validations (both methods, before any Gemini call)

| Check | Limit | How |
|---|---|---|
| File size | ≤ 200MB | Multer fileSize limit / response body size check on download |
| Duration | ≤ 3 minutes | ffprobe metadata read on the temp file |
| MIME type | `mp4`, `mov`, `webm`, `avi` | Extension check + ffprobe codec check |
| Duplicate | SHA-256 must not match a known job | In-memory hash cache |

All failures return **422 Unprocessable Entity** before any Gemini tokens are spent.

### Processing Pipeline (runs async, after job is created)

```
[Temp file on disk]
        │
        ├──► Compute SHA-256 → check dedup cache
        │         └── if duplicate → return existing jobId, skip all below
        │
        ├──► Validate duration + MIME (ffprobe)
        │
        ├──► Upload to Gemini Files API → poll until ACTIVE
        │
        ├──► generateContent → JSON steps[] with timestamps
        │
        ├──► Extract one PNG frame per timestamp (ffmpeg) → base64
        │
        ├──► Store result in JobRepository
        │
        └──► Cleanup temp file (always, in finally block)
```

---

## 3. Gemini API Usage

### Step 1 — Upload to Gemini Files API

```
POST https://generativelanguage.googleapis.com/upload/v1beta/files
  → { file: { uri, name, state: "PROCESSING" } }

Poll GET /v1beta/files/{name}  until  state === "ACTIVE"
```

The `geminiFileUri` is stored on the job record. If the same video is re-processed with a different column config, we reuse the existing URI instead of re-uploading.

### Step 2 — Extract steps with a dynamic prompt

Model: **`gemini-2.0-flash`** — fast and cost-effective for short videos.

```
You are analyzing a screen recording of a software process.
Extract every distinct user action as a step.

Return ONLY a valid JSON array. Each element must have:
- stepNumber: integer (1-indexed)
- action: short imperative phrase (e.g. "Click 'Create Order' button")
- description: 1–2 sentence description of what happens
- expectedResult: observable outcome after this action
- timestampSeconds: number (video time when the action occurs)
{CUSTOM_COLUMNS_BLOCK}

No markdown fences, no prose. JSON array only.
```

`{CUSTOM_COLUMNS_BLOCK}` is injected from the saved `ColumnConfig` at request time. Example:
```
- preconditions: any preconditions required before this step
- priority: one of "High", "Medium", "Low"
```

### Step 3 — Screenshot extraction via ffmpeg

```bash
ffmpeg -ss {timestampSeconds} -i {videoPath} -frames:v 1 -q:v 2 {outPath}.png
```

One frame per step. Encoded as base64, stored inline in the step result.

**Why not ask Gemini for screenshots directly?** Gemini tells us *when* something happens (timestamp) but cannot return *image data* from a video. ffmpeg extracts the exact frame deterministically and for free.

---

## 4. Gemini API Capability Analysis

### Strengths
| Capability | Assessment |
|---|---|
| Understanding UI flows and context | ✅ Excellent |
| Natural language step/description generation | ✅ Excellent |
| Timestamp identification for discrete actions | ✅ Good (±1–2s) |
| Structured JSON output via explicit prompting | ✅ Reliable with schema in prompt |
| Short screen recordings (<3 min) | ✅ Well within context limits |

### Limitations & Current Mitigations
| Limitation | Impact | Mitigation |
|---|---|---|
| Timestamp accuracy ±1–2s | Screenshot may capture slightly wrong frame | Acceptable for MVP |
| Rapid clicks may be merged into one step | Incomplete step list | Prompt asks for granularity |
| Malformed JSON from Gemini | Job fails at parse | Zod validation + up to 2 auto-retries |
| API latency 10–30s per video | N/A | Absorbed by async job pattern |
| Cannot return image data from video | Needs ffmpeg | Covered by ffmpeg extraction |

### Verdict
Sufficient for this use case. The async pattern removes latency as a concern. Timestamp drift is the only irreducible gap and is acceptable at this stage.

---

## 5. In-Memory Stores — Repository Pattern (SOLID: D)

**Rule**: no service touches a `Map` directly. All state access goes through typed interfaces. Swapping to Redis or Postgres later is a single provider replacement — zero changes in service code.

### Interfaces

```typescript
interface IJobRepository {
  create(job: Job): void;
  findById(id: string): Job | undefined;
  update(id: string, patch: Partial<Job>): void;
}

interface IColumnConfigRepository {
  create(config: ColumnConfig): string;           // returns configId
  findById(id: string): ColumnConfig | undefined;
  update(id: string, patch: Partial<ColumnConfig>): void;
  delete(id: string): void;
  findAll(): ColumnConfig[];
}

interface IVideoHashRepository {
  set(sha256: string, jobId: string): void;
  get(sha256: string): string | undefined;
}
```

### Job shape

```typescript
type JobStatus =
  | 'PENDING'
  | 'VALIDATING'
  | 'UPLOADING_TO_GEMINI'
  | 'PROCESSING'
  | 'EXTRACTING_SCREENSHOTS'
  | 'COMPLETED'
  | 'FAILED';

interface Job {
  id: string;             // UUID v4
  status: JobStatus;
  videoHash?: string;     // SHA-256 — used for dedup
  geminiFileUri?: string; // cached to avoid re-upload
  result?: Step[];
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

Each interface has one concrete in-memory implementation (`Map<string, T>`). The implementation is the only thing that changes when moving to Redis or Postgres.

---

## 6. SOLID Principles Applied

| Principle | How it's applied |
|---|---|
| **S** — Single Responsibility | Each service owns exactly one concern: `GeminiService` only talks to Gemini, `ScreenshotService` only runs ffmpeg, `VideoService` only handles download/validation/hashing. `JobsService` only orchestrates. |
| **O** — Open/Closed | Adding a new video input method (e.g. Google Drive picker) only requires a new method in `VideoService` — no existing code changes. Custom columns are additive prompt injections. |
| **L** — Liskov Substitution | `InMemoryJobRepository` and a future `RedisJobRepository` are fully substitutable — both satisfy `IJobRepository`. |
| **I** — Interface Segregation | `IJobRepository`, `IColumnConfigRepository`, and `IVideoHashRepository` are kept separate. No service receives a fat interface with methods it doesn't use. |
| **D** — Dependency Inversion | All services depend on interfaces (injected via NestJS DI tokens), not concrete classes. `JobsService` never knows whether storage is a `Map` or Redis. |

---

## 7. API Keys & Secrets

- `GEMINI_API_KEY` lives **only** in `.env` (local) or environment variables (deployed).
- `.env` is in `.gitignore` — it never goes to Git.
- `.env.example` (committed, safe) documents the required variables without values:
  ```
  GEMINI_API_KEY=
  PORT=3000
  MAX_FILE_SIZE_MB=200
  TEMP_DIR=/tmp
  ```
- `@nestjs/config` with Joi validation ensures the server **refuses to start** if required env vars are missing — no silent runtime failures from a missing key.

---

## 8. Swagger / OpenAPI

### Approach: Code-First with `@nestjs/swagger`

We use **code-first** Swagger generation. Decorators on DTOs and controllers produce a live, always-in-sync OpenAPI spec. The alternative — writing an `openapi.yaml` first and generating types from it (design-first) — is better for large teams or public APIs where the spec is a formal contract. For this project (internal NestJS backend, single team), code-first is the right trade-off: less tooling, zero drift, and DTOs serve double duty for both validation and documentation.

Swagger UI is served at **`/api/docs`**. Since there is no frontend, this is the primary consumer interface.

### How decorators are applied

**Controllers** — grouping and operation metadata:
```typescript
@ApiTags('Jobs')
@Controller('jobs')
export class JobsController {

  @Post('upload')
  @ApiOperation({ summary: 'Upload a video file for processing' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadJobDto })
  @ApiResponse({ status: 202, description: 'Job created', type: JobResponseDto })
  @ApiResponse({ status: 422, description: 'Validation failed (size, duration, duplicate)' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  uploadVideo(@UploadedFile() file: Express.Multer.File, @Body() dto: UploadJobDto) { ... }

  @Post('from-url')
  @ApiOperation({ summary: 'Submit a public video URL for processing' })
  @ApiBody({ type: UrlJobDto })
  @ApiResponse({ status: 202, type: JobResponseDto })
  @ApiResponse({ status: 400, description: 'URL not in whitelist or invalid format' })
  fromUrl(@Body() dto: UrlJobDto) { ... }

  @Get(':jobId')
  @ApiOperation({ summary: 'Poll job status and retrieve result when completed' })
  @ApiParam({ name: 'jobId', description: 'UUID returned from upload/from-url' })
  @ApiResponse({ status: 200, type: JobResponseDto })
  @ApiResponse({ status: 404, description: 'Job not found' })
  getJob(@Param('jobId') jobId: string) { ... }
}
```

**DTOs** — request and response shapes with descriptions and examples:
```typescript
export class UrlJobDto {
  @ApiProperty({
    description: 'Publicly accessible video URL. Must be from a whitelisted domain or a direct video file URL.',
    example: 'https://drive.google.com/file/d/abc123/view',
  })
  @IsUrl()
  url: string;

  @ApiPropertyOptional({
    description: 'ID of a saved ColumnConfig to apply custom columns to the output.',
    example: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  })
  @IsOptional()
  @IsUUID()
  configId?: string;
}

export class StepDto {
  @ApiProperty({ example: 1 })
  stepNumber: number;

  @ApiProperty({ example: "Click 'Create Purchase Order'" })
  action: string;

  @ApiProperty({ example: 'The user navigates to the purchase order creation screen.' })
  description: string;

  @ApiProperty({ example: 'A blank purchase order form is displayed.' })
  expectedResult: string;

  @ApiProperty({ example: 4.2 })
  timestampSeconds: number;

  @ApiProperty({ description: 'Base64-encoded PNG screenshot at the timestamp.' })
  screenshotBase64: string;
}

export class JobResponseDto {
  @ApiProperty({ example: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' })
  jobId: string;

  @ApiProperty({ enum: JobStatus, example: 'COMPLETED' })
  status: JobStatus;

  @ApiPropertyOptional({ type: [StepDto] })
  steps?: StepDto[];

  @ApiPropertyOptional({ example: 'Gemini returned malformed JSON after 2 retries.' })
  error?: string;
}
```

### What the generated Swagger UI covers
- All request body shapes with field descriptions and examples
- All response shapes (success + every documented error code)
- Enum values for `status` field visible as a dropdown in the UI
- `multipart/form-data` for the file upload endpoint rendered as a file picker
- Grouped by tag: `Jobs`, `Column Configs`

### Why not design-first (openapi.yaml)?
Design-first means writing the spec before code, then generating client/server stubs. It's the right approach when the API is a public contract with external consumers, or when multiple teams work against the same spec independently. Here, both the spec and the implementation live in the same repo and change together — code-first removes the sync burden entirely.

---

## 9. API Endpoints

### Jobs
| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/jobs/upload` | `multipart/form-data` (`video` file, optional `configId`) | Upload a video file. Returns `{ jobId }` immediately. |
| `POST` | `/jobs/from-url` | `{ url: string, configId?: string }` | Submit a public video URL. Returns `{ jobId }` immediately. |
| `GET` | `/jobs/:jobId` | — | Poll job status. Returns full result when `COMPLETED`. |

### Column Configs
| Method | Path | Description |
|---|---|---|
| `POST` | `/column-configs` | Create a config. Returns `{ configId }`. |
| `GET` | `/column-configs` | List all configs. |
| `GET` | `/column-configs/:configId` | Get one config. |
| `PUT` | `/column-configs/:configId` | Update a config. |
| `DELETE` | `/column-configs/:configId` | Delete a config. |

---

## 9. Code Structure

```
luzid-task/
├── src/
│   ├── main.ts                            # Bootstrap, global pipes, Swagger, CORS
│   ├── app.module.ts
│   │
│   ├── config/
│   │   └── app.config.ts                  # @nestjs/config + Joi env validation
│   │
│   ├── jobs/
│   │   ├── jobs.module.ts
│   │   ├── jobs.controller.ts             # POST /jobs/upload, POST /jobs/from-url, GET /jobs/:id
│   │   ├── jobs.service.ts                # Pipeline orchestration
│   │   └── dto/
│   │       ├── upload-job.dto.ts          # (multipart — configId field)
│   │       ├── url-job.dto.ts             # { url, configId? }
│   │       └── job-response.dto.ts        # { jobId, status, steps?, error? }
│   │
│   ├── column-configs/
│   │   ├── column-configs.module.ts
│   │   ├── column-configs.controller.ts   # CRUD /column-configs
│   │   ├── column-configs.service.ts
│   │   └── dto/
│   │       └── column-config.dto.ts       # { columns: ColumnDefinition[] }
│   │
│   ├── gemini/
│   │   ├── gemini.module.ts
│   │   └── gemini.service.ts              # Files API upload + generateContent
│   │
│   ├── screenshot/
│   │   ├── screenshot.module.ts
│   │   └── screenshot.service.ts          # ffmpeg frame extraction
│   │
│   ├── video/
│   │   ├── video.module.ts
│   │   └── video.service.ts               # Download, validate, hash
│   │
│   └── common/
│       ├── repositories/
│       │   ├── job.repository.interface.ts
│       │   ├── job.repository.ts
│       │   ├── column-config.repository.interface.ts
│       │   ├── column-config.repository.ts
│       │   ├── video-hash.repository.interface.ts
│       │   └── video-hash.repository.ts
│       ├── types/
│       │   ├── job.types.ts
│       │   └── step.types.ts
│       ├── validators/
│       │   └── gemini-response.schema.ts  # Zod schema for Gemini output
│       └── filters/
│           └── http-exception.filter.ts   # Consistent { statusCode, message, timestamp }
│
├── test/
│   └── jest-e2e.json
│
├── .env                                   # Gitignored — secrets live here
├── .env.example                           # Committed — documents required keys
├── .gitignore                             # Must include .env
└── package.json
```

### Module Responsibilities

| Module | What it owns |
|---|---|
| `ConfigModule` | Env vars loading + validation — fail fast at startup |
| `JobsModule` | Job submission (upload + URL), status polling, pipeline orchestration |
| `ColumnConfigsModule` | CRUD for saved column configs; builds prompt injection block |
| `GeminiService` | All Gemini API calls — upload, poll, generateContent |
| `ScreenshotService` | ffmpeg frame extraction per timestamp |
| `VideoService` | URL whitelist check, file download, ffprobe validation, SHA-256 hashing |
| `*Repository` | In-memory state, all behind interfaces |

---

## 10. Implementation Phases

| Phase | Scope |
|---|---|
| **Phase 1** | Core pipeline: `JobsModule` + `GeminiService` + `ScreenshotService` + all repositories |
| **Phase 2** | `VideoService`: validations, URL whitelist download, SHA-256 dedup |
| **Phase 3** | `ColumnConfigsModule`: CRUD + dynamic prompt injection |
| **Phase 4** | Swagger docs, global exception filter, `.env.example`, e2e tests |

---

## 11. Future Work & Enhancements

| Area | Enhancement |
|---|---|
| **Security** | Full SSRF protection: block private/loopback IP ranges on URL download |
| **Security** | Rate limiting per IP on job submission endpoints |
| **Security** | API key / bearer token auth on all endpoints |
| **Scalability** | Replace in-memory job store with Redis (TTL support, multi-instance) |
| **Scalability** | Replace in-memory processing with BullMQ job queue (retries, concurrency control) |
| **Scalability** | Replace in-memory results with Postgres for long-term persistence |
| **UX** | `PATCH /jobs/:jobId/steps/:stepNumber` — allow caller to nudge a timestamp and re-extract screenshot |
| **Quality** | ffmpeg scene-change detection as a cross-check against Gemini's step count |
| **Quality** | Configurable Gemini model per request (e.g. `gemini-1.5-pro` for higher accuracy) |
