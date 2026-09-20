import { PushDrainService } from './push-drain.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * L3 — the drainer.
 *
 * The failure mode this guards is the same "fails upward" shape that bit the
 * POD write and that `push_outbox`'s own migration header warns about: a drain
 * that reports success while nothing was delivered, or one that stamps a row
 * sent when the send failed. A stamped row is never looked at again, so a
 * wrong stamp is a permanently lost notification.
 */
describe('PushDrainService', () => {
  let prisma: {
    push_outbox: { findMany: jest.Mock; update: jest.Mock };
  };
  let sender: { send: jest.Mock };
  let service: PushDrainService;

  const row = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 'o-1',
    user_id: 'u-1',
    title: 'Order accepted',
    body: 'The store is preparing CT-1.',
    data: { order_id: 'ord-1' },
    attempts: 0,
    ...over,
  });

  beforeEach(() => {
    prisma = {
      push_outbox: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    sender = { send: jest.fn().mockResolvedValue({ ok: true }) };

    service = new PushDrainService(prisma as unknown as PrismaService, sender);
  });

  it('only reads rows that are unsent and still under the attempt ceiling', async () => {
    await service.drain();

    // Both halves matter. Without `sent_at: null` it re-sends every
    // notification ever queued on every poll; without the `attempts` ceiling a
    // permanently undeliverable row is retried every few seconds forever.
    expect(prisma.push_outbox.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sent_at: null, attempts: { lt: 5 } },
      }),
    );
  });

  it('drains oldest-first', async () => {
    await service.drain();

    // A notification is about something that just happened, so delivering the
    // newest first would starve the oldest under sustained load — the case
    // where ordering matters most.
    expect(prisma.push_outbox.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { created_at: 'asc' } }),
    );
  });

  it('sends the row and stamps sent_at', async () => {
    prisma.push_outbox.findMany.mockResolvedValue([row()]);

    const result = await service.drain();

    expect(sender.send).toHaveBeenCalledWith({
      user_id: 'u-1',
      title: 'Order accepted',
      body: 'The store is preparing CT-1.',
      data: { order_id: 'ord-1' },
    });
    expect(prisma.push_outbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'o-1' },
        data: { sent_at: expect.any(Date) as Date, last_error: null },
      }),
    );
    expect(result).toEqual({ sent: 1, failed: 0 });
  });

  it('clears last_error when a row that had failed finally sends', async () => {
    prisma.push_outbox.findMany.mockResolvedValue([
      row({ attempts: 2, last_error: 'push-send 503' }),
    ]);

    await service.drain();

    // Stamping `sent_at` while leaving the old error in place makes a
    // delivered row read as a broken one forever, and nothing clears it later
    // because a stamped row is never selected again. Anyone auditing the queue
    // for trouble then finds failures that already resolved themselves.
    expect(prisma.push_outbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'o-1' },
        data: { sent_at: expect.any(Date) as Date, last_error: null },
      }),
    );
  });

  it('does NOT stamp sent_at when the send failed', async () => {
    prisma.push_outbox.findMany.mockResolvedValue([row()]);
    sender.send.mockResolvedValue({ ok: false, error: 'push-send 503' });

    const result = await service.drain();

    // Stamping here marks a notification delivered that never left the
    // building, and nothing ever looks at a stamped row again.
    expect(prisma.push_outbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'o-1' },
        data: { attempts: 1, last_error: 'push-send 503' },
      }),
    );
    expect(result).toEqual({ sent: 0, failed: 1 });
  });

  it('counts the attempt up from what the row already carries', async () => {
    prisma.push_outbox.findMany.mockResolvedValue([row({ attempts: 3 })]);
    sender.send.mockResolvedValue({ ok: false, error: 'boom' });

    await service.drain();

    // Writing a literal 1, or incrementing from 0, means `attempts` never
    // reaches the ceiling and a dead row is retried for the life of the
    // deployment.
    expect(prisma.push_outbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { attempts: 4, last_error: 'boom' },
      }),
    );
  });

  it('a thrown sender is a failure, not a crashed batch', async () => {
    prisma.push_outbox.findMany.mockResolvedValue([row()]);
    sender.send.mockRejectedValue(new Error('socket hang up'));

    const result = await service.drain();

    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(prisma.push_outbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { attempts: 1, last_error: 'socket hang up' },
      }),
    );
  });

  it('one failure does not stop the rest of the batch', async () => {
    prisma.push_outbox.findMany.mockResolvedValue([
      row({ id: 'o-1' }),
      row({ id: 'o-2' }),
      row({ id: 'o-3' }),
    ]);
    sender.send
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: 'nope' })
      .mockResolvedValueOnce({ ok: true });

    const result = await service.drain();

    expect(result).toEqual({ sent: 2, failed: 1 });
    expect(sender.send).toHaveBeenCalledTimes(3);
  });

  it('does nothing, and sends nothing, when the queue is empty', async () => {
    const result = await service.drain();

    expect(sender.send).not.toHaveBeenCalled();
    expect(prisma.push_outbox.update).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, failed: 0 });
  });

  it('does not read or send at all when push is not configured', async () => {
    const unconfigured = new PushDrainService(
      prisma as unknown as PrismaService,
      null,
    );

    const result = await unconfigured.drain();

    // Booting must never require the Supabase service-role key to be present,
    // and polling a queue we cannot drain is pure noise in the logs.
    expect(prisma.push_outbox.findMany).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, failed: 0 });
  });

  it('will not start a second pass while one is still in flight', async () => {
    let release!: () => void;
    prisma.push_outbox.findMany
      .mockImplementationOnce(
        () => new Promise((res) => (release = () => res([]))),
      )
      .mockResolvedValue([]);

    const first = service.drain();
    const second = await service.drain();

    // The poll is far shorter than a batch of 50 HTTP sends can take. Without
    // this guard the second pass reads the same unstamped rows and sends every
    // one of them twice.
    expect(second).toEqual({ sent: 0, failed: 0 });
    expect(prisma.push_outbox.findMany).toHaveBeenCalledTimes(1);

    release();
    await first;
  });

  it('releases the in-flight guard even when the pass throws', async () => {
    prisma.push_outbox.findMany.mockRejectedValueOnce(new Error('db down'));

    await expect(service.drain()).rejects.toThrow('db down');

    // A guard left set by a failed pass wedges the drainer permanently — the
    // queue would stop draining and nothing would say why.
    prisma.push_outbox.findMany.mockResolvedValue([]);
    await expect(service.drain()).resolves.toEqual({ sent: 0, failed: 0 });
  });

  it('the scheduled entry point swallows errors rather than killing the process', async () => {
    prisma.push_outbox.findMany.mockRejectedValue(new Error('db down'));

    await expect(service.handleCron()).resolves.toBeUndefined();
  });
});
