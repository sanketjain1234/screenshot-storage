# Flows, Corner Cases & Constants

---

## Constants Reference

| Constant | Value | File | Purpose |
|---|---|---|---|
| `MAX_DURATION_SECONDS` | `240` | `video.service.ts` | Max allowed video length. Videos longer than this are rejected with 422. |
| `MAX_PARSE_RETRIES` | `2` | `gemini.service.ts` | How many times to retry Gemini if the JSON response is unparseable. Total attempts = 3. |
| `MAX_RATE_LIMIT_RETRIES` | `3` | `gemini.service.ts` | How many times to retry on a 429 rate-limit error before failing the job. |
| `POLL_INTERVAL_MS` | `3000` | `gemini.service.ts` | How often to poll Gemini file state while waiting for it to become `ACTIVE`. |
| `POLL_TIMEOUT_MS` | `300000` (5 min) | `gemini.service.ts` | Max time to wait for Gemini file to become `ACTIVE` before giving up. |
| `MAX_INITIAL_WAIT_MS` | `180000` (3 min) | `gemini.service.ts` | Cap on the initial sleep before polling starts, regardless of file size calculation. |
| `RATE_LIMIT_BASE_DELAY_MS` | `30000` (30s) | `gemini.service.ts` | Base delay for exponential backoff on rate limits. Sequence: 30s → 60s → 120s. |
| `DEFAULT_MODEL` | `gemini-2.5-flash` | `gemini.service.ts` | Fallback if `GEMINI_MODEL` env var is not set. |
| `WHITELISTED_DOMAINS` | (see below) | `video.service.ts` | Domains allowed for URL-based video uploads. |
| `DIRECT_VIDEO_EXTENSIONS` | `.mp4 .mov .webm .avi` | `video.service.ts` | Extensions that bypass domain whitelist for URL uploads. |
| `ALLOWED_MIME_TYPES` | (see below) | `video.service.ts` | Accepted MIME types during file validation. |

**Whitelisted domains:** `drive.google.com`, `dropbox.com`, `dl.dropboxusercontent.com`, `storage.googleapis.com`, `s3.amazonaws.com`, `loom.com`, `www.loom.com`

**Allowed MIME types:** `video/mp4`, `video/quicktime`, `video/webm`, `video/x-msvideo`

---

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | **required** | Google Generative AI API key |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Primary model used for step generation |
| `GEMINI_FALLBACK_MODEL` | `gemini-2.5-flash-lite` | Model used when primary returns 503 |
| `PORT` | `3000` | HTTP server port |
| `MAX_FILE_SIZE_BYTES` | `209715200` (200MB) | Max video file size for URL downloads |
| `TEMP_DIR` | `/tmp` | Directory for temporary video files |
| `SCREENSHOTS_DIR` | `/tmp/screenshots` | Persistent directory for saved PNG screenshots |
| `APP_BASE_URL` | `http://localhost:3000` | Base URL used to construct `screenshotUrl` in responses |
| `GEMINI_UPLOAD_SPEED_MBPS` | `1` | Assumed upload speed to Gemini (used to estimate initial wait) |
| `GEMINI_PROCESSING_BUFFER_SECONDS` | `30` | Buffer added to estimated upload time before polling |

---

## Flow 1: File Upload Job (`POST /jobs/upload`)

```
Client uploads video file
  → Multer saves to TEMP_DIR as UUID filename
  → JobsService.createFromFile()
    → Creates job record (status: PENDING)
    → Fires processJob() async (returns job ID immediately)

processJob():
  1. VALIDATING
     → computeHash (SHA-256)
     → Check dedup: if same hash + COMPLETED job exists → reuse result, skip pipeline
     → validateFile: check MIME type + duration ≤ MAX_DURATION_SECONDS
  2. UPLOADING_TO_GEMINI
     → geminiService.uploadVideoFile()
     → geminiService.waitUntilActive() — sleep then poll
  3. PROCESSING
     → resolveColumnDefs(configId) → get ColumnDefinition[] for Gemini prompt
     → geminiService.generateSteps(uri, mimeType, columnDefs, videoDuration)
     → Clamp timestamps: each step.timestampSeconds = min(ts, videoDuration - 0.5)
  4. EXTRACTING_SCREENSHOTS
     → Promise.all: screenshotService.extractFrame() per step (concurrent)
     → Failed frames → screenshotUrl = undefined (job continues)
  5. COMPLETED
     → Store steps in job record
     → Delete temp video file
```

**Corner cases:**
- Duplicate hash → immediately COMPLETED with reused steps, no Gemini call
- MIME type not in `ALLOWED_MIME_TYPES` → 422 before upload
- Duration > `MAX_DURATION_SECONDS` → 422 before upload
- Gemini 503 → auto-retry with fallback model
- Gemini 429 → exponential backoff up to 3 retries
- Gemini returns malformed JSON → retry up to `MAX_PARSE_RETRIES` with stricter prompt warning
- Gemini hallucinated timestamp → clamped to `videoDuration - 0.5` with WARN log
- ffmpeg frame extraction fails → step gets `screenshotUrl: undefined`, job still COMPLETES
- Gemini file stuck in `PROCESSING` → throws after `POLL_TIMEOUT_MS`

---

## Flow 2: URL Job (`POST /jobs/from-url`)

Same as Flow 1 after download. Extra steps:

```
  → validateUrl():
      - Must be a valid URL
      - Domain must be in WHITELISTED_DOMAINS OR path must end in a DIRECT_VIDEO_EXTENSION
  → downloadFile() to TEMP_DIR
      - Enforces MAX_FILE_SIZE_BYTES during streaming (kills stream mid-download if exceeded)
      - Infers mimeType from file extension
  → then identical to processJob()
```

**Corner cases:**
- Invalid URL format → 400 before anything
- Domain not whitelisted + no video extension → 400
- File exceeds `MAX_FILE_SIZE_BYTES` mid-download → 422, temp file deleted
- Download fails (network error) → 500, temp file cleaned up in catch block

---

## Flow 3: Poll Job Status (`GET /jobs/:jobId`)

```
  → Look up job by ID
  → Return current status + steps (if COMPLETED) or error (if FAILED)
```

**Corner cases:**
- Unknown jobId → 404
- Job still in progress → returns status without steps
- Job FAILED → returns status + `error` message

---

## Flow 4: Column Config CRUD (`/column-configs`)

### Create (`POST /column-configs`)
```
  → Validate ColumnEntryDto[] (enum check per key)
  → Validate CustomColumnDefDto[] if present:
      - key regex: /^[a-zA-Z][a-zA-Z0-9_]*$/
      - key must not collide with any ColumnKey enum value
      - no duplicate keys within the same config
  → Store in InMemoryColumnConfigRepository
  → Return resolved config (including resolvedColumns with custom labels applied)
```

**Corner cases:**
- Custom key = `"priority"` (built-in key) → 400 collision error
- Custom key = `"my field"` (spaces) → 400 regex validation error
- Custom column `description` < 10 chars → 400 validation error
- Predefined column with `label` override → Gemini gets the custom label in its prompt instruction
- No `configId` on a job → falls back to `DEFAULT_COLUMN_KEYS` (all 5 predefined columns)

### Update (`PUT /column-configs/:id`)
```
  → Fetch existing config (404 if not found)
  → Patch only provided fields (name, columns, customColumns)
  → Re-validate customColumns on update
```

**Corner cases:**
- Updating only `name` leaves columns untouched
- Setting `customColumns: []` clears all custom columns

---

## Flow 5: Gemini Step Generation (internal)

```
generateSteps()
  → Loop up to MAX_PARSE_RETRIES + 1 parse attempts
    → generateWithRateLimitRetry() [primary model]
      → Loop up to MAX_RATE_LIMIT_RETRIES + 1 rl attempts
        → attemptGenerateSteps()
          → buildPrompt(columnDefs, attempt, videoDuration)
          → model.generateContent([video, prompt])
          → stripJsonFences(raw)
          → JSON.parse()
          → Zod schema validation (buildStepSchema)
    → On 503: retry same with fallback model
    → On 429: exponential/header-guided backoff
    → On parse fail: retry with retryWarning appended to prompt
```

**Corner cases:**
- Both primary and fallback return 503 → job FAILED
- Zod validation fails (missing fields, wrong types) → counted as parse failure, retried
- Gemini wraps JSON in markdown fences → stripped before parse
- Gemini returns non-array JSON → Zod rejects, treated as parse failure

---

## Zod Schema for Step Validation

Built dynamically in `buildStepSchema(columnKeys: string[])`:

**Always present (BaseStepSchema):**
- `stepNumber`: positive integer
- `action`: non-empty string
- `description`: non-empty string
- `expectedResult`: non-empty string
- `timestampSeconds`: non-negative number

**Dynamically added:** one `z.string()` field per `columnKey` (both predefined and custom columns).

---

## Screenshot Extraction (internal)

```
extractFrame(videoPath, timestampSeconds)
  → mkdir SCREENSHOTS_DIR (recursive, safe to call repeatedly)
  → ffmpeg seekInput(ts).frames(1).outputOptions('-q:v', '2')
  → stat output file (size check + logged)
  → return {APP_BASE_URL}/screenshots/{uuid}.png
```

The `-q:v 2` option produces high-quality JPEG-scale PNG output. File is never deleted.

**Corner cases:**
- `timestampSeconds` beyond video end → ffmpeg may produce a black frame or fail; caller already clamps
- `SCREENSHOTS_DIR` not writable → throws, caught by `JobsService` per-step catch block
