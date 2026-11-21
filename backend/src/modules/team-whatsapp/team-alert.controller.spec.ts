import { describe, expect, it, vi } from 'vitest';
import { TeamAlertController } from './team-alert.controller';

// CI6 (GI9): as rotas da ciência manual repassam ids, observação e o relógio
// lido no controller; recusas e gravação ficam no serviço (spec próprio).
function setup() {
  const ack = {
    markManual: vi.fn().mockResolvedValue(undefined),
    undoManual: vi.fn().mockResolvedValue(undefined),
  };
  const controller = new TeamAlertController({} as never, ack as never);
  return { ack, controller, req: { user: { sub: 'sup-1' } } as never };
}

describe('TeamAlertController — ciência manual (CI6)', () => {
  it('POST …/ack repassa ator, envio, destinatário, observação e a hora do pedido', async () => {
    const { ack, controller, req } = setup();
    const before = Date.now();
    await expect(
      controller.markAck('d1', 'r1', { note: 'ligou' }, req),
    ).resolves.toBeUndefined();
    const [actorId, dispatchId, recipientId, input] = ack.markManual.mock
      .calls[0] as [string, string, string, { note: string; now: Date }];
    expect([actorId, dispatchId, recipientId, input.note]).toEqual([
      'sup-1',
      'd1',
      'r1',
      'ligou',
    ]);
    expect(input.now.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('DELETE …/ack repassa ator, envio e destinatário', async () => {
    const { ack, controller, req } = setup();
    await expect(controller.undoAck('d1', 'r1', req)).resolves.toBeUndefined();
    expect(ack.undoManual).toHaveBeenCalledWith('sup-1', 'd1', 'r1');
  });
});
