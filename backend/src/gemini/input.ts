import type { ElementHandle, Page } from "puppeteer";
import { env } from "../config/env";

export const PROMPT_INPUT_SELECTORS = [
  "div.text-input-field.simplified-input-area [contenteditable='true']",
  "div.text-input-field.simplified-input-area",
  "rich-textarea .ql-editor",
  "div[contenteditable='true'].ql-editor",
  "[contenteditable='true'][role='textbox']",
  "div[contenteditable='true']",
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function findPromptInput(
  page: Page,
  options: {
    wait?: boolean;
    timeoutMs?: number;
    errorMessage?: string;
  } = {},
): Promise<{ element: ElementHandle<Element>; selector: string }> {
  const timeoutMs = options.timeoutMs ?? env.geminiUiTimeoutMs;
  const deadline = Date.now() + (options.wait ? timeoutMs : 0);

  while (true) {
    for (const selector of PROMPT_INPUT_SELECTORS) {
      const element = await page.$(selector);
      if (element) {
        return { element, selector };
      }
    }

    if (!options.wait || Date.now() >= deadline) {
      break;
    }

    await delay(500);
  }

  throw new Error(
    options.errorMessage ??
      "Gemini prompt input not found for image attachment.",
  );
}

export async function focusPromptInput(page: Page): Promise<void> {
  const { element } = await findPromptInput(page, {
    wait: true,
    timeoutMs: 15000,
  });

  await element.click();
  await delay(300);
}
