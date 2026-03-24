const base = process.env.CHANNELS_BASE_URL || 'http://localhost:3005/channels';

function ensure(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  return { ok: response.ok, status: response.status, payload };
}

async function run() {
  const suffix = Date.now();
  const owner = 'smoke-owner';
  const member = 'smoke-member';

  const health = await request('/health', { method: 'GET', headers: {} });
  ensure(health.ok, `health failed: ${health.status}`);

  const ws = await request('/workspaces', {
    method: 'POST',
    body: JSON.stringify({
      slug: `smoke-${suffix}`,
      name: `Smoke ${suffix}`,
      createdBy: owner,
    }),
  });
  ensure(ws.ok, `create workspace failed: ${ws.status}`);

  const workspaceId = ws.payload?._id;
  ensure(workspaceId, 'workspace id missing');

  const channel = await request('', {
    method: 'POST',
    body: JSON.stringify({
      workspaceId,
      name: `general-${suffix}`,
      visibility: 'public',
      actorUserId: owner,
    }),
  });
  ensure(channel.ok, `create channel failed: ${channel.status}`);

  const channelId = channel.payload?._id;
  ensure(channelId, 'channel id missing');

  const join = await request(`/${channelId}/members/join`, {
    method: 'POST',
    body: JSON.stringify({
      userId: member,
      actorUserId: owner,
      roleName: 'member',
    }),
  });
  ensure(join.ok, `join failed: ${join.status}`);
  ensure(join.payload?.historyVisible === true, 'join should expose history');

  const send = await request(`/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ senderId: owner, plaintext: 'hello from smoke' }),
  });
  ensure(send.ok, `send message failed: ${send.status}`);

  const beforeKick = await request(`/${channelId}/messages?userId=${member}&limit=20`, {
    method: 'GET',
    headers: {},
  });
  ensure(beforeKick.ok, `list before kick failed: ${beforeKick.status}`);
  ensure(Array.isArray(beforeKick.payload), 'before kick payload should be array');
  ensure(beforeKick.payload.length >= 1, 'member should see at least one message before kick');

  const kick = await request(`/${channelId}/members/kick`, {
    method: 'POST',
    body: JSON.stringify({ targetUserId: member, actorUserId: owner }),
  });
  ensure(kick.ok, `kick failed: ${kick.status}`);

  const denied = await request(`/${channelId}/messages?userId=${member}&limit=20`, {
    method: 'GET',
    headers: {},
  });
  ensure(denied.status === 403, `expected 403 after kick, got ${denied.status}`);

  const rejoin = await request(`/${channelId}/members/join`, {
    method: 'POST',
    body: JSON.stringify({ userId: member, actorUserId: owner, roleName: 'member' }),
  });
  ensure(rejoin.ok, `rejoin failed: ${rejoin.status}`);

  const afterRejoin = await request(`/${channelId}/messages?userId=${member}&limit=20`, {
    method: 'GET',
    headers: {},
  });
  ensure(afterRejoin.ok, `list after rejoin failed: ${afterRejoin.status}`);
  ensure(Array.isArray(afterRejoin.payload), 'after rejoin payload should be array');
  ensure(afterRejoin.payload.length >= 1, 'history should remain visible after rejoin');

  console.log(
    JSON.stringify(
      {
        status: 'ok',
        workspaceId,
        channelId,
        beforeKickCount: beforeKick.payload.length,
        afterRejoinCount: afterRejoin.payload.length,
      },
      null,
      2
    )
  );
}

run().catch((err) => {
  console.error(`[smoke-test] ${err.message}`);
  process.exit(1);
});
