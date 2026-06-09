import fs from "fs/promises";
import path from "path";
import type { Page } from "puppeteer";
import { launchBrowser, preparePage } from "../browser/session";
import { env } from "../config/env";
import { attachReferenceImages } from "./attachments";
import { findPromptInput, PROMPT_INPUT_SELECTORS } from "./input";

const SEND_BUTTON_SELECTOR = 'button[aria-label="Send message"]';
const GENERATED_IMAGE_SELECTORS = [
  "button.image-button img.image",
  ".image-container img.image",
];
const DOWNLOAD_BUTTON_SELECTOR =
  'button[aria-label="Download full-sized image"]';

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
  await page.waitForSelector(SEND_BUTTON_SELECTOR, {
    visible: true,
    timeout: env.geminiUiTimeoutMs,
  });

  await page.waitForFunction(
    (selector) => {
      const button = document.querySelector(selector) as HTMLButtonElement | null;
      return button && !button.disabled;
    },
    { timeout: env.geminiUiTimeoutMs },
    SEND_BUTTON_SELECTOR,
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
  await page.click(SEND_BUTTON_SELECTOR);
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

async function saveImageFromSrc(
  page: Page,
  imageCountBefore: number,
  savePath: string,
): Promise<void> {
  await waitForImageElementReady(page, imageCountBefore);

  const imageData = await page.evaluate(async (selectors, prevCount) => {
    const allImages: HTMLImageElement[] = [];

    for (const selector of selectors) {
      allImages.push(
        ...Array.from(
          document.querySelectorAll(selector),
        ) as HTMLImageElement[],
      );
    }

    const validImages = allImages.filter(
      (image) =>
        !!image.src &&
        (image.src.startsWith("blob:") || image.src.startsWith("http")),
    );

    if (validImages.length <= prevCount) {
      return { error: "No new generated image found." };
    }

    const latest = validImages[validImages.length - 1];
    if (!latest?.src) {
      return { error: "Generated image source URL not found." };
    }

    const imageToBytes = async (image: HTMLImageElement): Promise<number[]> => {
      if (image.src.startsWith("blob:")) {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth || image.width;
        canvas.height = image.naturalHeight || image.height;
        const context = canvas.getContext("2d");

        if (!context) {
          throw new Error("Canvas context unavailable.");
        }

        context.drawImage(image, 0, 0);
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/png"),
        );

        if (!blob) {
          throw new Error("Failed to convert image to blob.");
        }

        const buffer = await blob.arrayBuffer();
        return Array.from(new Uint8Array(buffer));
      }

      const response = await fetch(image.src);
      if (!response.ok) {
        throw new Error(`Image fetch failed with status ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
      return Array.from(new Uint8Array(buffer));
    };

    try {
      const bytes = await imageToBytes(latest);
      return { bytes };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Image save failed",
      };
    }
  }, GENERATED_IMAGE_SELECTORS, imageCountBefore);

  if (!imageData || "error" in imageData || !("bytes" in imageData)) {
    throw new Error(
      imageData && "error" in imageData
        ? imageData.error
        : "Failed to download generated image.",
    );
  }

  await fs.writeFile(savePath, Buffer.from(imageData.bytes));
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
    const downloaded = files.find(
      (file) =>
        !existingFiles.has(file) &&
        !file.endsWith(".crdownload") &&
        !file.endsWith(".tmp"),
    );

    if (downloaded) {
      const downloadedPath = path.join(folder, downloaded);
      const stats = await fs.stat(downloadedPath).catch(() => null);

      if (stats && stats.size > 0) {
        await delay(1000);
        return downloadedPath;
      }
    }

    await delay(500);
  }

  throw new Error("Timed out waiting for image download.");
}

async function clickLatestDownloadButton(page: Page): Promise<boolean> {
  const imageButtons = await page.$$("button.image-button");
  const latestImageButton = imageButtons[imageButtons.length - 1];

  if (!latestImageButton) {
    return false;
  }

  await latestImageButton.scrollIntoView();
  await latestImageButton.hover();
  await delay(1200);

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
      const downloadButton = container.querySelector(
        'button[aria-label="Download full-sized image"]',
      ) as HTMLButtonElement | null;

      if (downloadButton) {
        downloadButton.click();
        return true;
      }

      container = container.parentElement;
    }

    const fallbackButtons = Array.from(
      document.querySelectorAll('button[aria-label="Download full-sized image"]'),
    ) as HTMLButtonElement[];

    const fallback = fallbackButtons[fallbackButtons.length - 1];
    if (fallback) {
      fallback.click();
      return true;
    }

    return false;
  });

  if (clickedInContext) {
    return true;
  }

  const downloadButtons = await page.$$(DOWNLOAD_BUTTON_SELECTOR);
  const latestDownloadButton = downloadButtons[downloadButtons.length - 1];

  if (!latestDownloadButton) {
    return false;
  }

  await latestDownloadButton.click();
  return true;
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
    throw new Error("Download full-sized image button not found.");
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

  try {
    await saveImageFromSrc(page, imageCountBefore, finalSavePath);
    console.log(`Saved image to: ${finalSavePath}`);
    return finalSavePath;
  } catch (srcError) {
    console.log(
      "Direct image save failed, trying download button:",
      srcError instanceof Error ? srcError.message : srcError,
    );
    await downloadViaButton(page, workerDownloadDir, finalSavePath);
    console.log(`Downloaded image to: ${finalSavePath}`);
    return finalSavePath;
  }
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
  try {
    console.log(`${workerLabel} Sending prompt to Gemini: ${block.id}`);
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
      console.log(
        `${workerLabel} Gemini returned an error for ${block.id}. Skipping to next prompt.`,
      );
      await delay(env.geminiBetweenPromptsMs);
      return {
        id: block.id,
        success: false,
        skipped: true,
        error: "gemini_error",
      };
    }

    if (outcome === "no_image") {
      console.log(
        `${workerLabel} No image detected for ${block.id} after generation stopped. Skipping to next prompt.`,
      );
      await delay(env.geminiBetweenPromptsMs);
      return {
        id: block.id,
        success: false,
        skipped: true,
        error: "no_image_detected",
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
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`${workerLabel} Failed on ${block.id}:`, message);
    return { id: block.id, success: false, error: message };
  }
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
  const workerCount = Math.min(env.chromeWorkerCount, prompts.length);
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
