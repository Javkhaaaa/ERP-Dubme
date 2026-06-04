# ERP-Dubme

Хятад, англи, япон, солонгос гэх мэт олон хэлний видеог монгол хадмал
эсвэл монгол дуутайгаар автоматаар дамжуулдаг AI dubbing платформ.

## Бүтэц

```
dubme-backend/   — Fastify + Prisma + S3 backend, AI pipeline
dubme-frontend/  — Next.js (App Router) UI
```

## Стек

| Үе шат | Үйлчилгээ |
|---|---|
| Object storage | DigitalOcean Spaces (S3-нийцтэй) |
| Database | Supabase Postgres |
| STT (speech-to-text) | Groq Whisper-large-v3 |
| Translation + Refine | Google Gemini 2.5 Pro (thinking) |
| TTS (optional) | Gemini Flash TTS · Chimege |
| Video download | yt-dlp (YouTube/Bilibili/Vimeo/~1000 сайт) |
| Render / Mux / Burn | ffmpeg + libass |

## Боломжууд

- 📁 **Видео upload** — browser-оос шууд DO Spaces руу
- 🔗 **URL-аас тат** — direct .mp4 эсвэл yt-dlp дамжуулсан streaming сайт
- 📄 **SRT + Видео** — бэлэн хадмалыг орчуулаад mux хийнэ
- ✏️ **Орчуулга шалгах** — мөр тус бүрээр засаж болно
- ✨ **AI-аар сайжруулах** — жанрд тулгуурласан (мэдээ, аймшгийн кино, инээдмийн г.м.)
- 🎨 **Хадмалын загвар** — өнгө, дэвсгэр, фонт хэмжээ, байрлал + live preview
- 📥 **SRT-г render-аас өмнө татах** — Mongol / эх хэл / хос хувилбараар
- 🔥 **Видеон дээр шатаах** (hardsub) эсвэл тусдаа SRT файл
- 🌐 **16 эх хэл** — хятад, англи, япон, солонгос, орос, испани, ...

## Эхлүүлэх

Backend болон Frontend-ын README-аас тус бүрд нь тохирох заавар:

- [dubme-backend/README.md](dubme-backend/README.md)
- [dubme-frontend/README.md](dubme-frontend/README.md)

## License

MIT
