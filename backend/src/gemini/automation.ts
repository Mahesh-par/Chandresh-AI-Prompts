import fs from "fs/promises";
import path from "path";
import type { Page } from "puppeteer";
import { launchBrowser, preparePage } from "../browser/session";
import { env } from "../config/env";

const INPUT_SELECTORS = [
  "div.text-input-field.simplified-input-area [contenteditable='true']",
  "div.text-input-field.simplified-input-area",
  "rich-textarea .ql-editor",
  "div[contenteditable='true'].ql-editor",
];

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
  for (const selector of INPUT_SELECTORS) {
    const element = await page.$(selector);
    if (element) {
      return { element, selector };
    }
  }

  throw new Error("Gemini prompt input not found. Open Gemini and try again.");
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

async function fillPromptInput(
  page: Page,
  promptText: string,
): Promise<void> {
  const { element } = await findInputElement(page);

  await element.click();
  await delay(300);
  await clearPromptInput(page);

  const insertedWithCdp = await page
    .createCDPSession()
    .then(async (client) => {
      await client.send("Input.insertText", { text: promptText });
      return true;
    })
    .catch(() => false);

  if (!insertedWithCdp) {
    const insertedWithExecCommand = await page.evaluate((text) => {
      const input =
        (document.querySelector(
          "div.text-input-field.simplified-input-area [contenteditable='true']",
        ) as HTMLElement | null) ??
        (document.querySelector(
          "div.text-input-field.simplified-input-area",
        ) as HTMLElement | null);

      if (!input) {
        return false;
      }

      input.focus();
      document.execCommand("selectAll", false);
      document.execCommand("delete", false);
      const inserted = document.execCommand("insertText", false, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return inserted;
    }, promptText);

    if (!insertedWithExecCommand) {
      throw new Error("Failed to insert prompt text into Gemini input.");
    }
  } else {
    await page.evaluate(() => {
      const input =
        (document.querySelector(
          "div.text-input-field.simplified-input-area [contenteditable='true']",
        ) as HTMLElement | null) ??
        (document.querySelector(
          "div.text-input-field.simplified-input-area",
        ) as HTMLElement | null);

      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  await delay(500);
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

async function saveImageFromSrc(
  page: Page,
  imageCountBefore: number,
  projectFolder: string,
  blockId: string,
): Promise<string> {
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

    try {
      const response = await fetch(latest.src);
      if (!response.ok) {
        return { error: `Image fetch failed with status ${response.status}` };
      }

      const buffer = await response.arrayBuffer();
      return { bytes: Array.from(new Uint8Array(buffer)) };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Image fetch failed",
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

  const fileName = sanitizeFileName(`${blockId}.png`);
  const savePath = path.join(projectFolder, fileName);
  await fs.writeFile(savePath, Buffer.from(imageData.bytes));
  return savePath;
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
      await delay(1000);
      return path.join(folder, downloaded);
    }

    await delay(500);
  }

  throw new Error("Timed out waiting for image download.");
}

async function downloadViaButton(
  page: Page,
  projectFolder: string,
  blockId: string,
): Promise<string> {
  const client = await page.createCDPSession();
  await client.send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: projectFolder,
  });

  const imageButtons = await page.$$("button.image-button");
  const latestImageButton = imageButtons[imageButtons.length - 1];

  if (!latestImageButton) {
    throw new Error("Generated image container not found.");
  }

  await latestImageButton.scrollIntoView();
  await latestImageButton.hover();
  await delay(800);

  const existingFiles = new Set(await listFolderFiles(projectFolder));
  const downloadButtons = await page.$$(DOWNLOAD_BUTTON_SELECTOR);
  const latestDownloadButton = downloadButtons[downloadButtons.length - 1];

  if (!latestDownloadButton) {
    throw new Error("Download full-sized image button not found.");
  }

  await latestDownloadButton.click();
  const downloadedPath = await waitForDownloadedFile(
    projectFolder,
    existingFiles,
  );

  const targetName = sanitizeFileName(`${blockId}${path.extname(downloadedPath) || ".png"}`);
  const targetPath = path.join(projectFolder, targetName);

  if (downloadedPath !== targetPath) {
    await fs.rename(downloadedPath, targetPath);
  }

  return targetPath;
}

async function downloadLatestGeneratedImage(
  page: Page,
  imageCountBefore: number,
  projectFolder: string,
  blockId: string,
): Promise<string> {
  try {
    const savePath = await saveImageFromSrc(
      page,
      imageCountBefore,
      projectFolder,
      blockId,
    );
    console.log(`Saved image to: ${savePath}`);
    return savePath;
  } catch (srcError) {
    console.log(
      "Direct image save failed, trying download button:",
      srcError instanceof Error ? srcError.message : srcError,
    );
    const savePath = await downloadViaButton(page, projectFolder, blockId);
    console.log(`Downloaded image to: ${savePath}`);
    return savePath;
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
  workerLabel: string,
): Promise<GeminiSendResult> {
  try {
    console.log(`${workerLabel} Sending prompt to Gemini: ${block.id}`);
    const imageCountBefore = await getGeneratedImageCount(page);

    await fillPromptInput(page, block.content);
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
): Promise<GeminiSendResult[]> {
  const workerLabel = `[Chrome ${sessionId}]`;
  const browser = await launchBrowser(false, sessionId);
  const page = await browser.newPage();

  try {
    await preparePage(page, { fixedViewport: false });

    console.log(`${workerLabel} Opening Gemini: ${env.geminiAppUrl}`);
    console.log(`${workerLabel} Assigned ${prompts.length} prompt(s)`);

    await page.goto(env.geminiAppUrl, {
      waitUntil: "networkidle2",
      timeout: env.geminiUiTimeoutMs,
    });

    await delay(3000);
    await findInputElement(page);

    const results: GeminiSendResult[] = [];

    for (const block of prompts) {
      const result = await sendSinglePrompt(
        page,
        block,
        projectFolder,
        workerLabel,
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

    workerChunks.forEach((chunk) => {
      console.log(
        `[Chrome ${chunk.sessionId}] Blocks: ${chunk.prompts.map((prompt) => prompt.id).join(", ")}`,
      );
    });

    const workerResults = await Promise.all(
      workerChunks.map((chunk) =>
        runChromeWorker(chunk.sessionId, chunk.prompts, projectFolder),
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
