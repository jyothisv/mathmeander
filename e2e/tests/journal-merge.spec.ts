// Slice 2c autosave — the CONCURRENCY guarantees, end-to-end. Two pages in one context share the
// session (localStorage) and IndexedDB — that's "two tabs = one user." The headline: disjoint edits
// from two tabs MERGE (both survive); a same-paragraph clash surfaces a CONFLICT and never clobbers.
// Plus the 422 latch, offline→online flush, restore-conflict draft retention, and logout draft-clear.
// Fresh unique email per test → fresh space (the dev DB is never truncated).
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const API = 'http://localhost:8787';

function todayLocalISO(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('email').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Desk' })).toBeVisible();
}

async function openToday(page: Page): Promise<string> {
  const today = todayLocalISO();
  await page.getByRole('link', { name: 'Journal' }).click();
  await page.getByRole('button', { name: 'Today' }).click();
  await expect(page.getByRole('heading', { name: today })).toBeVisible();
  await expect(page.locator('.ProseMirror')).toBeVisible();
  return today;
}

const put200 = (r: { url(): string; request(): { method(): string }; status(): number }) =>
  r.url().includes('/content') && r.request().method() === 'PUT' && r.status() === 200;

const CONFLICT = 'Changed elsewhere — your edits are kept';

/** The day's prose texts as the SERVER sees them (immune to either tab's shared-key local draft). */
async function serverTexts(page: Page, date: string): Promise<(string | undefined)[]> {
  const token = await page.evaluate(() => localStorage.getItem('mathmeander.session.token'));
  const res = await page.request.get(`${API}/api/journal/days/${date}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return (await res.json()).graph.content.flatMap(
    (c: { units: { content: { text?: string } }[] }) => c.units.map((u) => u.content.text),
  );
}

test('two-tab disjoint edits → additive merge keeps BOTH', async ({ context, page }) => {
  await login(page, `merge-additive-${Date.now()}@mathmeander.local`);
  const today = await openToday(page);

  // A second tab opens the SAME (still empty) day → both baselines are revision 1.
  const tabB = await context.newPage();
  await tabB.goto(`/journal/${today}`);
  await expect(tabB.locator('.ProseMirror')).toBeVisible();

  // Tab A authors a paragraph and syncs (server → rev 2).
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('Alpha from A');
  await page.waitForResponse(put200, { timeout: 15000 });

  // Tab B (baseline still rev 1) authors a DIFFERENT paragraph → flush 409 → additive merge → 200.
  await tabB.locator('.ProseMirror').click();
  await tabB.keyboard.type('Beta from B');
  await tabB.waitForResponse(put200, { timeout: 20000 });

  // Both survive on the server.
  await tabB.reload();
  await expect(tabB.locator('.ProseMirror')).toContainText('Alpha from A');
  await expect(tabB.locator('.ProseMirror')).toContainText('Beta from B');
});

test('two-tab same-paragraph edits → conflict, no clobber, work preserved', async ({
  context,
  page,
}) => {
  await login(page, `merge-conflict-${Date.now()}@mathmeander.local`);
  const today = await openToday(page);

  // Tab A authors a shared paragraph and syncs.
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('Shared');
  await page.waitForResponse(put200, { timeout: 15000 });

  // Tab B loads it (baseline includes the shared paragraph).
  const tabB = await context.newPage();
  await tabB.goto(`/journal/${today}`);
  await expect(tabB.locator('.ProseMirror')).toContainText('Shared');

  // Tab A edits the shared paragraph and syncs.
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' [A]');
  await page.waitForResponse(put200, { timeout: 15000 });

  // Tab B edits the SAME paragraph → flush 409 → merge sees a same-unit clash → conflict.
  await tabB.locator('.ProseMirror').click();
  await tabB.keyboard.press('End');
  await tabB.keyboard.type(' [B]');
  await expect(tabB.locator('.save-status')).toHaveText(CONFLICT, { timeout: 20000 });

  // Tab B's work stays on screen…
  await expect(tabB.locator('.ProseMirror')).toContainText('[B]');
  // …and the SERVER still has A's version — no silent overwrite. (Assert the server directly: a tab
  // reload would read the OTHER tab's shared-key draft, which is the separately-tracked two-tab
  // coordination follow-up, not a server-integrity question.)
  expect(await serverTexts(page, today)).toContain('Shared [A]');
  expect(await serverTexts(page, today)).not.toContain('Shared [B]');
});

/** Drive two tabs into a same-paragraph conflict where tab A ALSO added a separate paragraph. Returns
 *  the tabs + date with tab B sitting in the conflict state ("Shared [B]" unsynced). */
async function intoConflict(context: import('@playwright/test').BrowserContext, page: Page) {
  await login(page, `merge-resolve-${Date.now()}@mathmeander.local`);
  const today = await openToday(page);
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('Shared');
  await page.waitForResponse(put200, { timeout: 15000 });

  const tabB = await context.newPage();
  await tabB.goto(`/journal/${today}`);
  await expect(tabB.locator('.ProseMirror')).toContainText('Shared');

  // Tab A edits the shared paragraph AND adds a separate one, then syncs. In the paragraph model a single
  // Enter is a soft line (stays in the unit); a blank line (Enter twice) starts the SEPARATE new unit.
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' [A]');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Extra from A');
  await page.waitForResponse(put200, { timeout: 15000 });

  // Tab B edits the SAME paragraph → conflict.
  await tabB.locator('.ProseMirror').click();
  await tabB.keyboard.press('End');
  await tabB.keyboard.type(' [B]');
  await expect(tabB.locator('.save-status')).toHaveText(CONFLICT, { timeout: 20000 });
  return { tabB, today };
}

test('conflict → "Keep mine" wins on the clash but preserves the other side’s addition', async ({
  context,
  page,
}) => {
  const { tabB, today } = await intoConflict(context, page);

  await tabB.getByRole('button', { name: 'Keep mine' }).click();
  await tabB.waitForResponse(put200, { timeout: 20000 });
  await expect(tabB.locator('.save-status')).toHaveText('Saved', { timeout: 15000 });

  const texts = await serverTexts(page, today);
  expect(texts).toContain('Shared [B]'); // my version won the clash
  expect(texts).toContain('Extra from A'); // the other side's separate addition survived
  expect(texts).not.toContain('Shared [A]'); // their clashing edit was overwritten (my choice)
});

test('conflict → "Load the latest" discards my unsaved changes and clears the conflict', async ({
  context,
  page,
}) => {
  const { tabB, today } = await intoConflict(context, page);

  await tabB.getByRole('button', { name: 'Load the latest' }).click();
  await expect(tabB.locator('.save-status')).toHaveText('Saved', { timeout: 15000 });

  // Tab B now shows the server version; its unsaved "[B]" is gone, and the conflict is resolved.
  await expect(tabB.locator('.ProseMirror')).toContainText('Shared [A]');
  await expect(tabB.locator('.ProseMirror')).toContainText('Extra from A');
  await expect(tabB.locator('.ProseMirror')).not.toContainText('[B]');
  // The server is untouched by the discard.
  expect(await serverTexts(page, today)).toContain('Shared [A]');
});

test('a deterministic 422 is latched — surfaced once, not re-sent every keystroke', async ({
  page,
}) => {
  await login(page, `merge-422-${Date.now()}@mathmeander.local`);
  await openToday(page);
  await page.route('**/api/objects/**/content', (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({
          status: 422,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'content_save_invalid', message: 'nope' } }),
        })
      : route.continue(),
  );
  let puts = 0;
  page.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().includes('/content')) puts++;
  });

  await page.locator('.ProseMirror').click();
  await page.keyboard.type('rejected text');
  await expect(page.locator('.save-status')).toHaveText('Couldn’t save — review', {
    timeout: 15000,
  });
  const afterFirst = puts;
  expect(afterFirst).toBeGreaterThanOrEqual(1);

  // Blur (a flush trigger) with UNCHANGED content → latched → no new PUT.
  await page.getByRole('heading', { name: todayLocalISO() }).click();
  await page.waitForTimeout(1500);
  expect(puts).toBe(afterFirst);

  // Changing the content lifts the latch → a new attempt is made (still 422).
  await page.locator('.ProseMirror').click();
  await page.keyboard.type(' more');
  await expect.poll(() => puts, { timeout: 15000 }).toBeGreaterThan(afterFirst);
});

test('edits made offline flush automatically on reconnect', async ({ context, page }) => {
  await login(page, `merge-offline-${Date.now()}@mathmeander.local`);
  await openToday(page);

  await context.setOffline(true);
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('written offline');
  await expect(page.locator('.save-status')).toHaveText('Offline — saved locally', {
    timeout: 15000,
  });

  await context.setOffline(false);
  await page.waitForResponse(put200, { timeout: 20000 });
  await expect(page.locator('.save-status')).toHaveText('Saved', { timeout: 15000 });
  await page.reload();
  await expect(page.locator('.ProseMirror')).toContainText('written offline');
});

test('reopening with an unsynced draft after the server advanced → conflict, draft kept', async ({
  page,
}) => {
  await login(page, `merge-restore-${Date.now()}@mathmeander.local`);
  const today = await openToday(page);
  const token = await page.evaluate(() => localStorage.getItem('mathmeander.session.token'));

  // Block THIS tab's saves so the typed text stays an unsynced draft at baseRevision 1.
  await page.route('**/api/objects/**/content', (route) =>
    route.request().method() === 'PUT' ? route.abort() : route.continue(),
  );
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('my unsynced draft');
  await page.waitForTimeout(500); // let the ~200ms IndexedDB draft write land

  // Advance the SERVER independently via the API (no second editor → no shared-draft interference).
  const dayRes = await page.request.get(`${API}/api/journal/days/${today}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const objectId = (await dayRes.json()).object.id as string;
  const put = await page.request.put(`${API}/api/objects/${objectId}/content`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    data: {
      expected_revision: 1,
      upserts: [
        {
          id: randomUUID(),
          object_id: objectId,
          position: 0,
          status: 'rough',
          declared_by: 'user',
          content: { kind: 'prose', text: 'from another device', inline: [] },
          provenance_id: randomUUID(),
        },
      ],
      deletes: [],
    },
  });
  expect(put.ok()).toBeTruthy();

  // Reopen: draft differs AND server advanced → conflict; the draft is shown and NOT deleted.
  await page.unroute('**/api/objects/**/content');
  await page.reload();
  await expect(page.locator('.save-status')).toHaveText(CONFLICT, { timeout: 15000 });
  await expect(page.locator('.ProseMirror')).toContainText('my unsynced draft');
});

test('signing out clears local drafts (shared-browser privacy)', async ({ page }) => {
  const email = `merge-logout-${Date.now()}@mathmeander.local`;
  await login(page, email);
  const today = await openToday(page);

  // Keep the content ONLY as a local draft: block every save (incl. the logout exit-beacon) so the
  // text never reaches the server. Thus the ONLY way it could reappear on reopen is a surviving draft.
  await page.route('**/api/objects/**/content', (route) =>
    route.request().method() === 'PUT' ? route.abort() : route.continue(),
  );
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('secret draft');
  await page.waitForTimeout(500);

  // Sign out (→ clearAllDrafts), then back in as the same user, and reopen the same day. (The PUT route
  // stays blocked across the navigation, so the exit beacon can't sync the text to the server.)
  await page.getByRole('link', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('email').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Desk' })).toBeVisible();
  await page.goto(`/journal/${today}`);
  await expect(page.getByRole('heading', { name: today })).toBeVisible();
  await expect(page.locator('.ProseMirror')).toBeVisible();

  // The draft was cleared on logout → nothing carried over (not in a draft, not on the server).
  await expect(page.locator('.ProseMirror')).not.toContainText('secret draft');
});
