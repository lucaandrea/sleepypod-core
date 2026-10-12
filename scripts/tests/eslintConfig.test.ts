// @vitest-environment node
import { ESLint } from 'eslint'
import { expect, it } from 'vitest'

it('recognizes runtime references in JS and TypeScript config files while rejecting unused variables', async () => {
  const eslint = new ESLint({ cwd: process.cwd() })
  for (const filePath of ['lint-fixture.mjs', 'lint-fixture.mts']) {
    const [used] = await eslint.lintText('const value = 1\nexport default value\n', { filePath })
    expect(used.messages).toEqual([])
    const [unused] = await eslint.lintText('const forgotten = 1\n', { filePath })
    expect(unused.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: '@typescript-eslint/no-unused-vars', severity: 2 }),
    ]))
  }
}, 20000)
