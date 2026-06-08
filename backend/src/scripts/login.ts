import readline from "readline";
import {
  getChromeUserDataDirForSession,
  launchBrowser,
  preparePage,
} from "../browser/session";

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const sessionId = Number(process.argv[2] ?? 1);
  const sessionDir = getChromeUserDataDirForSession(sessionId);

  console.log(`Opening Chrome ${sessionId} for Gemini login...`);
  console.log(`Session profile: ${sessionDir}`);
  console.log("");
  console.log("1. Log in to Gemini in the browser window");
  console.log("2. Come back here and press Enter to save the session");
  console.log("");
  console.log("Tip: Stop the backend (npm run dev) before running login.");
  console.log("");

  const browser = await launchBrowser(false, sessionId);
  const page = await browser.newPage();

  await preparePage(page, { fixedViewport: false });
  await page.goto("https://gemini.google.com/app", {
    waitUntil: "networkidle2",
    timeout: 60000,
  });

  await waitForEnter("Press Enter after you have logged in... ");

  const cookies = await page.cookies();
  await browser.close();

  console.log("");
  console.log(
    `Chrome ${sessionId} session saved successfully (${cookies.length} cookies in profile).`,
  );
  console.log(`Profile folder: ${sessionDir}`);
}

main().catch((error) => {
  console.error("Login session setup failed:", error);
  process.exit(1);
});
