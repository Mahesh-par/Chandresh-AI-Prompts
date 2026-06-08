import path from "path";
import puppeteer, {
  type Browser,
  type Page,
  type PuppeteerLaunchOptions,
} from "puppeteer";
import { env } from "../config/env";

const STEALTH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-blink-features=AutomationControlled",
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export function getChromeUserDataDirForSession(sessionId = 1): string {
  const normalizedId = Math.max(1, Math.floor(sessionId));

  if (normalizedId === 1) {
    return env.chromeUserDataDir;
  }

  return `${env.chromeUserDataDir}-${normalizedId}`;
}

export function getChromeUserDataDir(): string {
  return getChromeUserDataDirForSession(1);
}

export async function launchBrowser(
  headless: boolean | "new" = "new",
  sessionId = 1,
): Promise<Browser> {
  const isHeaded = headless === false;
  const options: PuppeteerLaunchOptions = {
    headless,
    userDataDir: getChromeUserDataDirForSession(sessionId),
    args: isHeaded ? [...STEALTH_ARGS, "--start-maximized"] : STEALTH_ARGS,
    defaultViewport: isHeaded ? null : { width: 1280, height: 800 },
  };

  if (env.chromeExecutablePath) {
    options.executablePath = env.chromeExecutablePath;
  }

  return puppeteer.launch(options);
}

export async function preparePage(
  page: Page,
  options: { fixedViewport?: boolean } = {},
): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  if (options.fixedViewport ?? true) {
    await page.setViewport({ width: 1280, height: 800 });
  }

  await page.setUserAgent(USER_AGENT);
}
