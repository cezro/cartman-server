import { PushSendClient } from './push-send.client';

/**
 * The client half of L3. Its whole job is to turn "did push-send accept this?"
 * into a boolean the drainer can stamp on, so the two things worth testing are
 * where it posts (with what credential) and what it calls a failure.
 */
describe('PushSendClient', () => {
  const payload = {
    user_id: 'u-1',
    title: 'Order accepted',
    body: 'The store is preparing CT-1.',
    data: { order_id: 'ord-1' },
  };

  const okResponse = () => new Response('{"sent":1}', { status: 200 });

  it('posts the payload to push-send with the service-role key', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse());
    const client = new PushSendClient(
      'https://proj.supabase.co',
      'service-role-key',
      fetchImpl,
    );

    await client.send(payload);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://proj.supabase.co/functions/v1/push-send');
    expect(init.method).toBe('POST');
    // push-send reads device_tokens for an arbitrary user; the anon key cannot
    // do that and would come back 401 on every row in the queue.
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer service-role-key',
    );
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });

  it('does not double the slash when the configured URL has a trailing one', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse());
    const client = new PushSendClient(
      'https://proj.supabase.co/',
      'k',
      fetchImpl,
    );

    await client.send(payload);

    // `//functions/v1/push-send` 404s, and an env var pasted from a dashboard
    // very often carries the trailing slash.
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://proj.supabase.co/functions/v1/push-send');
  });

  it('treats 200 as success', async () => {
    const client = new PushSendClient(
      'https://p.co',
      'k',
      jest.fn().mockResolvedValue(okResponse()),
    );

    await expect(client.send(payload)).resolves.toEqual({ ok: true });
  });

  it('treats a 200 with sent:0 as success too', async () => {
    const client = new PushSendClient(
      'https://p.co',
      'k',
      jest.fn().mockResolvedValue(
        new Response('{"sent":0,"note":"FCM not configured"}', {
          status: 200,
        }),
      ),
    );

    // This is the state the whole system is in until the Firebase credentials
    // land. Calling it a failure would retry every row five times and then
    // strand the entire queue above the attempt ceiling — so when the creds
    // finally arrive, nothing would drain.
    await expect(client.send(payload)).resolves.toEqual({ ok: true });
  });

  it('reports a non-2xx as a failure carrying the status and body', async () => {
    const client = new PushSendClient(
      'https://p.co',
      'k',
      jest.fn().mockResolvedValue(
        new Response('{"error":"user_id and title are required"}', {
          status: 400,
        }),
      ),
    );

    const result = await client.send(payload);

    expect(result.ok).toBe(false);
    // The status alone cannot distinguish a malformed row from a dead
    // function, and this string is what lands in `last_error` for an admin.
    expect(result).toMatchObject({
      error: expect.stringContaining('400') as string,
    });
    expect((result as { error: string }).error).toContain(
      'user_id and title are required',
    );
  });

  it('truncates a long error body rather than storing it whole', async () => {
    const client = new PushSendClient(
      'https://p.co',
      'k',
      jest
        .fn()
        .mockResolvedValue(new Response('x'.repeat(5000), { status: 500 })),
    );

    const result = await client.send(payload);

    // last_error is a column on a row an admin reads; an HTML error page from
    // a proxy should not become a 5KB cell.
    expect((result as { error: string }).error.length).toBeLessThan(300);
  });

  it('never puts the service-role key in the error it returns', async () => {
    const client = new PushSendClient(
      'https://p.co',
      'super-secret-key',
      jest.fn().mockResolvedValue(new Response('nope', { status: 500 })),
    );

    const result = await client.send(payload);

    // `last_error` is stored in the database and read by admins — a credential
    // must never reach it.
    expect((result as { error: string }).error).not.toContain(
      'super-secret-key',
    );
  });
});
