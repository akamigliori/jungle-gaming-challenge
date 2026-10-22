import { expect, test } from 'bun:test';

const EXIT_FAILURE = 1;

test('startup failure is logged as one JSON line and the process exits with code 1', async () => {
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    env: { ...process.env, PORT: 'not-a-port' },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  expect(exitCode).toBe(EXIT_FAILURE);
  const line = stderr.split('\n').find((l) => l.startsWith('{'));
  expect(line).toBeDefined();
  expect(JSON.parse(line as string)).toMatchObject({ level: 'fatal', msg: 'startup failed' });
});
