# Codebase Overview — Files & Methods

## Entry Point

### `src/main.ts`
App bootstrap. Runs once at startup.
- Creates `SCREENSHOTS_DIR` if it doesn't exist (`mkdirSync`)
- Mounts `SCREENSHOTS_DIR` as static assets at `/screenshots` so PNGs are publicly accessible
- Registers global `ValidationPipe` (strips unknown fields, transforms DTOs)
- Registers global `HttpExceptionFilter` (uniform error response shape)
- Enables CORS (all origins)
- Sets up Swagger at `/api/docs`

---

## Config

### `src/config/app.config.ts`
Joi-validated environment variable schema. All env vars have defaults except `GEMINI_API_KEY` (required). Loaded globally — any service can inject `ConfigService` to read values.

---

## Jobs Module (`src/jobs/`)

### `jobs.controller.ts`
HTTP layer only. Three routes:
- `POST /jobs/upload` — receives multipart file, calls `createFromFile()`
- `POST /jobs/from-url` — receives `{ url, configId }`, calls `createFromUrl()`
- `GET /jobs/:jobId` — polls job status

### `jobs.service.ts`
Orchestrates the full pipeline. Main methods:

| Method | What it does |
|---|---|
| `createFromFile(file, configId?)` | Saves job record, fires `processJob()` async, returns job ID immediately |
| `createFromUrl(url, configId?)` | Same but first downloads video via `VideoService.downloadFromUrl()` |
| `processJob(jobId, filePath, mimeType, configId?)` | Full pipeline: hash → dedup check → validate → upload to Gemini → wait → generate steps → clamp timestamps → extract screenshots → mark COMPLETED |
| `findById(jobId)` | Looks up job, returns DTO (status + steps or error) |
| `createJob()` | Creates a `PENDING` job record in the repository |
| `updateStatus(jobId, status)` | Helper to update and log status transitions |
| `toResponseDto(job)` | Maps internal `Job` to `JobResponseDto` |

**Key logic in `processJob()`:**
1. SHA-256 dedup check — if identical video already processed, reuse result
2. `validateFile` returns `videoDuration` — used to clamp timestamps
3. After Gemini returns steps: `timestampSeconds = Math.min(ts, videoDuration - 0.5)`
4. Screenshots run concurrently (`Promise.all`) — each failure is caught individually
5. Temp video file is deleted in `finally` block regardless of success/failure

### `dto/job-response.dto.ts`
Response shape: `{ jobId, status, steps?, error? }`

### `dto/step.dto.ts`
Swagger-annotated shape of one step in the response:
- `stepNumber`, `action`, `description`, `expectedResult`, `timestampSeconds` — always present
- `screenshotUrl?` — URL to PNG, absent if extraction failed
- `customColumns?` — dynamic key-value pairs from column config

### `dto/upload-job.dto.ts` / `url-job.dto.ts`
Input DTOs for the two job creation endpoints. `url-job.dto.ts` carries `url` and optional `configId`.

---

## Gemini Module (`src/gemini/`)

### `gemini.service.ts`
All communication with the Google Generative AI API.

| Method | What it does |
|---|---|
| `uploadVideoFile(filePath, mimeType)` | Uploads video to Gemini Files API, returns `{ uri, name }` |
| `waitUntilActive(fileName, fileSizeBytes)` | Sleeps (proportional to file size), then polls every 3s until file state is `ACTIVE` or timeout |
| `generateSteps(fileUri, mimeType, columnDefs, videoDuration)` | Top-level call — manages parse retries and 503 fallback |
| `generateWithRateLimitRetry(...)` | Inner loop — manages 429 backoff per model |
| `attemptGenerateSteps(...)` | Single attempt: build prompt → call API → strip fences → parse JSON → Zod validate |
| `buildPrompt(columnDefs, attempt, videoDuration)` | Assembles prompt from `prompt.config.json`, injects duration, appends custom column instructions |
| `stripJsonFences(raw)` | Removes ` ```json ``` ` wrappers from Gemini output |
| `computeInitialWait(fileSizeBytes)` | Estimates upload time + buffer, capped at `MAX_INITIAL_WAIT_MS` |
| `isRateLimitError(err)` | Detects 429/RESOURCE_EXHAUSTED errors |
| `isServiceUnavailableError(err)` | Detects 503/Service Unavailable errors |
| `parseRetryDelay(err)` | Extracts retry delay from Gemini error message (JSON or prose format) |
| `exponentialBackoffMs(attempt)` | Returns 30s × 2^(attempt-1) |

### `prompt.config.json`
Structured prompt template. Sections:
- `role` — persona instruction ("You are a precise screen recording analyst...")
- `task` — what to do with the video
- `fields` — always-present fields Gemini must return per step
- `timestampConstraints` — rules with `{VIDEO_DURATION_SECONDS}` placeholder
- `outputConstraints` — format rules (raw JSON array, no markdown)
- `retryWarning` — appended on retry attempts when previous response was invalid

---

## Video Module (`src/video/`)

### `video.service.ts`
Handles validation and downloading of video files.

| Method | What it does |
|---|---|
| `validateFile(filePath, mimeType)` | Checks MIME type + duration ≤ MAX_DURATION_SECONDS. Returns duration (used for timestamp clamping). |
| `downloadFromUrl(url)` | Validates URL, downloads to TEMP_DIR with size enforcement, returns `{ filePath, mimeType }` |
| `computeHash(filePath)` | SHA-256 of file bytes for dedup |
| `validateUrl(url)` | Checks domain whitelist + direct video extension |
| `downloadFile(url, destPath)` | Streaming HTTP(S) download with byte-counting size limit |
| `getVideoDuration(filePath)` | Uses `ffprobe` to read `format.duration` from metadata |
| `extToMimeType(ext)` | Maps `.mp4/.mov/.webm/.avi` to MIME type string |

---

## Screenshot Module (`src/screenshot/`)

### `screenshot.service.ts`
Extracts a single PNG frame from a video using ffmpeg.

| Method | What it does |
|---|---|
| `extractFrame(videoPath, timestampSeconds)` | Creates dir if needed, runs ffmpeg with `seekInput`, saves PNG to `SCREENSHOTS_DIR`, returns full URL |
| `runFfmpeg(videoPath, ts, outputPath)` | Promisified fluent-ffmpeg call: seek to `ts`, extract 1 frame, quality `-q:v 2` |

Files are never deleted. Accessible at `{APP_BASE_URL}/screenshots/{uuid}.png`.

---

## Column Configs Module (`src/column-configs/`)

### `column-configs.controller.ts`
Five REST endpoints:
- `POST /column-configs` — create
- `GET /column-configs/available` — list all supported column keys from registry
- `GET /column-configs` — list all saved configs
- `GET /column-configs/:id` — get one config
- `PUT /column-configs/:id` — update
- `DELETE /column-configs/:id` — delete

### `column-configs.service.ts`
Business logic for column config management.

| Method | What it does |
|---|---|
| `create(dto)` | Validates custom column keys, stores config, returns response DTO |
| `findById(id)` | Fetches config, throws 404 if missing |
| `findAll()` | Returns all configs as response DTOs |
| `update(id, dto)` | Patches existing config fields, re-validates custom columns if changed |
| `delete(id)` | Removes config, throws 404 if missing |
| `resolveColumnDefs(configId?)` | Returns `{ columnDefs, columnKeys }` used by `JobsService` to build the Gemini prompt. Merges predefined + custom columns. Falls back to `DEFAULT_COLUMN_KEYS` if no configId. |
| `toResponseDto(config)` | Builds `ColumnConfigResponseDto` with resolved labels (custom labels override defaults) |
| `validateCustomColumnKeys(customColumns?)` | Guards: no collision with ColumnKey enum values, no duplicates within config |

### `dto/column-config.dto.ts`
Four main DTO classes:

| Class | Purpose |
|---|---|
| `ColumnEntryDto` | One predefined column entry: `key` (ColumnKey enum) + optional `label` override |
| `CustomColumnDefDto` | One custom column: `key` (regex-validated identifier) + required `label` + required `description` |
| `CreateColumnConfigDto` | `name` + `columns: ColumnEntryDto[]` + optional `customColumns: CustomColumnDefDto[]` |
| `UpdateColumnConfigDto` | Same as Create but all fields optional |
| `ColumnConfigResponseDto` | Full config response including `resolvedColumns` (labels applied) |
| `AvailableColumnsResponseDto` | All registered column keys + default column order |

---

## Common — Types

### `src/common/types/step.types.ts`
- `ColumnDefinition` — `{ key, label, description }` — what the Gemini prompt receives per column
- `Step` — `{ stepNumber, action, description, expectedResult, timestampSeconds, screenshotUrl?, [key]: unknown }` — the index signature `[key]: unknown` allows dynamic column values

### `src/common/types/column-config.types.ts`
- `ColumnConfig` — stored entity: `{ id, name, columns: ColumnEntry[], customColumns?: CustomColumnDef[], createdAt }`

---

## Common — Column Registry

### `src/common/columns/column-registry.ts`
Central definition of all built-in column types.

| Export | Type | Purpose |
|---|---|---|
| `ColumnKey` | enum | 5 predefined keys: `preconditions`, `testData`, `priority`, `notes`, `verificationMethod` |
| `ColumnEntry` | interface | `{ key: ColumnKey; label?: string }` — one column in a user config, with optional label override |
| `CustomColumnDef` | interface | `{ key: string; label: string; description: string }` — a fully user-defined column |
| `COLUMN_REGISTRY` | Record | Maps each `ColumnKey` to its default `ColumnDefinition` (label + Gemini description) |
| `DEFAULT_COLUMN_KEYS` | ColumnKey[] | All 5 keys in order — used when no column config is specified |
| `resolveColumnDefs(entries)` | function | Converts `ColumnEntry[]` to `ColumnDefinition[]`, applying custom labels where present |

---

## Common — Validators

### `src/common/validators/gemini-response.schema.ts`
- `buildStepSchema(columnKeys: string[])` — dynamically builds a Zod schema. `BaseStepSchema` has the 5 fixed fields; `columnKeys` are extended as `z.string()` fields. Returns `.array()` schema for the full Gemini response.

---

## Common — Repositories

### `src/common/repositories/column-config.repository.ts`
`InMemoryColumnConfigRepository` — simple `Map<string, ColumnConfig>`. CRUD backed by in-process memory. **Data is lost on server restart.** Interface: `create`, `findById`, `update`, `delete`, `findAll`.

### `src/common/repositories/job.repository.*` / `video-hash.repository.*`
Same pattern: in-memory maps for jobs (`Map<string, Job>`) and video hashes (`Map<hash, jobId>`).

---

## Common — FFmpeg Setup

### `src/common/ffmpeg/ffmpeg-setup.ts`
Configures `fluent-ffmpeg` to use `ffmpeg-static` binaries bundled with the project (no system ffmpeg needed). Used by both `VideoService` (probe) and `ScreenshotService` (frame extraction).

---

## Common — Filters

### `src/common/filters/http-exception.filter.ts`
Global exception filter. Catches all `HttpException` instances and returns a consistent JSON shape: `{ statusCode, message, timestamp, path }`.
