# Execution Steps — Test Script Generator

Reference: `resources/plan.md`
Track progress by checking off boxes. Never skip a verification step.

---

## Decision Log

| Decision | Outcome | Reason |
|---|---|---|
| ConfigModule in Phase 1 or Future? | **Phase 1** | Async job pattern makes boot-time env validation more critical, not less. Missing API key fails silently in the background — boot check catches it immediately at deploy time. 30 min cost, eliminates entire class of deployment bugs. |
| Frontend? | No | Pure REST API. Swagger UI at `/api/docs` is the consumer interface. |
| URL validation approach? | Domain whitelist | Simple, honest about limitations. Full SSRF in Future Work. |
| Storage? | In-memory behind repository interfaces | Swap to Redis/Postgres = one provider change. |

---

## Dependency Install (do once, before anything else)

```bash
npm install \
  @nestjs/config @nestjs/swagger \
  joi zod uuid \
  @google/generative-ai \
  fluent-ffmpeg \
  class-validator class-transformer \
  swagger-ui-express

npm install --save-dev \
  @types/multer @types/fluent-ffmpeg @types/uuid
```

- [ ] Run install, confirm no peer dep errors
- [ ] Verify `node_modules/@google/generative-ai` exists

---

## Step 0 — Secrets & Environment

**Files to create/modify:**
- `.env` (gitignored)
- `.env.example` (committed)
- Verify `.gitignore` includes `.env`

```
# .env.example
GEMINI_API_KEY=
PORT=3000
MAX_FILE_SIZE_BYTES=209715200
TEMP_DIR=/tmp
```

- [ ] Create `.env` with real `GEMINI_API_KEY`
- [ ] Create `.env.example` with blank values
- [ ] Confirm `.gitignore` already has `.env` (NestJS default does — verify)

---

## Step 1 — Config Module

**Goal:** Server refuses to start if env vars are missing or invalid.

**Files:**
- `src/config/app.config.ts`

```typescript
// Joi schema validates: GEMINI_API_KEY (required string), PORT (default 3000),
// MAX_FILE_SIZE_BYTES (default 200MB), TEMP_DIR (default /tmp)
```

**Wire up:**
- Import `ConfigModule.forRoot({ validationSchema, isGlobal: true })` in `AppModule`

- [ ] Create `src/config/app.config.ts` with Joi schema
- [ ] Register in `AppModule`
- [ ] **Verify:** Remove `GEMINI_API_KEY` from `.env`, run `npm run start:dev` → server should throw and refuse to start
- [ ] Restore `.env`, server starts normally

---

## Step 2 — Common Types & Interfaces

**Goal:** Shared types used across all modules. No logic here.

**Files:**
- `src/common/types/job.types.ts` — `JobStatus` enum + `Job` interface
- `src/common/types/step.types.ts` — `Step` interface + `ColumnDefinition` interface

```typescript
// job.types.ts
export enum JobStatus {
  PENDING = 'PENDING',
  VALIDATING = 'VALIDATING',
  UPLOADING_TO_GEMINI = 'UPLOADING_TO_GEMINI',
  PROCESSING = 'PROCESSING',
  EXTRACTING_SCREENSHOTS = 'EXTRACTING_SCREENSHOTS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export interface Job {
  id: string;
  status: JobStatus;
  videoHash?: string;
  geminiFileUri?: string;
  result?: Step[];
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

// step.types.ts
export interface Step {
  stepNumber: number;
  action: string;
  description: string;
  expectedResult: string;
  timestampSeconds: number;
  screenshotBase64: string;
  [key: string]: unknown; // custom columns
}

export interface ColumnDefinition {
  key: string;
  label: string;
  description: string; // instruction to Gemini for this column
}
```

- [ ] Create `src/common/types/job.types.ts`
- [ ] Create `src/common/types/step.types.ts`

---

## Step 3 — Repository Interfaces & In-Memory Implementations

**Goal:** All state access behind interfaces. `Map` calls never appear in service code.

**Files (create in order):**

1. `src/common/repositories/job.repository.interface.ts`
2. `src/common/repositories/job.repository.ts` — `InMemoryJobRepository`
3. `src/common/repositories/column-config.repository.interface.ts`
4. `src/common/repositories/column-config.repository.ts` — `InMemoryColumnConfigRepository`
5. `src/common/repositories/video-hash.repository.interface.ts`
6. `src/common/repositories/video-hash.repository.ts` — `InMemoryVideoHashRepository`

**Interface shapes:**
```typescript
// IJobRepository
create(job: Job): void
findById(id: string): Job | undefined
update(id: string, patch: Partial<Job>): void

// IColumnConfigRepository
create(config: ColumnConfig): string    // returns generated configId
findById(id: string): ColumnConfig | undefined
update(id: string, patch: Partial<ColumnConfig>): void
delete(id: string): void
findAll(): ColumnConfig[]

// IVideoHashRepository
set(sha256: string, jobId: string): void
get(sha256: string): string | undefined
```

**NestJS DI tokens** (define as symbols):
```typescript
export const JOB_REPOSITORY = Symbol('JOB_REPOSITORY');
export const COLUMN_CONFIG_REPOSITORY = Symbol('COLUMN_CONFIG_REPOSITORY');
export const VIDEO_HASH_REPOSITORY = Symbol('VIDEO_HASH_REPOSITORY');
```

- [ ] Create all 6 files
- [ ] Each implementation is a plain `@Injectable()` class wrapping `Map<string, T>`
- [ ] DI tokens defined in a `src/common/repositories/tokens.ts` file

---

## Step 4 — Global Exception Filter

**Goal:** Every error returns `{ statusCode, message, timestamp }`. No raw NestJS error shapes leak to consumers.

**File:** `src/common/filters/http-exception.filter.ts`

- [ ] Create filter implementing `ExceptionFilter`
- [ ] Register globally in `main.ts` via `app.useGlobalFilters()`
- [ ] **Verify:** Hit a non-existent route, confirm structured JSON error response

---

## Step 5 — GeminiService

**Goal:** Encapsulates all Gemini API interactions. No other service talks to Gemini directly.

**Files:**
- `src/gemini/gemini.module.ts`
- `src/gemini/gemini.service.ts`

**Methods to implement (in this order):**

```typescript
// 1. Upload video file to Gemini Files API
uploadVideoFile(filePath: string, mimeType: string): Promise<{ uri: string; name: string }>

// 2. Poll until Gemini file is ACTIVE (max ~60s, poll every 2s)
waitUntilActive(fileName: string): Promise<void>

// 3. Call generateContent with dynamic prompt + file URI
// Returns raw parsed JSON array
generateSteps(fileUri: string, columnDefs: ColumnDefinition[]): Promise<Step[]>

// Internal: build the dynamic prompt string
private buildPrompt(columnDefs: ColumnDefinition[]): string
```

**Notes:**
- Use `@google/generative-ai` SDK (not raw fetch)
- Model: `gemini-2.0-flash`
- On JSON parse failure: retry up to 2 times with slightly stricter prompt
- Validate Gemini output against Zod schema before returning (see Step 6)
- Inject `GEMINI_API_KEY` via `ConfigService`

- [ ] Create `gemini.module.ts`
- [ ] Implement all 4 methods in `gemini.service.ts`
- [ ] **Verify:** Write a quick unit test / manual call with a known video URL to confirm JSON comes back

---

## Step 6 — Zod Schema for Gemini Response

**Goal:** Prevent malformed Gemini output from propagating into job results.

**File:** `src/common/validators/gemini-response.schema.ts`

```typescript
// Base schema (always present fields)
const BaseStepSchema = z.object({
  stepNumber: z.number().int().positive(),
  action: z.string().min(1),
  description: z.string().min(1),
  expectedResult: z.string().min(1),
  timestampSeconds: z.number().nonnegative(),
});

// Extended dynamically with custom column keys (all string values)
// Used in GeminiService.generateSteps()
export function buildStepSchema(columnKeys: string[]) { ... }
```

- [ ] Create `src/common/validators/gemini-response.schema.ts`
- [ ] `GeminiService.generateSteps()` calls `buildStepSchema(columnKeys).array().parse(raw)`
- [ ] On `ZodError`: retry (up to 2x), then throw with descriptive message

---

## Step 7 — ScreenshotService

**Goal:** Extract one PNG frame per timestamp using ffmpeg. Returns base64 string.

**Files:**
- `src/screenshot/screenshot.module.ts`
- `src/screenshot/screenshot.service.ts`

**Method:**
```typescript
extractFrame(videoPath: string, timestampSeconds: number): Promise<string> // base64 PNG
```

**Implementation notes:**
- Use `fluent-ffmpeg`
- Output to a temp file (`{TEMP_DIR}/{uuid}.png`)
- Read file → `Buffer.from(data).toString('base64')` → delete temp file
- Wrap in try/finally to guarantee temp file cleanup

- [ ] Create both files
- [ ] **Verify:** Point at a local video, call `extractFrame(path, 2.0)`, confirm base64 string returned and temp file cleaned up

---

## Step 8 — VideoService

**Goal:** Handles everything video-related before Gemini is involved: download, validate, hash, dedup.

**Files:**
- `src/video/video.module.ts`
- `src/video/video.service.ts`

**Methods:**
```typescript
// Validate an already-received file (from Multer)
validateFile(filePath: string, originalMimeType: string): Promise<void>
// Throws 422 if: size > limit, duration > 3min, MIME not whitelisted

// Download from a whitelisted URL to temp dir, return local path
downloadFromUrl(url: string): Promise<string>
// Throws 400 if: URL domain not in whitelist AND not a direct video extension
// Throws 422 if: downloaded file fails validation

// Compute SHA-256 of file content
computeHash(filePath: string): Promise<string>
```

**URL whitelist constant:**
```typescript
const WHITELISTED_DOMAINS = [
  'drive.google.com',
  'dropbox.com',
  'dl.dropboxusercontent.com',
  'storage.googleapis.com',
  's3.amazonaws.com',
  'loom.com',
  'www.loom.com',
];

const DIRECT_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.avi'];
// A URL passes if its hostname is in WHITELISTED_DOMAINS
// OR its pathname ends with a DIRECT_VIDEO_EXTENSIONS entry
```

**ffprobe for duration + MIME:**
- Use `fluent-ffmpeg.ffprobe()` to read metadata
- Check `format.duration <= 180` (3 min)
- Check `streams[0].codec_type === 'video'`

- [ ] Create both files
- [ ] **Verify:** Try validating a 5-minute video → should throw 422
- [ ] **Verify:** Try a non-whitelisted URL → should throw 400

---

## Step 9 — JobsModule (Core Pipeline)

This is the central orchestrator. Build DTOs first, then service, then controller.

### 9a — DTOs (with full Swagger decorators)

**Files:**
- `src/jobs/dto/upload-job.dto.ts` — `configId?: string` (multipart body field)
- `src/jobs/dto/url-job.dto.ts` — `{ url: string, configId?: string }`
- `src/jobs/dto/job-response.dto.ts` — `{ jobId, status, steps?, error? }`
- `src/jobs/dto/step.dto.ts` — mirrors `Step` type with `@ApiProperty` on every field

Every field must have `@ApiProperty` with `description` + `example`. Every optional field uses `@ApiPropertyOptional`.

- [ ] Create all 4 DTO files with class-validator + Swagger decorators
- [ ] `JobStatus` enum exposed via `@ApiProperty({ enum: JobStatus })`

### 9b — JobsService (pipeline orchestration)

**File:** `src/jobs/jobs.service.ts`

**Methods:**
```typescript
// Called by controller — creates job, kicks off async pipeline, returns jobId immediately
createFromFile(file: Express.Multer.File, configId?: string): Promise<{ jobId: string }>
createFromUrl(url: string, configId?: string): Promise<{ jobId: string }>

// Called by controller for polling
findById(jobId: string): Job

// Private — runs async (NOT awaited by controller)
private processJob(jobId: string, filePath: string, configId?: string): Promise<void>
```

**`processJob` logic (in order):**
1. Update job status → `VALIDATING`
2. `videoService.computeHash(filePath)` → check `videoHashRepository.get(hash)`
   - If duplicate → update job result from existing, mark `COMPLETED`, return early
3. `videoService.validateFile(filePath, ...)` → throws 422 on failure (caught, marks job `FAILED`)
4. Update status → `UPLOADING_TO_GEMINI`
5. `geminiService.uploadVideoFile(...)` + `geminiService.waitUntilActive(...)` → store `geminiFileUri` on job
6. Update status → `PROCESSING`
7. Resolve `columnDefs` from `columnConfigRepository.findById(configId)` (empty array if none)
8. `geminiService.generateSteps(geminiFileUri, columnDefs)` → `steps[]` with timestamps
9. Update status → `EXTRACTING_SCREENSHOTS`
10. For each step: `screenshotService.extractFrame(filePath, step.timestampSeconds)` → attach `screenshotBase64`
11. Store result, mark job `COMPLETED`, store hash in `videoHashRepository`
12. `finally`: delete temp file

- [ ] Implement `JobsService` with all methods
- [ ] Ensure `processJob` is called with `void` (fire-and-forget from controller) — errors caught internally and stored on job

### 9c — JobsController

**File:** `src/jobs/jobs.controller.ts`

```typescript
@ApiTags('Jobs')
@Controller('jobs')
export class JobsController {

  @Post('upload')
  @UseInterceptors(FileInterceptor('video', multerOptions))
  // Returns 202 Accepted
  uploadVideo(@UploadedFile() file, @Body() dto: UploadJobDto) { ... }

  @Post('from-url')
  // Returns 202 Accepted
  fromUrl(@Body() dto: UrlJobDto) { ... }

  @Get(':jobId')
  getJob(@Param('jobId') jobId: string) { ... }
}
```

**Multer options:**
```typescript
// fileSize from ConfigService (MAX_FILE_SIZE_BYTES)
// dest: ConfigService.get('TEMP_DIR')
// fileFilter: reject non-video MIME types immediately
```

- [ ] Implement controller with all Swagger decorators (`@ApiOperation`, `@ApiResponse`, `@ApiConsumes`, `@ApiBody`, `@ApiParam`)
- [ ] `@Post('upload')` returns HTTP 202
- [ ] `@Post('from-url')` returns HTTP 202
- [ ] `@Get(':jobId')` returns 200 with `JobResponseDto`, 404 if not found

### 9d — Wire up JobsModule

- [ ] Create `src/jobs/jobs.module.ts`
- [ ] Provide repositories via DI tokens
- [ ] Import `GeminiModule`, `ScreenshotModule`, `VideoModule`
- [ ] Register in `AppModule`

- [ ] **Verify:** `POST /jobs/upload` with a video file → returns `{ jobId, status: "PENDING" }` immediately
- [ ] **Verify:** `GET /jobs/:jobId` while processing → returns intermediate status
- [ ] **Verify:** `GET /jobs/:jobId` after completion → returns full steps with `screenshotBase64`

---

## Step 10 — ColumnConfigsModule

**Goal:** CRUD for saved column configs. Used to inject custom columns into Gemini prompt.

### 10a — ColumnConfig types + DTO

**ColumnConfig shape:**
```typescript
interface ColumnConfig {
  id: string;
  name: string;                    // friendly name for the config
  columns: ColumnDefinition[];     // array of { key, label, description }
  createdAt: Date;
}
```

**File:** `src/column-configs/dto/column-config.dto.ts`
- `CreateColumnConfigDto` — `{ name: string, columns: ColumnDefinitionDto[] }`
- `UpdateColumnConfigDto` — same fields, all optional
- `ColumnConfigResponseDto` — full config shape with `id`
- All fields have `@ApiProperty` with examples

### 10b — ColumnConfigsService

**File:** `src/column-configs/column-configs.service.ts`

```typescript
create(dto: CreateColumnConfigDto): ColumnConfig
findById(id: string): ColumnConfig          // throws 404 if not found
findAll(): ColumnConfig[]
update(id: string, dto: UpdateColumnConfigDto): ColumnConfig
delete(id: string): void
buildPromptBlock(configId?: string): string  // injects into Gemini prompt
```

`buildPromptBlock` returns the `{CUSTOM_COLUMNS_BLOCK}` string for the prompt:
```
- preconditions: any preconditions required before this step
- priority: one of "High", "Medium", "Low"
```
Returns empty string if `configId` is undefined or config not found.

### 10c — ColumnConfigsController

```typescript
@ApiTags('Column Configs')
@Controller('column-configs')
// POST   /column-configs        → 201
// GET    /column-configs        → 200 []
// GET    /column-configs/:id    → 200 | 404
// PUT    /column-configs/:id    → 200 | 404
// DELETE /column-configs/:id    → 204 | 404
```

- [ ] Create all files
- [ ] Wire `ColumnConfigsModule` and register in `AppModule`
- [ ] **Verify:** Create a config, retrieve it by ID, pass `configId` to `/jobs/upload`, confirm custom columns appear in result

---

## Step 11 — main.ts & App Bootstrap

**File:** `src/main.ts`

Full setup:
```typescript
async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Global validation pipe
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));

  // Global exception filter
  app.useGlobalFilters(new HttpExceptionFilter());

  // CORS
  app.enableCors();

  // Swagger
  const config = new DocumentBuilder()
    .setTitle('Test Script Generator')
    .setDescription('Upload a screen recording and extract structured test steps with screenshots.')
    .setVersion('1.0')
    .addTag('Jobs')
    .addTag('Column Configs')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Server running on http://localhost:${port}`);
  console.log(`Swagger docs: http://localhost:${port}/api/docs`);
}
```

- [ ] Update `main.ts`
- [ ] **Verify:** Navigate to `http://localhost:3000/api/docs` — all endpoints visible, all request/response schemas populated

---

## Step 12 — Final Verification Checklist

Run through each scenario manually via Swagger UI:

- [ ] `POST /jobs/upload` with a valid `.mp4` (< 3 min) → `{ jobId, status: "PENDING" }`
- [ ] Poll `GET /jobs/:jobId` → status transitions visible (VALIDATING → UPLOADING_TO_GEMINI → PROCESSING → EXTRACTING_SCREENSHOTS → COMPLETED)
- [ ] `GET /jobs/:jobId` when COMPLETED → `steps[]` with all fields + `screenshotBase64` populated
- [ ] Upload same video again → returns existing `jobId` (dedup working)
- [ ] Upload video > 3 min → `422` with clear error message
- [ ] Upload non-video file → `400` from Multer fileFilter
- [ ] `POST /jobs/from-url` with a whitelisted URL → job created
- [ ] `POST /jobs/from-url` with a non-whitelisted URL → `400`
- [ ] `POST /column-configs` → `{ configId }`
- [ ] `GET /column-configs/:configId` → returns config
- [ ] `POST /jobs/upload` with `configId` → result steps include custom columns
- [ ] `GET /jobs/nonexistent-id` → `404` with `{ statusCode, message, timestamp }`
- [ ] Remove `GEMINI_API_KEY` from `.env`, restart → server refuses to start

---

## Module Wiring Order Summary

```
AppModule
  ├── ConfigModule (global)
  ├── JobsModule
  │     ├── GeminiModule
  │     ├── ScreenshotModule
  │     ├── VideoModule
  │     └── ColumnConfigsModule
  └── ColumnConfigsModule (also registered at root for direct access)
```

Repositories are provided inside their consumer module (or a shared `CommonModule` if needed).

---

## File Creation Order (safe dependency order)

```
1.  .env, .env.example
2.  src/common/types/job.types.ts
3.  src/common/types/step.types.ts
4.  src/common/repositories/tokens.ts
5.  src/common/repositories/job.repository.interface.ts
6.  src/common/repositories/job.repository.ts
7.  src/common/repositories/column-config.repository.interface.ts
8.  src/common/repositories/column-config.repository.ts
9.  src/common/repositories/video-hash.repository.interface.ts
10. src/common/repositories/video-hash.repository.ts
11. src/common/validators/gemini-response.schema.ts
12. src/common/filters/http-exception.filter.ts
13. src/config/app.config.ts
14. src/gemini/gemini.service.ts + module
15. src/screenshot/screenshot.service.ts + module
16. src/video/video.service.ts + module
17. src/column-configs/dto/column-config.dto.ts
18. src/column-configs/column-configs.service.ts
19. src/column-configs/column-configs.controller.ts + module
20. src/jobs/dto/*.dto.ts
21. src/jobs/jobs.service.ts
22. src/jobs/jobs.controller.ts + module
23. src/app.module.ts (update)
24. src/main.ts (update)
```
