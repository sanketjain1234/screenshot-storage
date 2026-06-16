# Problems Encountered & How We Solved Them

## 1. Gemini Model Expiry / Deprecation

**Problem:** `gemini-2.0-flash` was shut down on June 1, 2026. Any job submitted after that date got a hard error from the API with no fallback.

**Solution:**
- Migrated primary model to `gemini-2.5-flash`.
- Added `GEMINI_MODEL` and `GEMINI_FALLBACK_MODEL` env vars so the model can be changed without a code deploy.
- Default fallback is `gemini-2.5-flash-lite` — a lighter, faster model used when the primary is unavailable.

---

## 2. Gemini 503 / Service Unavailable

**Problem:** The Gemini API occasionally returns HTTP 503 (Service Unavailable), especially during peak hours or when `gemini-2.5-flash` is under load. This was crashing jobs entirely.

**Solution:**
- Added `isServiceUnavailableError()` helper that detects `503`, `Service Unavailable`, and `UNAVAILABLE` in the error message.
- On 503 from the primary model, the service automatically retries the same request with the fallback model (`GEMINI_FALLBACK_MODEL`).
- If the fallback also fails, the error propagates normally and the job is marked `FAILED`.

---

## 3. Rate Limiting (429 / RESOURCE_EXHAUSTED)

**Problem:** The free-tier Gemini API enforces per-minute quota. Under load, multiple jobs would hit rate limits and fail.

**Solution:**
- Added `isRateLimitError()` detecting `429`, `Too Many Requests`, `RESOURCE_EXHAUSTED`, and `quota exceeded`.
- Implemented `generateWithRateLimitRetry()` with up to `MAX_RATE_LIMIT_RETRIES = 3` attempts.
- Delay between retries uses the value from Gemini's response header if available (`retryDelay` field), otherwise falls back to exponential backoff: **30s → 60s → 120s**.
- `parseRetryDelay()` parses both JSON format (`"retryDelay":"24s"`) and prose format (`"Please retry in 24.33s"`).

---

## 4. Gemini Hallucinating Timestamps Beyond Video Duration

**Problem:** Gemini would return step timestamps like `215s` for a video that was only `180s` long. This caused `ffmpeg` to fail silently or crash when trying to extract a frame at a non-existent timestamp, causing the entire job to fail.

**Solution (two-part):**
1. **Clamping:** After Gemini returns steps, `JobsService.processJob` clamps every `timestampSeconds` to `Math.max(0, videoDuration - 0.5)`. If a timestamp is clamped, a `WARN` log is emitted.
2. **Prompt constraints:** `prompt.config.json` now includes `timestampConstraints` with explicit instructions: "The video starts at 0.0s and ends at exactly `{VIDEO_DURATION_SECONDS}s`". The actual duration is injected at runtime. Gemini also gets monotonic ordering constraints.

---

## 5. Screenshot Extraction Crashing the Whole Job

**Problem:** If even one `ffmpeg` frame extraction failed (e.g., bad timestamp, codec issue), `Promise.all` would reject and the entire job was marked `FAILED` — even if 16 out of 17 steps succeeded.

**Solution:**
- Wrapped each `screenshotService.extractFrame()` call in a `try/catch` inside the `Promise.all` map.
- Failed screenshots log a `WARN` and return `{ ...step, screenshotUrl: undefined }` instead of throwing.
- The final count of failed screenshots is logged: `"3/17 failed"`.
- Job completes successfully as long as step generation worked, regardless of screenshot failures.

---

## 6. Screenshots as Base64 vs. URLs

**Problem:** The original implementation embedded base64-encoded PNG data directly in the JSON response. This made responses very large (400–800KB per step × 17 steps = potentially 10MB+ per response) and was not reusable.

**Solution:**
- `ScreenshotService.extractFrame()` now saves the PNG permanently to `SCREENSHOTS_DIR` (default: `/tmp/screenshots`) and returns a URL: `{APP_BASE_URL}/screenshots/{uuid}.png`.
- `main.ts` serves `SCREENSHOTS_DIR` as static assets at the `/screenshots` path using `app.useStaticAssets()`.
- `screenshotBase64` field was renamed to `screenshotUrl` across all types, DTOs, and services.
- Screenshots are never deleted — they remain accessible for as long as the server runs.

---

## 7. Gemini Returning Response Wrapped in Markdown Fences

**Problem:** Gemini sometimes wraps its JSON output in ` ```json ... ``` ` code fences, making `JSON.parse()` fail.

**Solution:**
- `stripJsonFences()` method strips leading ` ```json ` or ` ``` ` and trailing ` ``` ` before parsing.
- On parse failure, the raw response (truncated to 3000 chars) is debug-logged so the problem is diagnosable.

---

## 8. Gemini File Not Ready When `generateContent` Is Called

**Problem:** After uploading a video to the Gemini Files API, calling `generateContent` immediately would fail because Gemini hadn't finished processing the file yet (state: `PROCESSING`).

**Solution:**
- `waitUntilActive()` computes an initial wait time proportional to file size (using `GEMINI_UPLOAD_SPEED_MBPS` and `GEMINI_PROCESSING_BUFFER_SECONDS` config values), sleeps that duration, then polls every `POLL_INTERVAL_MS = 3000ms` until state becomes `ACTIVE`.
- Poll timeout is capped at `POLL_TIMEOUT_MS = 300000ms` (5 minutes). If still not active, throws `InternalServerErrorException`.

---

## 9. Duplicate Video Processing

**Problem:** Re-uploading the same video would re-run the full expensive Gemini pipeline (upload + wait + generate + screenshots), wasting time and API quota.

**Solution:**
- `VideoService.computeHash()` computes SHA-256 of the video file before processing.
- The hash is stored in `IVideoHashRepository`, mapped to the job ID.
- On subsequent uploads of the same video, if a `COMPLETED` job with the same hash exists, its result is directly reused and the job is immediately marked `COMPLETED`. Full pipeline is skipped.

---

## 10. Gemini Prompt Instructions Hard-coded in TypeScript

**Problem:** The full Gemini prompt was a large string embedded in `gemini.service.ts`, making it hard to iterate on without touching code.

**Solution:**
- Moved all prompt instructions to `src/gemini/prompt.config.json` with structured sections: `role`, `task`, `fields`, `timestampConstraints`, `outputConstraints`, `retryWarning`.
- The `{VIDEO_DURATION_SECONDS}` placeholder is injected at runtime via `buildPrompt()`.
- `nest-cli.json` assets configuration ensures the JSON file is copied to `dist/` during build.
