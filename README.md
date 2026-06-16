# Video Test Script Generator

A NestJS API that accepts a video file or URL, sends it to the Gemini API, and generates a structured test script — with step numbers, actions, expected results, timestamps, and screenshot URLs for each step.

## Prerequisites

- **Node.js** v18+
- **ffmpeg** — bundled via `ffmpeg-static` and `@ffprobe-installer/ffprobe` (no manual install needed)
- **Gemini API key** — obtain from [Google AI Studio](https://aistudio.google.com/app/apikey)

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy the example env file and fill in your values
cp .env.example .env
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GEMINI_API_KEY` | **Yes** | — | Your Google Gemini API key |
| `GEMINI_MODEL` | No | `gemini-2.5-flash` | Primary Gemini model used for step generation |
| `GEMINI_FALLBACK_MODEL` | No | `gemini-2.5-flash-lite` | Fallback model if the primary returns 503 |
| `PORT` | No | `3000` | Port the HTTP server listens on |
| `MAX_FILE_SIZE_BYTES` | No | `209715200` | Max upload size in bytes (default: 200 MB) |
| `TEMP_DIR` | No | `/tmp` | Directory for temporary video downloads |
| `GEMINI_UPLOAD_SPEED_MBPS` | No | `1` | Estimated outbound bandwidth (Mbps) used to calculate Gemini polling wait time |
| `GEMINI_PROCESSING_BUFFER_SECONDS` | No | `30` | Extra buffer seconds added on top of the upload wait before polling Gemini |

> **Note:** `GEMINI_UPLOAD_SPEED_MBPS` and `GEMINI_PROCESSING_BUFFER_SECONDS` control how long the server waits before polling Gemini for file readiness. The formula is:
> `initialWait = ceil(fileSizeBytes / (UPLOAD_SPEED_MBPS × 125000)) + PROCESSING_BUFFER_SECONDS`, capped at 180 s.

### Minimal `.env`

```env
GEMINI_API_KEY=your_api_key_here
```

All other variables have sensible defaults.

## Running the App

```bash
# Development (watch mode)
npm run start:dev

# Production
npm run start:prod
```

The server starts at `http://localhost:3000` (or the configured `PORT`).  
Swagger UI is available at `http://localhost:3000/api`.

## API Overview

### Jobs

| Method | Path | Description |
|---|---|---|
| `POST` | `/jobs/upload` | Submit a video file (multipart/form-data) |
| `POST` | `/jobs/url` | Submit a video by URL |
| `GET` | `/jobs/:jobId` | Poll job status and retrieve results |

Jobs are processed asynchronously. Poll `GET /jobs/:jobId` until `status` is `COMPLETED` or `FAILED`.

**Supported video sources for URL jobs:**
- Whitelisted domains: `drive.google.com`, `youtube.com`, `dropbox.com`, `dl.dropboxusercontent.com`, `s3.amazonaws.com`, `storage.googleapis.com`, `loom.com`, `vimeo.com`
- Any domain with a direct video file extension (`.mp4`, `.mov`, `.webm`, `.avi`, `.mkv`)

**Constraints:**
- Max video duration: **240 seconds**
- Max file size: **200 MB** (default)
- Supported MIME types: `video/mp4`, `video/quicktime`, `video/webm`, `video/avi`, `video/x-msvideo`

### Column Configs

Optionally configure which columns appear in the generated steps, with custom labels and user-defined Gemini-powered fields.

| Method | Path | Description |
|---|---|---|
| `POST` | `/column-configs` | Create a column config |
| `GET` | `/column-configs` | List all configs |
| `GET` | `/column-configs/:id` | Get a config by ID |
| `PATCH` | `/column-configs/:id` | Update a config |
| `DELETE` | `/column-configs/:id` | Delete a config |

Pass `?configId=<id>` to any job submission endpoint to apply a specific column config.

### Screenshots

Screenshot frames are extracted per step and served as static files:

```
GET /screenshots/:filename.png
```

## Running Tests

```bash
# Unit tests
npm run test

# Unit tests with coverage
npm run test:cov

# Watch mode
npm run test:watch
```
