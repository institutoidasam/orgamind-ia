import '@testing-library/jest-dom';

/**
 * jsdom não implementa ResizeObserver, e os primitivos do Radix que medem o
 * próprio nó (`useSize` — Checkbox, Select, …) o chamam no primeiro efeito.
 * Sem este stub, renderizar um Checkbox num teste explode com
 * `ReferenceError: ResizeObserver is not defined` antes de qualquer assert.
 *
 * Stub inerte de propósito: nenhum teste depende de callback de resize; o que
 * eles precisam é que o componente monte.
 */
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
