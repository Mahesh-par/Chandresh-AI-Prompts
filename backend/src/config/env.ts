import dotenv from "dotenv";
import path from "path";

dotenv.config();

function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4646),
  mongodbUri: requireEnv("MONGODB_URI"),
  n8nWebhookUrl: requireEnv("N8N_WEBHOOK_URL"),
  timezone: process.env.TIMEZONE ?? "Asia/Kolkata",
  chromeUserDataDir:
    process.env.CHROME_USER_DATA_DIR ??
    path.join(process.cwd(), ".chrome-session"),
  chromeExecutablePath: process.env.CHROME_EXECUTABLE_PATH,
  geminiAppUrl: process.env.GEMINI_APP_URL ?? "https://gemini.google.com/app",
  geminiUiTimeoutMs: Number(process.env.GEMINI_UI_TIMEOUT_MS ?? 60000),
  geminiGenerationTimeoutMs: Number(
    process.env.GEMINI_GENERATION_TIMEOUT_MS ?? 300000,
  ),
  geminiBetweenPromptsMs: Number(process.env.GEMINI_BETWEEN_PROMPTS_MS ?? 2000),
  geminiMaxPromptAttempts: Number(process.env.GEMINI_MAX_PROMPT_ATTEMPTS ?? 2),
  geminiDownloadTimeoutMs: Number(
    process.env.GEMINI_DOWNLOAD_TIMEOUT_MS ?? 60000,
  ),
  geminiImageDetectTimeoutMs: Number(
    process.env.GEMINI_IMAGE_DETECT_TIMEOUT_MS ?? 60000,
  ),
  mockupsBasePath:
    process.env.MOCKUPS_BASE_PATH ??
    "C:\\Users\\par\\Pictures\\Chandresh Mockups",
  chromeWorkerCount: Number(process.env.CHROME_WORKER_COUNT ?? 5),
  geminiAttachmentWorkerCount: Number(
    process.env.GEMINI_ATTACHMENT_WORKER_COUNT ??
      process.env.CHROME_WORKER_COUNT ??
      5,
  ),
};
