import { expect, type Page } from '@playwright/test';

export const PASSWORD = process.env.DEMO_USER_PASSWORD ?? '';
export const GATEWAY = 'http://localhost:8080';

/** Signs in through the real Keycloak login page (Authorization Code + PKCE). */
export async function login(page: Page, username: string, path = '/'): Promise<void> {
  await page.goto(path);
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('#kc-login').click();
  // Present at every viewport width once the signed-in shell has rendered.
  await expect(page.getByTestId('tenant-name')).toBeVisible();
}

/** Collects every API call the page makes, to prove the screens are fed by the real gateway. */
export function recordApiCalls(page: Page): Array<{ url: string; status: number; method: string }> {
  const calls: Array<{ url: string; status: number; method: string }> = [];
  page.on('response', (response) => {
    const url = response.url();
    if (url.startsWith(`${GATEWAY}/api/`) && !url.includes('/api/stream/')) calls.push({ url, status: response.status(), method: response.request().method() });
  });
  return calls;
}

export function navLinks(page: Page) {
  return page.getByRole('navigation', { name: 'Main' }).first().getByRole('link');
}

export const unique = (prefix: string) => `${prefix} ${Date.now().toString(36).toUpperCase()}`;
