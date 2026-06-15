import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

/**
 * Centralized config — load once, fail fast at startup if anything required is missing.
 * This avoids `process.env.X!` scattered through the codebase.
 */
export const config = {
  port: Number(optional("PORT", "3001")),
  nodeEnv: optional("NODE_ENV", "development"),
  webOrigin: optional("WEB_ORIGIN", "http://localhost:3000"),

  databaseUrl: required("DATABASE_URL"),

  // S3-compatible object storage (DigitalOcean Spaces, Storj, AWS S3, ...).
  // Endpoint + region pair determine the provider.
  s3: {
    accessKeyId: required("S3_ACCESS_KEY_ID"),
    secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
    endpoint: optional("S3_ENDPOINT", "https://sgp1.digitaloceanspaces.com"),
    region: optional("S3_REGION", "sgp1"),
    bucket: required("S3_BUCKET"),
  },

  groqApiKey: required("GROQ_API_KEY"),
  geminiApiKey: required("GEMINI_API_KEY"),
  /** Optional — only required when ttsProvider="chimege" on a job. */
  chimegeTtsToken: optional("CHIMEGE_TTS_TOKEN", ""),
  /** Optional — only required when ttsProvider="elevenlabs" on a job. */
  elevenLabsApiKey: optional("ELEVENLABS_API_KEY", ""),
  /** ElevenLabs model. v3 = expressive + audio tags; switch to
   *  eleven_multilingual_v2 if v3 API access is gated on your account. */
  elevenLabsModel: optional("ELEVENLABS_MODEL", "eleven_v3"),
} as const;

export type AppConfig = typeof config;
