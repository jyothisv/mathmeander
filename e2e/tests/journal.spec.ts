// Journal surface (slice 2b): login → open Today (get-or-create) → the day page renders → the day is
// listed date-ordered → reload persists. Idempotent across e2e runs (the shared DB isn't truncated):
// re-opening today returns the same day, so the assertions hold regardless of prior runs.
import { expect, test } from '@playwright/test';

const EMAIL = 'journal-e2e@mathmeander.local';

/** The user's LOCAL calendar day — mirrors the app's todayLocalISO (NOT toISOString/UTC). */
function todayLocalISO(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

test('journal: open today, see it listed, survive reload', async ({ page }) => {
  const today = todayLocalISO();

  await page.goto('/login');
  await page.getByLabel('email').fill(EMAIL);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Desk' })).toBeVisible();

  // Open the journal and create/open today's day.
  await page.getByRole('link', { name: 'Journal' }).click();
  await expect(page.getByRole('heading', { name: 'Journal' })).toBeVisible();
  await page.getByRole('button', { name: 'Today' }).click();

  // The day page shows the date as its heading.
  await expect(page.getByRole('heading', { name: today })).toBeVisible();

  // Back to the journal: the day is listed.
  await page.getByRole('link', { name: '← Journal' }).click();
  await expect(page.getByRole('link', { name: today })).toBeVisible();

  // Reload: the day persists.
  await page.reload();
  await expect(page.getByRole('link', { name: today })).toBeVisible();
});
