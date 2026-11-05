import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import test from 'node:test';

// Serve the exported Expo app from a synthetic origin inside the browser.
// Provider exchanges are intercepted too, so the test never uses a real account.
test('preview, provider callbacks, persisted session and sign-out', async t => {
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  const app = 'https://memorygram.test';
  const project = 'https://fixture.supabase.test';
  const mid = '44353518-bc4e-4652-ba85-330e63452df1';
  const storagePath = 'member/photo';
  let liked = false;
  const replies = new Map();
  const activity = () => ({ memory_id: mid, likes: Number(liked), liked, comments: replies.size });
  await page.addInitScript(() => Object.defineProperty(navigator, 'share', {
    value: async payload => { window.testShared = payload; }, configurable: true,
  }));
  let challenge;
  let exchanges = 0;
  const providers = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === app) {
      const asset = url.pathname.startsWith('/_expo/') || url.pathname.startsWith('/assets/');
      const path = asset ? url.pathname : '/index.html';
      const body = await readFile(new URL('../.expo/auth-test' + path, import.meta.url));
      return route.fulfill({ body, contentType: asset && path.endsWith('.js')
        ? 'application/javascript' : asset ? 'application/octet-stream' : 'text/html' });
    }
    if (url.origin !== project) return route.abort();
    if (url.pathname === '/rest/v1/memories') {
      const requested = url.searchParams.get('id');
      if (requested && requested !== 'eq.' + mid) return route.fulfill({ json: [] });
      return route.fulfill({ json: [{ id: mid, caption: 'Their rooftop picnic', image_path: storagePath,
        created_at: '2026-10-31T14:00:00Z', people: [{ person_id: 'alex', profiles: { display_name: 'Alex' } }] }] });
    }
    if (url.pathname === '/storage/v1/object/sign/memory-photos') {
      return route.fulfill({ json: [{ path: storagePath, signedURL: '/object/sign/sample?token=test', error: null }] });
    }
    if (url.pathname === '/rest/v1/rpc/memory_activity') {
      const single = route.request().headers().accept?.includes('vnd.pgrst.object');
      return route.fulfill({ json: single ? activity() : [activity()] });
    }
    if (url.pathname === '/rest/v1/rpc/set_memory_like') {
      const body = route.request().postDataJSON();
      assert.equal(body.mid, mid); liked = body.wanted;
      return route.fulfill({ json: activity() });
    }
    if (url.pathname === '/rest/v1/memory_comments') {
      if (route.request().method() === 'POST') {
        const comment = route.request().postDataJSON();
        assert.equal(comment.memory_id, mid);
        replies.set(comment.id, { ...comment, created_at: '2026-11-05T12:00:00Z', author_id: 'member', profiles: { display_name: 'Friend' } });
        return route.fulfill({ status: 201 });
      }
      return route.fulfill({ json: [...replies.values()] });
    }
    if (url.pathname === '/auth/v1/authorize') {
      providers.push(url.searchParams.get('provider'));
      assert.equal(url.searchParams.get('code_challenge_method'), 's256');
      challenge = url.searchParams.get('code_challenge');
      const callback = new URL(url.searchParams.get('redirect_to'));
      assert.equal(callback.href, app + '/auth/callback');
      if (providers.length === 1) callback.searchParams.set('error', 'access_denied');
      else callback.searchParams.set('code', providers.length === 2 ? 'expired-code' : 'fixture-code');
      return route.fulfill({ status: 302, headers: { location: callback.href } });
    }
    if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204 });
    if (url.pathname !== '/auth/v1/token') return route.abort();
    const payload = route.request().postDataJSON();
    if (payload.auth_code === 'expired-code') {
      return route.fulfill({ status: 400, json: { code: 'invalid_grant', message: 'Code expired' } });
    }
    assert.equal(payload.auth_code, 'fixture-code');
    assert.equal(createHash('sha256').update(payload.code_verifier).digest('base64url'), challenge);
    exchanges++;
    const user = { id: '14353518-bc4e-4652-ba85-330e63452df1', email: 'friend@example.test' };
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = [{ alg: 'HS256', typ: 'JWT' }, { sub: user.id, exp }].map(
      part => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.Zml4dHVyZQ';
    return route.fulfill({ json: { user, access_token: token, token_type: 'bearer',
      refresh_token: 'fixture-refresh', expires_in: 3600, expires_at: exp } });
  });
  await page.goto(app);
  await page.getByText('Peek at the demo first').click();
  await page.getByText('The coin picked the bakery.', { exact: true }).waitFor();
  await checkSharedProfile(page);
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByText('Guest preview', { exact: true }).waitFor();
  await page.getByText('Exit preview', { exact: true }).click();
  await page.getByRole('button', { name: 'Continue with Apple' }).click();
  await page.getByText('Back to Memorygram').click();
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await page.getByText('Back to Memorygram').click();
  await page.goto(app + '/?memory=' + mid);
  await page.getByText('Sign in to view this memory').waitFor();
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await page.getByText('Shared memory', { exact: true }).waitFor();
  await page.getByText('Their rooftop picnic').waitFor();
  await page.getByRole('button', { name: 'Back to feed' }).click();
  await page.getByText('Memory feed', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Like memory', exact: true }).click();
  await page.getByRole('button', { name: 'Unlike memory' }).waitFor();
  await page.getByRole('button', { name: 'Comments (0)', exact: true }).click();
  await page.getByLabel('Your comment').fill('Bring us next time!');
  await page.getByRole('button', { name: 'Post comment' }).click();
  await page.getByText('Bring us next time!', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Comments (1)', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Share memory' }).click();
  assert.deepEqual(await page.evaluate(() => window.testShared), { title: 'Memorygram', url: app + '/?memory=' + mid });
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'share', { value: undefined });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async link => { window.testCopied = link; } } });
  });
  await page.getByRole('button', { name: 'Share memory' }).click();
  await page.getByText('Memory link copied.').waitFor();
  assert.equal(await page.evaluate(() => window.testCopied), app + '/?memory=' + mid);
  await page.goto(app + '/?memory=11111111-1111-4111-8111-111111111111');
  await page.getByText('This memory is unavailable to this account.').waitFor();
  await page.getByRole('button', { name: 'Back to feed' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Unlike memory' }).click();
  await page.getByRole('button', { name: 'Like memory', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByText('friend@example.test', { exact: true }).waitFor();
  await page.getByText('Sign out', { exact: true }).click();
  await page.getByText('Peek at the demo first').waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Continue with Google' }).waitFor();
  assert.deepEqual(providers, ['apple', 'google', 'google']);
  assert.equal(exchanges, 1);
});

// Walk through the actual guest UI with a local sample photo. Verify the
// same caption appears on both participants' profiles after posting once.
async function checkSharedProfile(page) {
  const button = label => page.getByRole('button', { name: label, exact: true });
  await button('Profile').click();
  await button('Requests').click();
  await button('Approve').click();
  await button('3 followers').waitFor();
  await button('Profile settings').click();
  await page.getByLabel('Private profile', { exact: true }).click();
  await page.getByText('Close', { exact: true }).click();
  await page.getByText('Public profile', { exact: false }).first().waitFor();
  await button('Create memory').click();
  await page.getByLabel('Memory caption').fill('Our tiny photo museum');
  const filePicker = page.waitForEvent('filechooser');
  await button('Add photo proof').click();
  await (await filePicker).setFiles({ name: 'museum.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1kAAAAASUVORK5CYII=', 'base64') });
  await button('Change photo').waitFor();
  await button('Choose friends').click();
  await page.getByRole('checkbox', { name: /Alex Chen/ }).click();
  await button('Done choosing').click();
  await page.getByLabel('Group name').fill('Museum crew');
  await button('Post memory').click();
  await page.getByText('Our tiny photo museum', { exact: true }).waitFor();
  await button('Alex Chen').first().click();
  await button('← My profile').waitFor();
  await page.getByText('Our tiny photo museum', { exact: true }).waitFor();
  await button('The hangout').click();
}
