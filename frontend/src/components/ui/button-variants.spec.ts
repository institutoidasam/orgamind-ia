import { describe, expect, it } from 'vitest'

import { buttonVariants } from './button-variants'

describe('buttonVariants', () => {
  it('mantém as classes padrão e as combinações públicas de variante e tamanho', () => {
    expect(buttonVariants()).toContain('bg-primary')
    expect(buttonVariants({ variant: 'outline', size: 'lg' })).toContain(
      'border-border',
    )
    expect(buttonVariants({ variant: 'destructive', size: 'icon' })).toContain(
      'size-8',
    )
  })
})
