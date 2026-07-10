import fs from "fs/promises";
import path from "path";
import type { Page } from "puppeteer";
import { launchBrowser, preparePage } from "../browser/session";
import { env } from "../config/env";
import { attachReferenceImages } from "./attachments";
import { findPromptInput, PROMPT_INPUT_SELECTORS } from "./input";

const SEND_BUTTON_SELECTORS = [
  'button[aria-label="Send message"]',
  'button[aria-label="Send"]',
  'button[aria-label*="Send"]',
];
const GENERATED_IMAGE_SELECTORS = [
  "button.image-button img.image",
  ".image-container img.image",
  "img.image",
];

type GenerationOutcome = "image" | "error" | "no_image";

export interface PromptBlock {
  id: string;
  content: string;
  ChatTime?: string;
}

export interface GeminiSendResult {
  id: string;
  success: boolean;
  skipped?: boolean;
  error?: string;
  savedPath?: string;
}

export interface GeminiSendSummary {
  total: number;
  sent: number;
  skipped: number;
  failed: number;
  workers: number;
  projectFolder: string;
  results: GeminiSendResult[];
}

let geminiJobRunning = false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFolderName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, "").trim() || "Untitled Project";
}

function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, "-").trim() || "image.png";
}

async function ensureProjectFolder(projectName: string): Promise<string> {
  const folder = path.join(
    env.mockupsBasePath,
    sanitizeFolderName(projectName),
  );
  await fs.mkdir(folder, { recursive: true });
  return folder;
}

async function getGeneratedImageCount(page: Page): Promise<number> {
  return page.evaluate((selectors) => {
    let maxCount = 0;

    for (const selector of selectors) {
      const images = Array.from(
        document.querySelectorAll(selector),
      ) as HTMLImageElement[];

      const validImages = images.filter(
        (image) =>
          !!image.src &&
          (image.src.startsWith("blob:") || image.src.startsWith("http")),
      );

      maxCount = Math.max(maxCount, validImages.length);
    }

    return maxCount;
  }, GENERATED_IMAGE_SELECTORS);
}

async function findInputElement(page: Page) {
  return findPromptInput(page, {
    errorMessage: "Gemini prompt input not found. Open Gemini and try again.",
  });
}

async function waitForSendButton(page: Page) {
  await page.waitForFunction(
    (selectors) => {
      const buttons = selectors.flatMap((selector) =>
        Array.from(document.querySelectorAll(selector)) as HTMLButtonElement[],
      );

      return buttons.some((button) => {
        const rect = button.getBoundingClientRect();
        return !button.disabled && rect.width > 0 && rect.height > 0;
      });
    },
    { timeout: env.geminiUiTimeoutMs },
    SEND_BUTTON_SELECTORS,
  );
}

async function clearPromptInput(page: Page): Promise<void> {
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await delay(200);
}

async function typePromptText(page: Page, promptText: string): Promise<void> {
  const insertedWithCdp = await page
    .createCDPSession()
    .then(async (client) => {
      await client.send("Input.insertText", { text: promptText });
      return true;
    })
    .catch(() => false);

  if (!insertedWithCdp) {
    const insertedWithExecCommand = await page.evaluate((text, selectors) => {
      let input: HTMLElement | null = null;

      for (const selector of selectors) {
        input = document.querySelector(selector) as HTMLElement | null;
        if (input) {
          break;
        }
      }

      if (!input) {
        return false;
      }

      input.focus();
      document.execCommand("selectAll", false);
      document.execCommand("delete", false);
      const inserted = document.execCommand("insertText", false, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return inserted;
    }, promptText, PROMPT_INPUT_SELECTORS);

    if (!insertedWithExecCommand) {
      throw new Error("Failed to insert prompt text into Gemini input.");
    }
  } else {
    await page.evaluate((selectors) => {
      let input: HTMLElement | null = null;

      for (const selector of selectors) {
        input = document.querySelector(selector) as HTMLElement | null;
        if (input) {
          break;
        }
      }

      input?.dispatchEvent(new Event("input", { bubbles: true }));
    }, PROMPT_INPUT_SELECTORS);
  }

  await delay(500);
}

async function fillPromptInput(
  page: Page,
  promptText: string,
  attachmentImagePaths: string[] = [],
  workerLabel = "",
): Promise<void> {
  const { element } = await findInputElement(page);

  await element.click();
  await delay(300);
  await clearPromptInput(page);

  if (attachmentImagePaths.length > 0) {
    await attachReferenceImages(page, attachmentImagePaths, workerLabel);
  }

  await typePromptText(page, promptText);
}

async function clickSendButton(page: Page): Promise<void> {
  await waitForSendButton(page);

  const target = await page.evaluate((selectors) => {
    for (const selector of selectors) {
      const buttons = Array.from(
        document.querySelectorAll(selector),
      ) as HTMLButtonElement[];

      for (let index = buttons.length - 1; index >= 0; index -= 1) {
        const button = buttons[index];
        const rect = button.getBoundingClientRect();

        if (!button.disabled && rect.width > 0 && rect.height > 0) {
          return { selector, index };
        }
      }
    }

    return null;
  }, SEND_BUTTON_SELECTORS);

  if (!target) {
    throw new Error("Gemini send button not found or disabled.");
  }

  const buttons = await page.$$(target.selector);
  const button = buttons[target.index];

  if (!button) {
    throw new Error("Gemini send button disappeared before click.");
  }

  await button.click();
}

async function waitForGenerationOutcome(
  page: Page,
  imageCountBefore: number,
): Promise<GenerationOutcome> {
  const deadline = Date.now() + env.geminiGenerationTimeoutMs;
  let sawGenerating = false;
  let generationEndedAt = 0;

  while (Date.now() < deadline) {
    const status = await page.evaluate((selectors) => {
      const stopIcon = !!document.querySelector(
        'mat-icon[data-mat-icon-name="stop"]',
      );
      const creatingText = Array.from(
        document.querySelectorAll("div, span, p"),
      ).some((el) =>
        (el as HTMLElement).innerText?.includes("Creating your image"),
      );
      const errorText = Array.from(
        document.querySelectorAll("div, span, p"),
      ).some((el) => {
        const text = (el as HTMLElement).innerText?.trim() ?? "";
        return (
          text.includes("Sorry, something went wrong") ||
          text.includes("Please try your request again")
        );
      });

      let imageCount = 0;
      for (const selector of selectors) {
        const images = Array.from(
          document.querySelectorAll(selector),
        ) as HTMLImageElement[];
        const validImages = images.filter(
          (image) =>
            !!image.src &&
            (image.src.startsWith("blob:") || image.src.startsWith("http")),
        );
        imageCount = Math.max(imageCount, validImages.length);
      }

      return {
        generating: stopIcon || creatingText,
        imageCount,
        errorText,
      };
    }, GENERATED_IMAGE_SELECTORS);

    if (status.generating) {
      sawGenerating = true;
      generationEndedAt = 0;
    } else if (sawGenerating && generationEndedAt === 0) {
      generationEndedAt = Date.now();
    }

    if (status.imageCount > imageCountBefore) {
      await delay(2000);
      return "image";
    }

    if (status.errorText && !status.generating) {
      return "error";
    }

    if (
      sawGenerating &&
      !status.generating &&
      generationEndedAt > 0 &&
      Date.now() - generationEndedAt > env.geminiImageDetectTimeoutMs
    ) {
      break;
    }

    await delay(500);
  }

  const finalCount = await getGeneratedImageCount(page);
  if (finalCount > imageCountBefore) {
    await delay(1500);
    return "image";
  }

  return "no_image";
}

function getWorkerDownloadDir(
  projectFolder: string,
  sessionId: number,
): string {
  return path.join(projectFolder, ".downloads", `chrome-${sessionId}`);
}

async function ensureDirectory(folder: string): Promise<void> {
  await fs.mkdir(folder, { recursive: true });
}

function getFinalImagePath(projectFolder: string, blockId: string): string {
  return path.join(projectFolder, sanitizeFileName(`${blockId}.png`));
}

async function waitForImageElementReady(
  page: Page,
  imageCountBefore: number,
): Promise<void> {
  await page.waitForFunction(
    (selectors, prevCount) => {
      const images: HTMLImageElement[] = [];

      for (const selector of selectors) {
        images.push(
          ...Array.from(
            document.querySelectorAll(selector),
          ) as HTMLImageElement[],
        );
      }

      const validImages = images.filter(
        (image) =>
          !!image.src &&
          (image.src.startsWith("blob:") || image.src.startsWith("http")),
      );

      if (validImages.length <= prevCount) {
        return false;
      }

      const latest = validImages[validImages.length - 1];
      return latest.complete && latest.naturalWidth > 0;
    },
    { timeout: env.geminiImageDetectTimeoutMs },
    GENERATED_IMAGE_SELECTORS,
    imageCountBefore,
  );
}

async function listFolderFiles(folder: string): Promise<string[]> {
  try {
    return await fs.readdir(folder);
  } catch {
    return [];
  }
}

async function waitForDownloadedFile(
  folder: string,
  existingFiles: Set<string>,
): Promise<string> {
  const deadline = Date.now() + env.geminiDownloadTimeoutMs;

  while (Date.now() < deadline) {
    const files = await listFolderFiles(folder);
    const candidates = await Promise.all(
      files
        .filter(
          (file) =>
            !existingFiles.has(file) &&
            !file.endsWith(".crdownload") &&
            !file.endsWith(".tmp"),
        )
        .map(async (file) => {
          const filePath = path.join(folder, file);
          const stats = await fs.stat(filePath).catch(() => null);
          return stats ? { filePath, size: stats.size, mtimeMs: stats.mtimeMs } : null;
        }),
    );

    const newestCandidates = candidates
      .filter(
        (
          candidate,
        ): candidate is { filePath: string; size: number; mtimeMs: number } =>
          !!candidate && candidate.size > 0,
      )
      .sort((first, second) => second.mtimeMs - first.mtimeMs);

    for (const candidate of newestCandidates) {
      await delay(1000);
      const statsAfterDelay = await fs.stat(candidate.filePath).catch(() => null);

      if (statsAfterDelay?.size === candidate.size) {
        return candidate.filePath;
      }
    }

    await delay(500);
  }

  throw new Error("Timed out waiting for image download.");
}

async function clickVisibleDownloadButton(page: Page): Promise<boolean> {
  const targetIndex = await page.evaluate(() => {
    const buttons = Array.from(
      document.querySelectorAll("button"),
    ) as HTMLButtonElement[];

    for (let index = buttons.length - 1; index >= 0; index -= 1) {
      const button = buttons[index];
      const label = button.getAttribute("aria-label")?.toLowerCase() ?? "";
      const rect = button.getBoundingClientRect();

      if (
        !button.disabled &&
        label.includes("download") &&
        label.includes("image") &&
        rect.width > 0 &&
        rect.height > 0
      ) {
        return index;
      }
    }

    return -1;
  });

  if (targetIndex >= 0) {
    const buttons = await page.$$("button");
    const button = buttons[targetIndex];

    if (button) {
      await button.click();
      return true;
    }
  }

  return page.evaluate(() => {
    const buttons = Array.from(
      document.querySelectorAll("button"),
    ) as HTMLButtonElement[];

    const button = buttons.reverse().find((candidate) => {
      const label = candidate.getAttribute("aria-label")?.toLowerCase() ?? "";
      const rect = candidate.getBoundingClientRect();
      return (
        !candidate.disabled &&
        label.includes("download") &&
        label.includes("image") &&
        rect.width > 0 &&
        rect.height > 0
      );
    });

    if (!button) {
      return false;
    }

    button.click();
    return true;
  });
}

async function clickLatestDownloadButton(page: Page): Promise<boolean> {
  const latestImageElement =
    (await page.$$("button.image-button")).pop() ??
    (await page.$$(GENERATED_IMAGE_SELECTORS.join(","))).pop();

  if (!latestImageElement) {
    return false;
  }

  await latestImageElement.scrollIntoView();
  await latestImageElement.hover();
  await delay(1200);

  await page
    .waitForFunction(
      () => {
        const buttons = Array.from(
          document.querySelectorAll("button"),
        ) as HTMLButtonElement[];

        return buttons.some((button) => {
          const label = button.getAttribute("aria-label")?.toLowerCase() ?? "";
          const rect = button.getBoundingClientRect();
          return (
            !button.disabled &&
            label.includes("download") &&
            label.includes("image") &&
            rect.width > 0 &&
            rect.height > 0
          );
        });
      },
      { timeout: 5000 },
    )
    .catch(() => undefined);

  if (await clickVisibleDownloadButton(page)) {
    return true;
  }

  await latestImageElement.click().catch(() => undefined);
  await delay(1200);

  if (await clickVisibleDownloadButton(page)) {
    return true;
  }

  const clickedInContext = await page.evaluate(() => {
    const imageButtons = Array.from(
      document.querySelectorAll("button.image-button"),
    );
    const latestImageButton = imageButtons[imageButtons.length - 1];

    if (!latestImageButton) {
      return false;
    }

    let container: Element | null = latestImageButton;

    for (let depth = 0; depth < 8 && container; depth += 1) {
      const buttons = Array.from(
        container.querySelectorAll("button"),
      ) as HTMLButtonElement[];
      const downloadButton = buttons.reverse().find((button) => {
        const label = button.getAttribute("aria-label")?.toLowerCase() ?? "";
        return label.includes("download") && label.includes("image");
      });

      if (downloadButton && !downloadButton.disabled) {
        downloadButton.click();
        return true;
      }

      container = container.parentElement;
    }

    const fallbackButtons = Array.from(
      document.querySelectorAll("button"),
    ) as HTMLButtonElement[];

    const fallback = fallbackButtons
      .reverse()
      .find((button) => {
        const label = button.getAttribute("aria-label")?.toLowerCase() ?? "";
        return (
          label.includes("download") &&
          label.includes("image") &&
          !button.disabled
        );
      });
    if (fallback) {
      fallback.click();
      return true;
    }

    return false;
  });

  if (clickedInContext) {
    return true;
  }

  return clickVisibleDownloadButton(page);
}

async function downloadViaButton(
  page: Page,
  workerDownloadDir: string,
  finalSavePath: string,
): Promise<void> {
  await ensureDirectory(workerDownloadDir);

  const client = await page.createCDPSession();
  await client.send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: workerDownloadDir,
  });

  const existingFiles = new Set(await listFolderFiles(workerDownloadDir));
  const clicked = await clickLatestDownloadButton(page);

  if (!clicked) {
    throw new Error("Gemini image download button not found.");
  }

  const downloadedPath = await waitForDownloadedFile(
    workerDownloadDir,
    existingFiles,
  );

  await fs.copyFile(downloadedPath, finalSavePath);
  await fs.unlink(downloadedPath).catch(() => undefined);
}

async function downloadLatestGeneratedImage(
  page: Page,
  imageCountBefore: number,
  projectFolder: string,
  workerDownloadDir: string,
  blockId: string,
): Promise<string> {
  const finalSavePath = getFinalImagePath(projectFolder, blockId);
  await ensureDirectory(path.dirname(finalSavePath));
  await ensureDirectory(workerDownloadDir);

  await waitForImageElementReady(page, imageCountBefore);
  await downloadViaButton(page, workerDownloadDir, finalSavePath);
  console.log(`Downloaded image with Gemini button to: ${finalSavePath}`);
  return finalSavePath;
}

interface WorkerChunk {
  sessionId: number;
  prompts: PromptBlock[];
}

function splitPromptsAcrossWorkers(
  prompts: PromptBlock[],
  workerCount: number,
): WorkerChunk[] {
  const chunks: PromptBlock[][] = Array.from({ length: workerCount }, () => []);

  prompts.forEach((prompt, index) => {
    chunks[index % workerCount].push(prompt);
  });

  return chunks
    .map((chunk, index) => ({ sessionId: index + 1, prompts: chunk }))
    .filter((chunk) => chunk.prompts.length > 0);
}

async function sendSinglePrompt(
  page: Page,
  block: PromptBlock,
  projectFolder: string,
  workerDownloadDir: string,
  workerLabel: string,
  attachmentImagePaths: string[] = [],
): Promise<GeminiSendResult> {
  const maxAttempts = Math.max(1, Math.floor(env.geminiMaxPromptAttempts));
  let lastError = "Unknown error";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptLabel =
      maxAttempts > 1 ? ` (attempt ${attempt}/${maxAttempts})` : "";
    const isFinalAttempt = attempt === maxAttempts;

    try {
      console.log(
        `${workerLabel} Sending prompt to Gemini: ${block.id}${attemptLabel}`,
      );
      const imageCountBefore = await getGeneratedImageCount(page);

      await fillPromptInput(
        page,
        block.content,
        attachmentImagePaths,
        workerLabel,
      );
      await clickSendButton(page);

      const outcome = await waitForGenerationOutcome(page, imageCountBefore);

      if (outcome === "error") {
        lastError = "gemini_error";
        console.log(`${workerLabel} Gemini returned an error for ${block.id}.`);

        if (!isFinalAttempt) {
          console.log(`${workerLabel} Retrying ${block.id} after Gemini error.`);
          await delay(Math.max(env.geminiBetweenPromptsMs, 5000));
          continue;
        }

        await delay(env.geminiBetweenPromptsMs);
        return {
          id: block.id,
          success: false,
          skipped: true,
          error: lastError,
        };
      }

      if (outcome === "no_image") {
        lastError = "no_image_detected";
        console.log(
          `${workerLabel} No image detected for ${block.id} after generation stopped.`,
        );

        if (!isFinalAttempt) {
          console.log(`${workerLabel} Retrying ${block.id} for a new image.`);
          await delay(Math.max(env.geminiBetweenPromptsMs, 5000));
          continue;
        }

        console.log(`${workerLabel} Skipping ${block.id} after ${maxAttempts} attempt(s).`);
        await delay(env.geminiBetweenPromptsMs);
        return {
          id: block.id,
          success: false,
          skipped: true,
          error: lastError,
        };
      }

      const savedPath = await downloadLatestGeneratedImage(
        page,
        imageCountBefore,
        projectFolder,
        workerDownloadDir,
        block.id,
      );

      await delay(env.geminiBetweenPromptsMs);

      return { id: block.id, success: true, savedPath };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown error";
      console.error(
        `${workerLabel} Failed on ${block.id}${attemptLabel}:`,
        lastError,
      );

      if (!isFinalAttempt) {
        console.log(`${workerLabel} Retrying ${block.id} after failure.`);
        await delay(Math.max(env.geminiBetweenPromptsMs, 5000));
        continue;
      }
    }
  }

  return { id: block.id, success: false, error: lastError };
}

async function runChromeWorker(
  sessionId: number,
  prompts: PromptBlock[],
  projectFolder: string,
  attachmentImagePaths: string[],
): Promise<GeminiSendResult[]> {
  const workerLabel = `[Chrome ${sessionId}]`;
  const workerDownloadDir = getWorkerDownloadDir(projectFolder, sessionId);
  const browser = await launchBrowser(false, sessionId);
  const page = await browser.newPage();

  try {
    await ensureDirectory(workerDownloadDir);
    await preparePage(page, { fixedViewport: false });

    console.log(`${workerLabel} Opening Gemini: ${env.geminiAppUrl}`);
    console.log(`${workerLabel} Assigned ${prompts.length} prompt(s)`);

    await page.goto(env.geminiAppUrl, {
      waitUntil: "networkidle2",
      timeout: env.geminiUiTimeoutMs,
    });

    await delay(3000);
    await findPromptInput(page, {
      wait: true,
      timeoutMs: env.geminiUiTimeoutMs,
      errorMessage: "Gemini prompt input not found. Open Gemini and try again.",
    });

    const results: GeminiSendResult[] = [];

    for (const block of prompts) {
      const result = await sendSinglePrompt(
        page,
        block,
        projectFolder,
        workerDownloadDir,
        workerLabel,
        attachmentImagePaths,
      );
      results.push(result);
    }

    return results;
  } finally {
    await browser.close();
  }
}

export async function sendPromptsToGemini(
  prompts: PromptBlock[],
  projectName: string,
  attachmentImagePaths: string[] = [],
): Promise<GeminiSendSummary> {
  if (geminiJobRunning) {
    throw new Error(
      "A Gemini send job is already running. Wait for it to finish.",
    );
  }

  if (prompts.length === 0) {
    throw new Error("No prompt blocks found to send.");
  }

  geminiJobRunning = true;
  const projectFolder = await ensureProjectFolder(projectName);
  const configuredWorkerCount =
    attachmentImagePaths.length > 0
      ? Math.min(env.chromeWorkerCount, env.geminiAttachmentWorkerCount)
      : env.chromeWorkerCount;
  const workerCount = Math.max(1, Math.min(configuredWorkerCount, prompts.length));
  const workerChunks = splitPromptsAcrossWorkers(prompts, workerCount);

  try {
    console.log(
      `Starting ${workerChunks.length} Chrome worker(s) for ${prompts.length} prompt(s)`,
    );
    console.log(`Saving images to: ${projectFolder}`);
    if (attachmentImagePaths.length > 0) {
      console.log(
        `Using ${attachmentImagePaths.length} reference attachment(s) with every prompt`,
      );
      if (workerCount < env.chromeWorkerCount) {
        console.log(
          `Attachment mode limited to ${workerCount} Chrome worker(s) for reliability`,
        );
      }
    }

    workerChunks.forEach((chunk) => {
      console.log(
        `[Chrome ${chunk.sessionId}] Blocks: ${chunk.prompts.map((prompt) => prompt.id).join(", ")}`,
      );
    });

    const workerResults = await Promise.all(
      workerChunks.map((chunk) =>
        runChromeWorker(
          chunk.sessionId,
          chunk.prompts,
          projectFolder,
          attachmentImagePaths,
        ),
      ),
    );

    const results = workerResults.flat();
    const sent = results.filter((result) => result.success).length;
    const skipped = results.filter((result) => result.skipped).length;
    const failed = results.filter(
      (result) => !result.success && !result.skipped,
    ).length;

    return {
      total: prompts.length,
      sent,
      skipped,
      failed,
      workers: workerChunks.length,
      projectFolder,
      results,
    };
  } finally {
    geminiJobRunning = false;
  }
}
