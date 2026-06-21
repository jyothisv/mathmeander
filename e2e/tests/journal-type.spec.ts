// Slice 2c-2: type cues. Typing a leading cue (`Thm. `) at a block start makes that unit a theorem —
// the cue text is stripped, the block shows its type, and the type is persisted via the canonical
// set_unit_type op (NOT the prose delta). End-to-end: ProseMirror inputRule → PUT /content (type=null)
// → POST /ops/set-unit-type → core → Postgres; and Backspace-at-start clears it back to plain.
import { expect, test } from '@playwright/test';

function todayLocalISO(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

async function openToday(page: import('@playwright/test').Page, email: string): Promise<string> {
  const today = todayLocalISO();
  await page.goto('/login');
  await page.getByLabel('email').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Desk' })).toBeVisible();
  await page.getByRole('link', { name: 'Journal' }).click();
  await page.getByRole('button', { name: 'Today' }).click();
  await expect(page.getByRole('heading', { name: today })).toBeVisible();
  return today;
}

test('type cue: `Thm.` makes a theorem (cue stripped, type persisted via set_unit_type)', async ({
  page,
}) => {
  await openToday(page, `journal-type-${Date.now()}@mathmeander.local`);

  const putContent = page.waitForResponse(
    (r) => r.url().includes('/content') && r.request().method() === 'PUT' && r.status() === 200,
    { timeout: 15000 },
  );
  const postType = page.waitForResponse(
    (r) =>
      r.url().includes('/ops/set-unit-type') &&
      r.request().method() === 'POST' &&
      r.status() === 200,
    { timeout: 15000 },
  );

  const editor = page.locator('.ProseMirror');
  await editor.click();
  // The trailing space after "Thm." triggers the input rule; the rest becomes the unit's prose.
  await page.keyboard.type('Thm. The fundamental theorem.');

  await putContent; // prose created (type=null)
  await postType; // type set to theorem

  // The cue text is gone; the block is marked as a theorem.
  const typed = page.locator('.ProseMirror p[data-unit-type="theorem"]');
  await expect(typed).toBeVisible();
  await expect(typed).toHaveText('The fundamental theorem.');
  await expect(page.locator('.ProseMirror')).not.toContainText('Thm.');

  // Survives reload (the type round-trips from the server projection).
  await page.reload();
  const after = page.locator('.ProseMirror p[data-unit-type="theorem"]');
  await expect(after).toBeVisible();
  await expect(after).toHaveText('The fundamental theorem.');
});

test('Backspace at a typed block start clears the type back to plain', async ({ page }) => {
  await openToday(page, `journal-type-clear-${Date.now()}@mathmeander.local`);

  const editor = page.locator('.ProseMirror');
  await editor.click();
  const setType = page.waitForResponse(
    (r) =>
      r.url().includes('/ops/set-unit-type') &&
      r.request().method() === 'POST' &&
      r.status() === 200,
    { timeout: 15000 },
  );
  await page.keyboard.type('Def. A group is a set with one operation.');
  await setType;
  await expect(page.locator('.ProseMirror p[data-unit-type="definition"]')).toBeVisible();

  // Move to the very start of the block and clear the type (Backspace-at-start gesture).
  const clearType = page.waitForResponse(
    (r) =>
      r.url().includes('/ops/set-unit-type') &&
      r.request().method() === 'POST' &&
      r.status() === 200,
    { timeout: 15000 },
  );
  await page.keyboard.press('Home');
  await page.waitForTimeout(150); // let the caret land at offset 0 before Backspace (race under load)
  await page.keyboard.press('Backspace');
  // The type clears in the doc immediately — assert that first so a caret-positioning race fails fast
  // (a clear assertion) rather than as a 15s response timeout.
  await expect(page.locator('.ProseMirror p[data-unit-type]')).toHaveCount(0);
  await clearType; // …and the background set_unit_type(null) persists it

  // Survives a reload — text intact, type gone.
  await page.reload();
  await expect(page.locator('.ProseMirror p[data-unit-type]')).toHaveCount(0);
  await expect(page.locator('.ProseMirror')).toContainText('A group is a set with one operation.');
});

test('Enter inside a typed block adds a line — ONE multi-line unit, survives reload', async ({
  page,
}) => {
  const today = await openToday(page, `journal-type-multiline-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('Thm. Line one');
  await page.waitForResponse((r) => r.url().includes('/ops/set-unit-type') && r.status() === 200, {
    timeout: 15000,
  });
  await page.keyboard.press('Enter'); // stays in the block (a line break)
  await page.keyboard.type('Line two');
  await page.waitForResponse(
    (r) => r.url().includes('/content') && r.request().method() === 'PUT' && r.status() === 200,
    { timeout: 15000 },
  );
  // ONE theorem block, not two; both lines inside it.
  await expect(page.locator('.ProseMirror p[data-unit-type="theorem"]')).toHaveCount(1);
  await expect(page.locator('.ProseMirror p')).toHaveCount(1);
  await expect(editor).toContainText('Line one');
  await expect(editor).toContainText('Line two');

  await page.reload();
  await expect(page.getByRole('heading', { name: today })).toBeVisible();
  await expect(page.locator('.ProseMirror p[data-unit-type="theorem"]')).toHaveCount(1);
  await expect(page.locator('.ProseMirror p')).toHaveCount(1);
});

test('deleting a typed block clears-then-deletes (no stuck "Couldn’t save")', async ({ page }) => {
  await openToday(page, `journal-type-delete-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('Thm. To be deleted.');
  await page.waitForResponse((r) => r.url().includes('/ops/set-unit-type') && r.status() === 200, {
    timeout: 15000,
  });
  // Select all + delete the typed block.
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  // The delete succeeds (type cleared first, then save_content delete) — a real PUT /content 200.
  await page.waitForResponse(
    (r) => r.url().includes('/content') && r.request().method() === 'PUT' && r.status() === 200,
    { timeout: 15000 },
  );
  await page.waitForTimeout(800);
  await expect(page.locator('.ProseMirror p[data-unit-type]')).toHaveCount(0); // gone
  await expect(page.locator('.save-status')).not.toContainText('Couldn’t save');
});

test('a cued-but-empty block survives a reload (the draft is kept, not discarded)', async ({
  page,
}) => {
  const today = await openToday(page, `journal-type-empty-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('Thm. '); // cue only — an empty typed block (un-persistable)
  await expect(page.locator('.ProseMirror p[data-unit-type="theorem"]')).toHaveCount(1);
  await page.waitForTimeout(1000); // let the local draft settle

  await page.reload();
  await expect(page.getByRole('heading', { name: today })).toBeVisible();
  // The cue is NOT lost: the draft is restored on reopen.
  await expect(page.locator('.ProseMirror p[data-unit-type="theorem"]')).toHaveCount(1);
});

test('a cue typed BEFORE existing content keeps the first character (prepend)', async ({
  page,
}) => {
  await openToday(page, `journal-type-prepend-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('hello world');
  await page.keyboard.press('Home'); // cursor to the very start of the line
  await page.waitForTimeout(150); // let the caret land at offset 0 before the cue (race under load)
  await page.keyboard.type('Thm. '); // cue prepended before the content
  await page.waitForResponse((r) => r.url().includes('/ops/set-unit-type') && r.status() === 200, {
    timeout: 15000,
  });
  // The first letter is NOT eaten.
  await expect(page.locator('.ProseMirror p[data-unit-type="theorem"]')).toHaveText('hello world');

  // Backspace at the start clears the type and keeps the content as plain prose (no "Thm." restored).
  // (After the cue strips "Thm. ", the caret is already at offset 0.)
  await page.keyboard.press('Backspace');
  await expect(page.locator('.ProseMirror p[data-unit-type]')).toHaveCount(0);
  await page.waitForResponse((r) => r.url().includes('/ops/set-unit-type') && r.status() === 200, {
    timeout: 15000,
  });
  await expect(editor).toHaveText('hello world');
});

const put200 = (r: { url(): string; request(): { method(): string }; status(): number }) =>
  r.url().includes('/content') && r.request().method() === 'PUT' && r.status() === 200;
const setType200 = (r: { url(): string; status(): number }) =>
  r.url().includes('/ops/set-unit-type') && r.status() === 200;

test('plain prose: single Enter stays in the unit; a blank line starts a new one', async ({
  page,
}) => {
  await openToday(page, `journal-para-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('first line');
  await page.keyboard.press('Enter'); // soft line — stays in the unit
  await page.keyboard.type('still the same unit');
  await expect(page.locator('.ProseMirror p')).toHaveCount(1);
  await page.keyboard.press('Enter'); // now on an empty line…
  await page.keyboard.press('Enter'); // …a blank line → a NEW plain unit
  await page.keyboard.type('second unit');
  await expect(page.locator('.ProseMirror p')).toHaveCount(2);

  await page.waitForResponse(put200, { timeout: 15000 });
  await expect(page.locator('.save-status')).not.toContainText('Couldn’t save');
  await page.reload();
  await expect(page.locator('.ProseMirror p')).toHaveCount(2);
});

test('a proof keeps multiple paragraphs in ONE unit (survives reload)', async ({ page }) => {
  const today = await openToday(page, `journal-proof-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('Pf. First, we note X.');
  await page.waitForResponse(setType200, { timeout: 15000 });
  await page.keyboard.press('Enter'); // soft line (stays)
  await page.keyboard.press('Enter'); // blank line → a paragraph break, STILL the proof
  await page.keyboard.type('Then, Y follows.');
  // ONE proof unit, two paragraphs — not split out.
  await expect(page.locator('.ProseMirror p[data-unit-type="proof"]')).toHaveCount(1);
  await expect(page.locator('.ProseMirror p')).toHaveCount(1);

  await page.waitForResponse(put200, { timeout: 15000 });
  await page.reload();
  await expect(page.getByRole('heading', { name: today })).toBeVisible();
  await expect(page.locator('.ProseMirror p[data-unit-type="proof"]')).toHaveCount(1);
  await expect(page.locator('.ProseMirror p')).toHaveCount(1);
  await expect(editor).toContainText('First, we note X.');
  await expect(editor).toContainText('Then, Y follows.');
});

test('⌘/Ctrl+Enter exits a typed unit into a new plain unit', async ({ page }) => {
  await openToday(page, `journal-exit-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('Thm. A statement.');
  await page.waitForResponse(setType200, { timeout: 15000 });
  await page.keyboard.press('ControlOrMeta+Enter'); // finish the theorem → a new plain unit
  await page.keyboard.type('plain follow-up');
  await expect(page.locator('.ProseMirror p[data-unit-type="theorem"]')).toHaveCount(1);
  await expect(page.locator('.ProseMirror p')).toHaveCount(2);
  await expect(page.locator('.ProseMirror p:not([data-unit-type])')).toHaveText('plain follow-up');
});

test('a cue on a new line inside a unit spawns a new typed unit (mid-block)', async ({ page }) => {
  await openToday(page, `journal-spawn-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('Some intro prose.');
  await page.keyboard.press('Enter'); // soft line — still one plain unit
  await page.keyboard.type('Def: A widget is a thing.'); // cue at the soft-line start → spawn a definition
  await page.waitForResponse(setType200, { timeout: 15000 });
  await expect(page.locator('.ProseMirror p[data-unit-type="definition"]')).toHaveCount(1);
  await expect(page.locator('.ProseMirror p')).toHaveCount(2);
  await expect(page.locator('.ProseMirror p[data-unit-type="definition"]')).toHaveText(
    'A widget is a thing.',
  );
  await expect(page.locator('.ProseMirror p:not([data-unit-type])')).toHaveText(
    'Some intro prose.',
  );
});

test('Backspace peels a type without merging into the previous typed unit', async ({ page }) => {
  await openToday(page, `journal-peel-${Date.now()}@mathmeander.local`);
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('Thm. The theorem.');
  await page.waitForResponse(setType200, { timeout: 15000 });
  await page.keyboard.press('ControlOrMeta+Enter'); // → a new plain unit after the theorem
  await page.keyboard.type('Def. The definition.');
  await page.waitForResponse(setType200, { timeout: 15000 });
  await expect(page.locator('.ProseMirror p[data-unit-type]')).toHaveCount(2); // theorem + definition

  // Backspace at the definition's start clears its TYPE (peel) — it must NOT fuse into the theorem.
  await page.keyboard.press('Home');
  await page.waitForTimeout(150); // let the caret settle at offset 0
  await page.keyboard.press('Backspace');
  await expect(page.locator('.ProseMirror p[data-unit-type="definition"]')).toHaveCount(0); // peeled
  await expect(page.locator('.ProseMirror p[data-unit-type="theorem"]')).toHaveCount(1); // intact
  await expect(page.locator('.ProseMirror p')).toHaveCount(2); // still two units — NOT merged
});
