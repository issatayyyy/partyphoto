import { defineConfig } from "@playwright/test";

const baseURL = process.env.AUTH_TEST_URL ?? process.env.APP_URL ?? "http://localhost:3000";
const url = new URL(baseURL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.protocol !== "http:") {
  throw new Error("Browser auth tests require a local HTTP dev server");
}

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.browser.spec.ts",
  workers: 1,
  retries: 0,
  reporter: "list",
  use: { baseURL, channel: "chrome", headless: true, trace: "off" },
});
