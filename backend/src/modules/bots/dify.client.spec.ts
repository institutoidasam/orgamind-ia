import { describe, it, expect, vi, afterEach } from 'vitest';
import { DifyClient } from './dify.client';

afterEach(() => vi.restoreAllMocks());

function mockFetchOnce(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

// Streams the given chunks as a text/event-stream body (chunk boundaries may split lines).
function mockFetchSse(status: number, chunks: string[]) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } }),
  );
}

describe('DifyClient.chat', () => {
  it('POSTs to {baseUrl}/chat-messages with bearer + streaming, aggregates chat message deltas', async () => {
    const spy = mockFetchSse(200, [
      'data: {"event":"message","answer":"olá","conversation_id":"conv-123","message_id":"msg-9"}\n\n',
      'data: {"event":"message","answer":"!","conversation_id":"conv-123","message_id":"msg-9"}\n\n',
      'data: {"event":"message_end","conversation_id":"conv-123","message_id":"msg-9"}\n\n',
    ]);
    const client = new DifyClient();
    const r = await client.chat({
      baseUrl: 'https://dify.host/v1',
      apiKey: 'app-key',
      query: 'oi',
      user: '+5592999',
      conversationId: null,
      inputs: {},
      files: [],
    });
    expect(r).toEqual({ answer: 'olá!', conversationId: 'conv-123', messageId: 'msg-9' });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://dify.host/v1/chat-messages');
    expect((init as RequestInit).method).toBe('POST');
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('authorization')).toBe('Bearer app-key');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.response_mode).toBe('streaming');
    expect(sent.query).toBe('oi');
    expect(sent.user).toBe('+5592999');
    expect(sent).not.toHaveProperty('conversation_id'); // omitted when null
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('aggregates agent_message deltas and captures conversation_id + id', async () => {
    mockFetchSse(200, [
      'data: {"event":"agent_message","answer":"resposta ","conversation_id":"c-agent","id":"m-agent"}\n\n',
      'data: {"event":"agent_message","answer":"do agente","conversation_id":"c-agent","id":"m-agent"}\n\n',
      'data: {"event":"message_end","conversation_id":"c-agent"}\n\n',
    ]);
    const client = new DifyClient();
    const r = await client.chat({
      baseUrl: 'https://dify.host/v1',
      apiKey: 'k',
      query: 'q',
      user: 'u',
      conversationId: null,
    });
    expect(r).toEqual({ answer: 'resposta do agente', conversationId: 'c-agent', messageId: 'm-agent' });
  });

  it('reassembles a data line split across stream chunks', async () => {
    mockFetchSse(200, [
      'data: {"event":"message","ans',
      'wer":"hi","conversation_id":"c","message_id":"m"}\n\n',
    ]);
    const client = new DifyClient();
    const r = await client.chat({
      baseUrl: 'https://dify.host/v1',
      apiKey: 'k',
      query: 'q',
      user: 'u',
    });
    expect(r).toEqual({ answer: 'hi', conversationId: 'c', messageId: 'm' });
  });

  it('includes conversation_id and files when provided', async () => {
    const spy = mockFetchSse(200, [
      'data: {"event":"message","answer":"a","conversation_id":"c","message_id":"m"}\n\n',
    ]);
    const client = new DifyClient();
    await client.chat({
      baseUrl: 'https://dify.host/v1',
      apiKey: 'k',
      query: 'q',
      user: 'u',
      conversationId: 'c-existing',
      files: [{ type: 'image', transfer_method: 'local_file', upload_file_id: 'f1' }],
    });
    const sent = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.conversation_id).toBe('c-existing');
    expect(sent.files).toEqual([{ type: 'image', transfer_method: 'local_file', upload_file_id: 'f1' }]);
  });

  it('throws when the stream emits an error event (e.g. agent-chat blocking rejection)', async () => {
    mockFetchSse(200, [
      'data: {"event":"error","status":400,"message":"Agent Chat App does not support blocking mode"}\n\n',
    ]);
    const client = new DifyClient();
    await expect(
      client.chat({ baseUrl: 'https://dify.host/v1', apiKey: 'k', query: 'q', user: 'u' }),
    ).rejects.toThrow(/does not support blocking mode/);
  });

  it('throws on non-2xx', async () => {
    mockFetchOnce(401, { message: 'unauthorized' });
    const client = new DifyClient();
    await expect(
      client.chat({ baseUrl: 'https://dify.host/v1', apiKey: 'bad', query: 'q', user: 'u' }),
    ).rejects.toThrow(/Dify chat failed: 401/);
  });
});

describe('DifyClient.uploadFile', () => {
  it('POSTs multipart to {baseUrl}/files/upload and returns the id', async () => {
    const spy = mockFetchOnce(201, { id: 'file-77' });
    const client = new DifyClient();
    const r = await client.uploadFile({
      baseUrl: 'https://dify.host/v1',
      apiKey: 'k',
      user: 'u',
      bytes: Buffer.from('img'),
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
    });
    expect(r).toEqual({ id: 'file-77' });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://dify.host/v1/files/upload');
    expect((init as RequestInit).body).toBeInstanceOf(FormData);
  });
});
