import fs from "fs/promises";
import path from "path";
import type { Page } from "puppeteer";
import { focusPromptInput, PROMPT_INPUT_SELECTORS } from "./input";

const FILE_INPUT_SELECTORS = [
  'input[type="file"]',
  'input[type="file"][accept*="image"]',
];

const ATTACH_BUTTON_SELECTORS = [
  'button[aria-label="Open upload file menu"]',
  'button[aria-label="Add files"]',
  'button[aria-label="Upload file"]',
  'button[aria-label="Attach"]',
];

const ATTACHMENT_READY_TIMEOUT_MS = 15000;
const ATTACHMENT_SETTLE_MS = 3500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  return "image/jpeg";
}

async function attachmentPreviewVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const selectors = [
      'img[src^="blob:"]',
      '[class*="attachment"]',
      '[class*="upload"]',
      '[class*="preview"]',
      '[data-testid*="attachment"]',
    ];

    return selectors.some((selector) => document.querySelector(selector));
  });
}

async function waitForAttachmentReady(page: Page): Promise<boolean> {
  const deadline = Date.now() + ATTACHMENT_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await attachmentPreviewVisible(page)) {
      await delay(ATTACHMENT_SETTLE_MS);
      return true;
    }

    await delay(500);
  }

  return false;
}

async function pasteImageIntoPrompt(
  page: Page,
  imagePath: string,
): Promise<boolean> {
  const buffer = await fs.readFile(imagePath);
  const fileName = path.basename(imagePath);
  const mimeType = getMimeType(imagePath);

  const pasteEventDispatched = await page.evaluate(
    async (bytes, name, type, selectors) => {
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

      try {
        const uint8 = new Uint8Array(bytes);
        const blob = new Blob([uint8], { type });
        const file = new File([blob], name, { type });
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);

        const pasteEvent = new ClipboardEvent("paste", {
          clipboardData: dataTransfer,
          bubbles: true,
          cancelable: true,
        });

        input.dispatchEvent(pasteEvent);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      } catch {
        return false;
      }
    },
    Array.from(buffer),
    fileName,
    mimeType,
    PROMPT_INPUT_SELECTORS,
  );

  if (!pasteEventDispatched) {
    return false;
  }

  return waitForAttachmentReady(page);
}

async function uploadImageViaHiddenInput(
  page: Page,
  imagePath: string,
): Promise<boolean> {
  for (const selector of FILE_INPUT_SELECTORS) {
    const input = await page.$(selector);
    if (!input) {
      continue;
    }

    await (input as import("puppeteer").ElementHandle<HTMLInputElement>).uploadFile(
      imagePath,
    );
    return waitForAttachmentReady(page);
  }

  return false;
}

async function uploadImageViaFileChooser(
  page: Page,
  imagePath: string,
): Promise<boolean> {
  for (const selector of ATTACH_BUTTON_SELECTORS) {
    const button = await page.$(selector);
    if (!button) {
      continue;
    }

    try {
      const [fileChooser] = await Promise.all([
        page.waitForFileChooser({ timeout: 5000 }),
        button.click(),
      ]);

      await fileChooser.accept([imagePath]);
      return waitForAttachmentReady(page);
    } catch {
      continue;
    }
  }

  const openedMenu = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const plusButton = buttons.find((button) => {
      const label = button.getAttribute("aria-label")?.toLowerCase() ?? "";
      const text = button.textContent?.trim() ?? "";
      return label.includes("upload") || label.includes("add") || text === "+";
    });

    plusButton?.click();
    return !!plusButton;
  });

  if (!openedMenu) {
    return false;
  }

  await delay(500);

  const uploadedFromMenu = await uploadImageViaHiddenInput(page, imagePath);
  if (uploadedFromMenu) {
    return true;
  }

  try {
    const menuUploadButton = await page.$(
      'button[aria-label="Upload files"], button[aria-label="Upload a file"]',
    );

    if (!menuUploadButton) {
      return false;
    }

    const [fileChooser] = await Promise.all([
      page.waitForFileChooser({ timeout: 5000 }),
      menuUploadButton.click(),
    ]);

    await fileChooser.accept([imagePath]);
    return waitForAttachmentReady(page);
  } catch {
    return false;
  }
}

async function attachSingleImage(
  page: Page,
  imagePath: string,
  workerLabel: string,
): Promise<void> {
  const uploaded =
    (await uploadImageViaHiddenInput(page, imagePath)) ||
    (await uploadImageViaFileChooser(page, imagePath));

  if (uploaded) {
    console.log(`${workerLabel} Uploaded attachment: ${path.basename(imagePath)}`);
    return;
  }

  await focusPromptInput(page);

  const pasted = await pasteImageIntoPrompt(page, imagePath);
  if (pasted) {
    console.log(`${workerLabel} Pasted attachment: ${path.basename(imagePath)}`);
    return;
  }

  throw new Error(`Failed to attach image: ${path.basename(imagePath)}`);
}

export async function attachReferenceImages(
  page: Page,
  imagePaths: string[],
  workerLabel: string,
): Promise<void> {
  for (const imagePath of imagePaths) {
    await attachSingleImage(page, imagePath, workerLabel);
  }
}
