import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// CI/developers may keep Playwright outside the application dependencies.
const specified = process.env.PLAYWRIGHT_MODULE;
const moduleUrl = specified
  ? (specified.startsWith('file:') ? specified : pathToFileURL(resolve(specified)).href)
  : 'playwright';
let runtime;
try {
  runtime = await import(moduleUrl);
} catch (cause) {
  throw new Error('Install Playwright for browser tests or set PLAYWRIGHT_MODULE to its index.mjs file. See docs/browser-serial.md.', { cause });
}
export const chromium = runtime.chromium;
