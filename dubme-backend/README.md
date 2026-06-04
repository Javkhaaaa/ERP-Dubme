# dubme-backend

Хятад → Монгол видео dubbing-ийн API сервер.

## Stack

- **Fastify** — HTTP сервер
- **Prisma + Postgres** (Supabase) — database
- **DigitalOcean Spaces** — S3-compatible object storage (Storj/AWS S3 ч таарна)
- **Groq** — Whisper-large-v3 STT
- **Gemini 2.5 Pro** — орчуулга
- **Gemini 3.1 Flash TTS** — Монгол хоолой
- **ffmpeg** — audio extract / mix / mux

## Эхлүүлэх

```bash
# 1. Dependencies
yarn install

# 2. Env
cp .env.example .env
# → DATABASE_URL, S3_*, GROQ_API_KEY, GEMINI_API_KEY бөглөх

# 3. Database
yarn db:generate
yarn db:migrate

# 4. Dev сервер
yarn dev
# → http://localhost:3001
```

## Ажиллах нөхцөл

- Node.js 20+
- ffmpeg (`brew install ffmpeg`)

## API endpoints

| URL | Зориулалт |
|-----|-----------|
| `POST /api/jobs` | Шинэ job + S3 presigned upload URL |
| `POST /api/jobs/:id/start` | Pipeline эхлүүлэх |
| `GET /api/jobs/:id` | Status polling |
| `GET /api/jobs/:id/segments` | Segments (орчуулсан) |
| `PATCH /api/segments/:id` | Segment-ийн орчуулга засах |
| `POST /api/jobs/:id/render` | Render trigger (voice сонголттой) |
| `GET /api/jobs/:id/download` | Эцсийн mp4 + srt presigned URL |

## Production

```bash
yarn build
yarn start
```
