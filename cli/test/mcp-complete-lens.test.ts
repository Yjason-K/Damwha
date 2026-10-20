import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import type { DamwhaClient } from '../src/client';
import { createMcpServer } from '../src/mcp/server';
import { MESSAGES } from '../src/messages';

type Fake = Partial<Record<keyof DamwhaClient, (...a: any[]) => unknown>>;

const lens = (over: Record<string, unknown> = {}) => ({
  id: 'lens_1',
  kind: 'action',
  text: 'Send the report',
  source: 'llm',
  user_modified: false,
  completion_status: 'open',
  lifecycle_status: 'active',
  confidence: 0.9,
  meeting_id: 'mtg_1',
  assignee_speaker_id: null,
  due_at: null,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  meeting: { id: 'mtg_1', title: 'Weekly', recorded_at: '2026-10-01T00:00:00Z' },
  evidence: [],
  ...over,
});

type Reply = { action: 'accept' | 'decline' | 'cancel' } | Error;

async function setup(fake: Fake, reply: Reply | null) {
  const server = createMcpServer({
    connect: async () => ({ kind: 'ok', baseUrl: 'http://h/api' }),
    makeClient: () => fake as unknown as DamwhaClient,
    lang: async () => 'en',
    stat: async () => null,
  });
  const client = new Client({ name: 't', version: '0' }, { capabilities: reply ? { elicitation: {} } : {} });
  const asked: any[] = [];
  if (reply) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(req.params);
      if (reply instanceof Error) throw reply;
      return reply;
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  // oninitialized는 initialized 알림이 서버에 닿은 뒤에 불린다.
  if (reply) await vi.waitFor(async () => expect((await client.listTools()).tools.map((t) => t.name)).toContain('complete_lens'));
  return { client, asked };
}

const call = (c: Client, args: Record<string, unknown> = { lens_id: 'lens_1' }) =>
  c.callTool({ name: 'complete_lens', arguments: args });

describe('complete_lens', () => {
  it('accept calls completeLens exactly once', async () => {
    const completeLens = vi.fn(async () => lens({ completion_status: 'done' }));
    const { client, asked } = await setup({ getLens: async () => lens(), completeLens }, { action: 'accept' });
    const r = await call(client);
    expect(r.isError).toBeFalsy();
    expect(completeLens).toHaveBeenCalledTimes(1);
    expect(completeLens).toHaveBeenCalledWith('lens_1');
    expect(asked).toHaveLength(1);
  });

  it('decline does not complete and says declined', async () => {
    const completeLens = vi.fn();
    const { client } = await setup({ getLens: async () => lens(), completeLens }, { action: 'decline' });
    const r: any = await call(client);
    expect(completeLens).not.toHaveBeenCalled();
    expect(r.content[0].text).toBe(MESSAGES.en.completeDeclined);
  });

  it('cancel does not complete', async () => {
    const completeLens = vi.fn();
    const { client } = await setup({ getLens: async () => lens(), completeLens }, { action: 'cancel' });
    await call(client);
    expect(completeLens).not.toHaveBeenCalled();
  });

  it('elicitation failure does not complete and is an error', async () => {
    const completeLens = vi.fn();
    const { client } = await setup({ getLens: async () => lens(), completeLens }, new Error('boom'));
    const r = await call(client);
    expect(r.isError).toBe(true);
    expect(completeLens).not.toHaveBeenCalled();
  });

  it('already done: no elicitation, no completion', async () => {
    const completeLens = vi.fn();
    const { client, asked } = await setup(
      { getLens: async () => lens({ completion_status: 'done' }), completeLens },
      { action: 'accept' },
    );
    const r: any = await call(client);
    expect(asked).toHaveLength(0);
    expect(completeLens).not.toHaveBeenCalled();
    expect(r.content[0].text).toBe(MESSAGES.en.alreadyDone);
  });

  it('message uses server-fetched text, not agent args', async () => {
    const { client, asked } = await setup(
      { getLens: async () => lens({ text: 'Real item' }), completeLens: async () => lens() },
      { action: 'decline' },
    );
    await call(client, { lens_id: 'lens_1', text: 'Fake item', title: 'Fake' });
    expect(asked[0].message).toContain('Real item');
    expect(asked[0].message).toContain('Weekly');
    expect(asked[0].message).not.toContain('Fake');
    expect(asked[0].requestedSchema).toEqual({ type: 'object', properties: {} });
  });

  it('shows assignee name and due date when present', async () => {
    const { client, asked } = await setup(
      {
        getLens: async () => lens({ assignee_speaker_id: 'spk_1', due_at: '2026-11-01T00:00:00Z' }),
        listSpeakers: async () => [{ id: 'spk_1', name: 'Kim', is_me: true }],
      },
      { action: 'decline' },
    );
    await call(client);
    expect(asked[0].message).toContain('Kim');
    expect(asked[0].message).toContain('2026-11-01');
  });

  it('strips markdown, urls and control chars, caps each field at 200', async () => {
    const { client, asked } = await setup(
      {
        getLens: async () =>
          lens({
            text: '**Click** [here](http://evil.example/x) https://evil.example/y \u001b[31m# hi\nnext' + 'a'.repeat(400),
            meeting: { id: 'm', title: '`T`' + 'b'.repeat(400), recorded_at: '' },
          }),
      },
      { action: 'decline' },
    );
    await call(client);
    const m: string = asked[0].message;
    expect(m).not.toMatch(/https?:|evil\.example|\*\*|\]\(|`|\u001b/);
    expect(m).toContain('Click');
    expect(m).not.toContain('a'.repeat(201));
    expect(m).not.toContain('b'.repeat(201));
    expect(m).toContain('a'.repeat(50));
  });

  it('is listed only for clients with elicitation', async () => {
    const withIt = await setup({}, { action: 'decline' });
    expect((await withIt.client.listTools()).tools.map((t) => t.name)).toContain('complete_lens');
    const without = await setup({}, null);
    expect((await without.client.listTools()).tools.map((t) => t.name)).not.toContain('complete_lens');
  });
});
