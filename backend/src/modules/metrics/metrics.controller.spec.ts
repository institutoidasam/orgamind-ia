import { describe, it, expect } from 'vitest';
import { MetricsController } from './metrics.controller';
import { routesOf } from '../../../test/routes-of';

describe('MetricsController', () => {
  it('rotas: sem GET /zernio', () => {
    // Métricas Zernio fora do ar (R5); o service segue como provider (GC5).
    expect(routesOf(MetricsController)).toEqual(['GET /dashboard']);
  });
});
