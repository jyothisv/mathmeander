// THE walking-skeleton spec: one browser pass through every seam —
// login (dev IdP → session) → create a LaTeX-laced note (client-minted UUIDv7 →
// generated-zod edge → glue → napi core → Postgres) → desk lists it → detail shows
// raw_source VERBATIM → rename under optimistic concurrency → reload persists →
// a second login revokes the first session (single-active-session observed in UI).
import { expect, test } from '@playwright/test';

const EMAIL = 'e2e@mathmeander.local';
const RAW = 'Thm. $\\forall \\epsilon>0\\ \\exists\\delta>0$\nIdea: bisect — ℝ is complete.';

test('the core loop: capture rough math, preserve it, rename it, survive reload', async ({
  page,
}) => {
  const title = `Cauchy sequences ${Date.now()}`;

  // Sign in via the dev issuer.
  await page.goto('/login');
  await page.getByLabel('email').fill(EMAIL);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Desk' })).toBeVisible();

  // Capture a rough note.
  await page.getByRole('link', { name: 'New note' }).click();
  await page.getByLabel('title').fill(title);
  await page.getByLabel('rough text').fill(RAW);
  await page.getByRole('button', { name: 'Save note' }).click();

  // Detail shows the raw source VERBATIM (§2.2).
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByLabel('raw source')).toHaveText(RAW);
  await expect(page.getByText('note · draft · rev 1')).toBeVisible();

  // The desk lists it.
  await page.getByRole('link', { name: 'Desk' }).click();
  await expect(page.getByRole('link', { name: title })).toBeVisible();

  // Rename under optimistic concurrency; revision advances.
  await page.getByRole('link', { name: title }).click();
  await page.getByRole('button', { name: 'Rename' }).click();
  await page.getByLabel('new title').fill(`${title} (renamed)`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: `${title} (renamed)` })).toBeVisible();
  await expect(page.getByText('note · draft · rev 2')).toBeVisible();

  // Reload: everything persisted, raw source still byte-faithful.
  await page.reload();
  await expect(page.getByRole('heading', { name: `${title} (renamed)` })).toBeVisible();
  await expect(page.getByLabel('raw source')).toHaveText(RAW);
});

test('a second login revokes the first session (single-active-session, observed)', async ({
  browser,
}) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    const pageA = await first.newPage();
    await pageA.goto('/login');
    await pageA.getByLabel('email').fill(EMAIL);
    await pageA.getByRole('button', { name: 'Sign in' }).click();
    await expect(pageA.getByRole('heading', { name: 'Desk' })).toBeVisible();

    const pageB = await second.newPage();
    await pageB.goto('/login');
    await pageB.getByLabel('email').fill(EMAIL);
    await pageB.getByRole('button', { name: 'Sign in' }).click();
    await expect(pageB.getByRole('heading', { name: 'Desk' })).toBeVisible();

    // A's next data action hits 401 → the client clears the session → /login.
    await pageA.getByRole('link', { name: 'New note' }).click();
    await pageA.getByLabel('title').fill('should never save');
    await pageA.getByRole('button', { name: 'Save note' }).click();
    await pageA.waitForURL('**/login');
    await expect(pageA.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  } finally {
    await first.close();
    await second.close();
  }
});
