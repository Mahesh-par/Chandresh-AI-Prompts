import express, { Application, Request, Response } from "express";
import cors from "cors";
import { Browser, Page } from "puppeteer";
import { launchBrowser, preparePage } from "./browser/session";
import { env } from "./config/env";
import { connectDatabase } from "./db/connect";
import { sendPromptsToGemini } from "./gemini/automation";
import { ScrapeResponse } from "./models/ScrapeResponse";

const app: Application = express();

app.use(cors());
app.use(express.json());

interface ScrapeRequest {
  url: string;
}

interface PromptBlock {
  id: string;
  content: string;
  ChatTime: string;
}

interface ScrapeResult {
  chatName: string;
  ChatTime: string;
  prompts: PromptBlock[];
}

async function saveScrapeResponse(
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await ScrapeResponse.create(payload);
    console.log("Saved scrape response to MongoDB");
  } catch (dbError) {
    console.error("Failed to save scrape response to MongoDB:", dbError);
  }
}

function formatScrapedAt(date: Date): string {
  const istOptions: Intl.DateTimeFormatOptions = {
    timeZone: env.timezone,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  };

  const parts = new Intl.DateTimeFormat("en-IN", istOptions).formatToParts(date);
  const day = parts.find((p) => p.type === "day")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const hour = parts.find((p) => p.type === "hour")?.value;
  const minute = parts.find((p) => p.type === "minute")?.value;

  return `${day}:${month}-${hour}:${minute}`;
}

app.post("/api/scrape", async (req: Request, res: Response): Promise<void> => {
  const { url } = req.body as ScrapeRequest;

  if (!url) {
    res.status(400).json({ error: "URL is required" });
    return;
  }
  if (!url.startsWith("https://claude.ai/")) {
    res.status(400).json({
      error: "Invalid URL. Only Claude share URLs are allowed.",
    });
    return;
  }

  console.log(`Scrape Request: ${url}`);

  let browser: Browser | null = null;
  try {
    browser = await launchBrowser("new");

    const page: Page = await browser.newPage();
    await preparePage(page);

    console.log(`Navigating to: ${url}`);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

    console.log("Waiting for content to render...");
    await page
      .waitForFunction(
        () => {
          return (
            document.querySelector(
              'pre, code, [class*="code-block"], .font-claude-message, [data-testid*="message"]',
            ) !== null
          );
        },
        { timeout: 30000 },
      )
      .catch(() => console.log("Wait finished or timed out."));

    await new Promise((r) => setTimeout(r, 2000));

    const currentUrl = page.url();
    console.log(`Current URL after navigation: ${currentUrl}`);

    if (currentUrl.includes("login") || currentUrl.includes("claude.ai/chat")) {
      console.log(
        "Redirected to login or main chat - this link might not be public.",
      );
    }

    console.log("Scanning for code content and chat name...");

    const scrapeResult: ScrapeResult = await page.evaluate(
      () => {
        // 1. Scrape the chat name
        const titleSelectors = [
          "div.truncate.text-text-300",
          "h1",
          ".font-claude-chat-title",
          "title",
        ];

        let chatName = "Untitled Claude Chat";
        for (const selector of titleSelectors) {
          const el = document.querySelector(selector);
          if (el && (el as HTMLElement).innerText.trim()) {
            chatName = (el as HTMLElement).innerText.trim();
            if (chatName === "Claude") continue; // Skip if it's just the site name
            break;
          }
        }

        // 2. Scrape the chat time (e.g., "Shared on October 10, 2023")
        let ChatTime = "";

        const timeSelectors = [
          "time",
          "div.flex.items-center.gap-1.text-text-500",
          "div.text-text-500",
          "span.text-text-500",
          ".font-medium.text-text-400",
          "div.text-text-400",
        ];

        for (const selector of timeSelectors) {
          const els = Array.from(document.querySelectorAll(selector));
          for (const el of els) {
            const text = (el as HTMLElement).innerText.trim();
            // Look for "Shared on" or common date patterns (Month Day, Year)
            if (
              text.includes("Shared on") ||
              text.includes("Created on") ||
              text.match(/[A-Z][a-z]+ \d{1,2}, \d{4}/)
            ) {
              ChatTime = text;
              break;
            }
          }
          if (ChatTime) break;
        }

        if (!ChatTime) {
          // Broad search for anything containing "Shared on"
          const allTextNodes = Array.from(
            document.querySelectorAll("div, span, p"),
          );
          const found = allTextNodes.find((el) =>
            (el as HTMLElement).innerText.includes("Shared on"),
          );
          if (found) ChatTime = (found as HTMLElement).innerText.trim();
        }

        // 3. Scrape the prompts/messages
        // Priority 1: Specific code blocks
        let elements: Element[] = Array.from(
          document.querySelectorAll('div[class*="code-block__code"], pre code'),
        );

        // Priority 2: Message bodies (the prose/content of each message)
        if (elements.length === 0) {
          elements = Array.from(
            document.querySelectorAll(
              '.font-claude-message, [data-testid*="message-content"], .prose',
            ),
          );
        }

        // Filter and map elements to clean data
        const seenContent = new Set<string>();
        const prompts = elements
          .map((el: Element) => {
            const htmlEl = el as HTMLElement;
            let text = htmlEl.innerText || el.textContent || "";

            // Clean up: remove "Copy" buttons, "Edit" labels, etc.
            text = text.replace(/Copy\s*$/i, "").trim();
            text = text.replace(/Edit\s*$/i, "").trim();

            return text;
          })
          .filter((text: string) => {
            // 1. Basic empty check
            if (!text || text.length < 2) return false;

            // 2. Exclude hex codes (UI noise)
            if (/^#[0-9A-Fa-f]{3,6}$/.test(text)) return false;

            // 3. Exclude the chat title itself (to avoid duplicates from the header)
            if (text === chatName) return false;

            // 4. De-duplicate consecutive identical blocks
            if (seenContent.has(text)) return false;
            seenContent.add(text);

            return true;
          });

        // Filter by keyword if provided
        const filteredPrompts = prompts;

        const results = filteredPrompts.map((text: string, index: number) => {
          return {
            id: `Block ${index + 1}`,
            content: text,
            ChatTime: ChatTime,
          };
        });

        return { chatName, ChatTime, prompts: results };
      }
    );

    const { chatName, ChatTime, prompts: data } = scrapeResult;
    console.log(`Scraped ${data.length} blocks from ${chatName}`);
    console.log(`Extracted ChatTime: ${ChatTime}`);

    await browser.close();
    browser = null;

    const istFormattedAt = formatScrapedAt(new Date());

    const responseData = {
      success: true,
      count: data.length,
      results: data,
      tableName: chatName,
      ChatTime: ChatTime,
      sourceUrl: url,
      scrapedAt: istFormattedAt,
    };

    if (data.length === 0) {
      console.log("No content found. Sending empty results response.");
      const noContentMessage = "No code blocks or prompts found at this URL.";

      const emptyResponse = {
        success: false,
        message: noContentMessage,
        sourceUrl: url,
        results: [],
        ChatTime: ChatTime,
      };

      await saveScrapeResponse(emptyResponse);
      res.json(emptyResponse);
      return;
    }

    await saveScrapeResponse(responseData);

    // Forwarding data to n8n webhook
    try {
      console.log(`Forwarding data to n8n webhook: ${env.n8nWebhookUrl}`);
      await fetch(env.n8nWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(responseData),
      });
      console.log("Webhook call successful");
    } catch (webhookError) {
      console.error("Webhook call failed:", webhookError);
    }

    res.json(responseData);
  } catch (error) {
    console.error("Scraping error:", error);
    if (browser) await browser.close();

    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    const errorResponse = {
      success: false,
      sourceUrl: url,
      error: "Failed to scrape the URL",
      details: errorMessage,
      results: [],
    };

    await saveScrapeResponse(errorResponse);
    res.status(500).json({
      error: errorResponse.error,
      details: errorResponse.details,
    });
  }
});

app.post(
  "/api/prompts/:id/send",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const prompt = await ScrapeResponse.findById(req.params.id);

      if (!prompt || !prompt.success) {
        res.status(404).json({
          success: false,
          error: "Prompt not found",
        });
        return;
      }

      const blocks = (prompt.results ?? []).map((block) => ({
        id: block.id,
        content: block.content,
        ChatTime: block.ChatTime,
      }));

      if (blocks.length === 0) {
        res.status(400).json({
          success: false,
          error: "This prompt has no blocks to send to Gemini",
        });
        return;
      }

      console.log(
        `Sending ${blocks.length} prompt block(s) to Gemini for: ${prompt.tableName}`,
      );

      const summary = await sendPromptsToGemini(
        blocks,
        prompt.tableName ?? "Untitled Project",
      );

      const skippedNote =
        summary.skipped > 0
          ? `, skipped ${summary.skipped} (no image detected)`
          : "";

      const workersNote = ` using ${summary.workers} Chrome window(s)`;

      res.json({
        success: summary.failed === 0,
        message:
          summary.failed === 0
            ? `Saved ${summary.sent}/${summary.total} image(s) to ${summary.projectFolder}${skippedNote}${workersNote}`
            : `Saved ${summary.sent}/${summary.total} image(s) to ${summary.projectFolder}${skippedNote}${workersNote}, ${summary.failed} failed`,
        ...summary,
      });
    } catch (error) {
      console.error("Failed to send prompt:", error);
      res.status(500).json({
        success: false,
        error: "Failed to send prompt",
      });
    }
  },
);

app.get("/api/prompts", async (_req: Request, res: Response): Promise<void> => {
  try {
    const prompts = await ScrapeResponse.find(
      {
        success: true,
        tableName: { $exists: true, $ne: "" },
      },
      {
        tableName: 1,
        count: 1,
        sourceUrl: 1,
        scrapedAt: 1,
        createdAt: 1,
      },
    ).sort({ createdAt: -1 });

    res.json({
      success: true,
      count: prompts.length,
      prompts: prompts.map((prompt) => ({
        id: prompt._id,
        name: prompt.tableName,
        blockCount: prompt.count ?? 0,
        sourceUrl: prompt.sourceUrl,
        scrapedAt: prompt.scrapedAt,
        createdAt: prompt.createdAt,
      })),
    });
  } catch (error) {
    console.error("Failed to fetch prompts:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch saved prompts",
    });
  }
});

async function startServer(): Promise<void> {
  await connectDatabase();

  app.listen(env.port, () => {
    console.log(`Scraper backend running at http://localhost:${env.port}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
