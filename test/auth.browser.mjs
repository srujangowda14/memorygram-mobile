import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
  const groupMessages = [];
  const gid = 'e4353518-bc4e-4652-ba85-330e63452df1';
  const memberId = '14353518-bc4e-4652-ba85-330e63452df1';
  let live;
  // Simulate the Realtime join and database change frames. Keep the database
  // fixture separate so a missed WebSocket event can only arrive via catch-up.
  await page.routeWebSocket('**/realtime/v1/websocket**', socket => {
    socket.onMessage(raw => {
      const [join, ref, topic, event, payload] = JSON.parse(raw);
      let response = {};
      if (event === 'phx_join') {
        const [filter] = payload.config.postgres_changes;
        assert.deepEqual(filter, { event: 'INSERT', schema: 'public', table: 'space_messages', filter: 'group_id=eq.' + gid });
        response = { postgres_changes: [{ ...filter, id: 1 }] };
        live = { socket, notify: row => socket.send(JSON.stringify([join, null, topic, 'postgres_changes', {
          ids: [1], data: { type: 'INSERT', schema: 'public', table: 'space_messages', columns: [], record: row },
        }])) };
      }
      socket.send(JSON.stringify([join, ref, topic, 'phx_reply', { status: 'ok', response }]));
    });
  });
  let nearbyDraft;
  const spot = {id:'117',name:'Alamo Square',address:'1081 Fulton St',lat:37.776,lon:-122.435,type:'Park'};
  const offer = {id:mid,title:'Our paper postcard',prompt:'Find a detail for a postcard and write a caption.',
    nearby:{meeting:spot.name,meetingAddress:spot.address,radius:5,venue:'Duboce Park',listing:'Duboce Park',address:'50 Scott St',
      distance:0.47,source:'https://data.sf.gov/',startsAt:null,origin:'OpenAI'}};
  const dining = {id:gid,title:'Try a nearby restaurant',prompt:'Save a tasting note.',
    nearby:{origin:'Google Maps',placeId:'fixture-restaurant',meeting:spot.name,meetingAddress:spot.address,radius:5,budget:1},
    restaurant:{name:'Test Tea House',tier:1,rating:4.8,reviews:72,distance:0.51,attributions:[]}};
  const room = { id: gid, name: 'Weekend sketchbook', memory_mode: 'group', created_at: '2026-11-05T12:00:00Z',
    group_members: [{ user_id: memberId, profiles: { display_name: 'Jamie' } }, { user_id: mid, profiles: { display_name: 'Alex' } }] };
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
    if (url.origin === 'https://api.memorygram.test') {
      assert.match(route.request().headers().authorization,/^Bearer /);
      if (url.pathname === '/v1/nearby/spots') return route.fulfill({json:{spots:[spot]}});
      assert.equal(url.pathname,'/v1/nearby/suggestions');
      const input = route.request().postDataJSON();
      nearbyDraft = input.draftId;
      assert.deepEqual(input,{mode:'solo',draftId:nearbyDraft,spotId:'117',radius:5,restaurantBudget:1});
      return route.fulfill({json:{offers:[offer,dining],calendarAvailable:true,restaurantStatus:'found'}});
    }
    if (url.origin !== project) return route.abort();
    if (url.pathname === '/rest/v1/rpc/start_nearby_memory_space') {
      assert.deepEqual(route.request().postDataJSON(),{gid:nearbyDraft,mode:'solo',space_name:'My Pocket Chapter',companions:[],offer_id:dining.id});
      return route.fulfill({json:nearbyDraft});
    }
    if (nearbyDraft && url.pathname === '/rest/v1/groups' && url.searchParams.get('id') === 'eq.'+nearbyDraft)
      return route.fulfill({json:{...room,id:nearbyDraft,memory_mode:'solo',name:'My Pocket Chapter'}});
    if (nearbyDraft && url.pathname === '/rest/v1/quests' && url.searchParams.get('group_id') === 'eq.'+nearbyDraft)
      return route.fulfill({json:[{id:gid,title:dining.title,prompt:dining.prompt,nearby:dining.nearby,minutes:10,setting:'anywhere',memories:[]}]});
    if (url.pathname === '/rest/v1/groups') return route.fulfill({ json: url.searchParams.has('id') ? room : [room] });
    if (url.pathname === '/rest/v1/quests') {
      assert.equal(url.searchParams.get('group_id'), 'eq.' + gid);
      return route.fulfill({ json: [{ id: mid, title: 'An afternoon sketch', prompt: 'Draw a detail nearby.', minutes: 5, setting: 'anywhere', memories: [] }] });
    }
    if (url.pathname === '/rest/v1/space_messages') {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        assert.equal(body.group_id,gid);
        groupMessages.unshift({ ...body, author_id: memberId, profiles: { display_name: 'Jamie' }, created_at: new Date().toISOString() });
        return route.fulfill({ status: 201 });
      }
      assert.equal(url.searchParams.get('group_id'), 'eq.' + gid);
      const cursor = url.searchParams.get('or')?.match(/id\.lt\.([\w-]+)/)?.[1];
      const start = cursor ? groupMessages.findIndex(row => row.id === cursor) + 1 : 0;
      return route.fulfill({ json: groupMessages.slice(start, start + 24) });
    }
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
  await checkMemorySpaces(page);
  await checkMeetingSpot(page);
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
  await page.getByRole('button', { name: 'Quests', exact: true }).click();
  await page.getByRole('button', { name: 'Open Weekend sketchbook' }).click();
  await page.getByText('An afternoon sketch', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Group chat', exact: true }).click();
  await page.getByLabel('Group message').fill('I found the perfect detail.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByText('I found the perfect detail.', { exact: true }).waitFor();
  groupMessages.unshift({ id: gid, author_id: mid, profiles: { display_name: 'Alex' },
    body: 'Show me your sketch!', created_at: new Date().toISOString() });
  live.notify(groupMessages[0]);
  live.notify(groupMessages[0]);
  await page.getByText('Show me your sketch!', { exact: true }).waitFor({timeout:3000});
  assert.equal(await page.getByText('Show me your sketch!', { exact: true }).count(), 1);
  live.socket.close({code: 1012, reason: 'Test reconnect'});
  for (let i = 1; i <= 30; i++) groupMessages.unshift({
    ...groupMessages[0], id: randomUUID(), body: 'While disconnected ' + i, created_at: new Date(Date.now() + i).toISOString(),
  });
  await page.getByText('While disconnected 30', {exact:true}).waitFor();
  assert.equal(await page.getByText(/^While disconnected /).count(), 30);
  assert.equal(await page.getByText('I found the perfect detail.', {exact:true}).count(), 1);
  const button = name => page.getByRole('button',{name,exact:true});
  await button('Start a memory').click(); await button('Pocket Chapter').click();
  await button('Choose a meeting spot').click(); await button('Meet at Alamo Square').click();
  await page.getByRole('radio',{name:'$',exact:true}).click();
  await button('Find suggestions').click(); await page.getByText('OpenAI suggestion',{exact:false}).waitFor();
  await page.getByText('Test Tea House',{exact:true}).waitFor();
  await page.getByText('4.8 ★ (72 reviews)',{exact:false}).waitFor();
  await button('Choose this task').last().click(); await button('Start Pocket Chapter').click();
  await page.getByText('Try a nearby restaurant',{exact:true}).waitFor();
  await page.getByRole('link',{name:'View restaurant on Google Maps',exact:false}).waitFor();
  assert.equal(await page.getByText('Free activity',{exact:false}).count(),0);
  await page.getByText('Meet at Alamo Square',{exact:true}).waitFor();
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByText('friend@example.test', { exact: true }).waitFor();
  await page.getByText('Sign out', { exact: true }).click();
  await page.getByText('Peek at the demo first').waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Continue with Google' }).waitFor();
  assert.deepEqual(providers, ['apple', 'google', 'google']);
  assert.equal(exchanges, 1);
});

// Follow the same meeting and selection steps as a new user. Changing the
// radius invalidates the old choice before the group can be created.
async function checkMeetingSpot(page) {
  const button = name => page.getByRole('button',{name,exact:true});
  await button('Start a memory').click();
  await button('With others').click();
  await page.getByRole('checkbox',{name:/Sam Rivera/}).click();
  await page.getByLabel('Space name').fill('Friday park walk');
  await button('Choose a meeting spot').click();
  await page.getByLabel('Search meeting spots').fill('Alamo');
  await button('Meet at Alamo Square').click();
  await button('Find suggestions').click();
  await button('Choose this task').first().click();
  assert.equal(await button('Create group').isEnabled(),true);
  await page.getByRole('radio',{name:'1 mi',exact:true}).click();
  assert.equal(await button('Create group').isEnabled(),false);
  await button('Find suggestions').click();
  await button('Choose this task').first().click();
  await button('Create group').click();
  await page.getByText('Friday park walk',{exact:true}).waitFor();
  await page.getByText('Meet at Alamo Square',{exact:true}).waitFor();
  assert.equal(await button('Add a memory').count(),3);
  await page.getByText('1 mi radius',{exact:false}).waitFor();
  await button('← Your spaces').click();
  await button('Open Friday park walk').click();
  await page.getByText('Meet at Alamo Square',{exact:true}).waitFor();
  await button('The hangout').click();
}

// Exercise both entry modes, denied and granted location, group chat and a
// private task photo through the same controls used in the native app.
async function checkMemorySpaces(page) {
  const button = name => page.getByRole('button', { name, exact: true });
  const geo = await page.context().newCDPSession(page);
  const origin = 'https://memorygram.test';
  await geo.send('Browser.setPermission', { permission: { name: 'geolocation' }, setting: 'denied', origin,
    browserContextId: (await geo.send('Target.getTargetInfo')).targetInfo.browserContextId });
  await button('Start a memory').click();
  await button('Pocket Chapter').click();
  await page.getByLabel('Space name').fill('Quiet Saturday');
  await button('Use my location').click();
  await page.getByText('Location is unavailable.', { exact: false }).waitFor();
  await button('Start Pocket Chapter').click();
  await page.getByText('Quiet Saturday', { exact: true }).waitFor();
  assert.equal(await button('Add a memory').count(),3);
  assert.equal(await button('Group chat').count(),0);
  await button('← Your spaces').click();
  await button('Open Quiet Saturday').waitFor();

  await page.context().grantPermissions(['geolocation'], { origin });
  await page.context().setGeolocation({ latitude: 48.86, longitude: 2.33, accuracy: 100 });
  await button('Start a memory').click();
  await button('With others').click();
  assert.equal(await button('Create group').isDisabled(), true);
  await page.getByRole('checkbox', { name: /Sam Rivera/ }).click();
  await button('Calculate').click();
  await page.getByLabel('Group ages').fill('23, 71');
  await page.getByText('Quest selection · All ages').waitFor();
  await page.getByLabel('Group ages').fill('68, 71');
  await page.getByText('Quest selection · 65+').waitFor();
  await page.getByLabel('Space name').fill('Sunday breakfast');
  await button('Use my location').click();
  await page.getByText(/Your group’s task can mention Paris/).waitFor();
  await button('Use anywhere tasks').click();
  await page.context().setGeolocation({ latitude: 12.97436, longitude: 77.59388, accuracy: 100 });
  await button('Use my location').click();
  await page.getByText(/Your group’s task can mention Cubbon Park/).waitFor();
  await button('Create group').click();
  await page.getByText('Sunday breakfast', { exact: true }).waitFor();
  await page.getByText('Cubbon Park in miniature', { exact: true }).waitFor();
  await button('Group chat').click();
  await page.getByLabel('Group message').fill('Which leaf did you pick?');
  await button('Send message').click();
  await page.getByText('Which leaf did you pick?', { exact: true }).waitFor();
  await button('Assigned tasks').click();
  await button('Add a memory').first().click();
  await page.getByLabel('Memory caption').fill('The crooked paper trophy');
  const file = page.waitForEvent('filechooser');
  await button('Add photo proof').click();
  await (await file).setFiles({ name: 'trophy.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1kAAAAASUVORK5CYII=', 'base64') });
  await button('Change photo').waitFor();
  await button('Save memory').click();
  await page.getByText('1 of 3 memories saved').waitFor();
  await button('View memory').click();
  await page.getByText('The crooked paper trophy', { exact: true }).waitFor();
  await button('Back to space').click();
  await button('← Your spaces').click();
  await button('Open Sunday breakfast').click();
  await button('Browse quests · 65+').click();
  await page.getByRole('button',{name:/^Assign /}).first().click();
  await page.getByText('1 of 4 memories saved').waitFor();
  await button('Browse quests · 65+').click();
  await button('Change group age range').click();
  await button('Under 30').click();
  await button('Assign Group chat patch notes').waitFor();
  await button('Group chat').click();
  await page.getByText('Which leaf did you pick?', { exact: true }).waitFor();
  await button('The hangout').click();
  await page.getByText('The coin picked the bakery.', { exact: true }).waitFor();
  assert.equal(await page.getByText('The crooked paper trophy', { exact: true }).count(),0);
  await geo.detach();
}

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
  await button('Post an existing photo').click();
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
