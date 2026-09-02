import { Injectable } from '@nestjs/common';

const CHAT_TIMEOUT_MS = 45_000;
const UPLOAD_FILE_TIMEOUT_MS = 30_000;

export type DifyFile = {
  type: 'image' | 'audio' | 'document' | 'video' | 'custom';
  transfer_method: 'remote_url' | 'local_file';
  url?: string;
  upload_file_id?: string;
};

export type DifyChatArgs = {
  baseUrl: string;
  apiKey: string;
  query: string;
  user: string;
  conversationId?: string | null;
  inputs?: Record<string, unknown>;
  files?: DifyFile[];
};

export type DifyChatResult = { answer: string; conversationId: string; messageId: string };

@Injectable()
export class DifyClient {
  async chat(args: DifyChatArgs): Promise<DifyChatResult> {
    // Streaming mode: agent-chat apps reject `blocking` with 400 ("Agent Chat App does
    // not support blocking mode"), and advanced-chat apps also benefit from streaming.
    // We aggregate the SSE stream back into the same blocking-style result shape.
    const body: Record<string, unknown> = {
      inputs: args.inputs ?? {},
      query: args.query,
      response_mode: 'streaming',
      user: args.user,
    };
    if (args.conversationId) body.conversation_id = args.conversationId;
    if (args.files && args.files.length > 0) body.files = args.files;

    const res = await fetch(`${args.baseUrl}/chat-messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${args.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Dify chat failed: ${res.status} ${text.slice(0, 300)}`);
    }
    return this.aggregateChatStream(res);
  }

  // Parses a Dify `text/event-stream` body line-by-line. Each `data: {json}` line is an
  // event; `answer` deltas (chat apps emit `event:'message'`, agent-chat `event:'agent_message'`)
  // are concatenated, and conversation_id / message_id are captured from any event.
  private async aggregateChatStream(res: Response): Promise<DifyChatResult> {
    let answer = '';
    let conversationId = '';
    let messageId = '';

    const handleLine = (line: string): void => {
      const trimmed = line.trimStart();
      if (!trimmed.startsWith('data:')) return; // skip blank lines, comments, event: lines
      const payload = trimmed.slice(trimmed.indexOf(':') + 1).trim();
      if (!payload || payload === '[DONE]') return;
      let evt: {
        event?: string;
        answer?: string;
        conversation_id?: string;
        message_id?: string;
        id?: string;
        status?: number;
        message?: string;
      };
      try {
        evt = JSON.parse(payload);
      } catch {
        return; // ignore keep-alive / non-JSON lines
      }
      if (evt.event === 'error') {
        throw new Error(`Dify chat stream error: ${evt.status ?? ''} ${evt.message ?? ''}`.trim());
      }
      if (typeof evt.answer === 'string') answer += evt.answer;
      if (evt.conversation_id) conversationId = evt.conversation_id;
      const eventMessageId = evt.message_id ?? evt.id;
      if (eventMessageId) messageId = eventMessageId;
    };

    const stream = res.body;
    if (!stream) {
      throw new Error('Dify chat failed: empty response stream');
    }
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          handleLine(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
        }
      }
      buffer += decoder.decode();
      if (buffer.length > 0) handleLine(buffer);
    } finally {
      reader.releaseLock();
    }

    return { answer, conversationId, messageId };
  }

  async uploadFile(args: {
    baseUrl: string;
    apiKey: string;
    user: string;
    bytes: Buffer;
    fileName: string;
    mimeType: string;
  }): Promise<{ id: string }> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(args.bytes)], { type: args.mimeType }), args.fileName);
    form.append('user', args.user);
    const res = await fetch(`${args.baseUrl}/files/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${args.apiKey}` }, // no content-type — fetch sets the multipart boundary
      body: form,
      signal: AbortSignal.timeout(UPLOAD_FILE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Dify upload failed: ${res.status} ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as { id?: string };
    return { id: data.id ?? '' };
  }
}
