import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import type { Response } from 'express';
import { ChatMediaController } from './chat-media.controller';
import { ChatMediaService } from './chat-media.service';

interface FakeRes {
  headers: Record<string, string>;
  setHeader: ReturnType<typeof vi.fn>;
}

function makeRes(): { fake: FakeRes; res: Response } {
  const headers: Record<string, string> = {};
  const setHeader = vi.fn((k: string, v: string) => { headers[k] = v; });
  const fake: FakeRes = { headers, setHeader };
  return { fake, res: fake as unknown as Response };
}

function makeStream() {
  return { on: vi.fn(), pipe: vi.fn() } as never; // controller calls stream.on('error',..) then stream.pipe(res)
}

describe('ChatMediaController.serve — security headers', () => {
  let svc: MockProxy<ChatMediaService>;
  let ctrl: ChatMediaController;
  beforeEach(() => { svc = mockDeep<ChatMediaService>(); ctrl = new ChatMediaController(svc); });

  it('serves a safe image inline with nosniff', async () => {
    svc.getReadyMedia.mockResolvedValue({ stream: makeStream(), mimeType: 'image/jpeg', fileName: 'a.jpg' } as never);
    const { fake, res } = makeRes();
    await ctrl.serve('m1', res);
    expect(fake.headers['Content-Type']).toBe('image/jpeg');
    expect(fake.headers['Content-Disposition']).toContain('inline');
    expect(fake.headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('forces attachment + octet-stream for unsafe mime types (html/svg/pdf)', async () => {
    for (const mime of ['text/html', 'image/svg+xml', 'application/pdf']) {
      svc.getReadyMedia.mockResolvedValue({ stream: makeStream(), mimeType: mime, fileName: 'x' } as never);
      const { fake, res } = makeRes();
      await ctrl.serve('m1', res);
      expect(fake.headers['Content-Type']).toBe('application/octet-stream');
      expect(fake.headers['Content-Disposition']).toContain('attachment');
      expect(fake.headers['X-Content-Type-Options']).toBe('nosniff');
    }
  });
});
