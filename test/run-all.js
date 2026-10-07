// Rasoi test runner: boots one embedded Postgres, then runs every test file
// with DATABASE_URL set. Run: npm test  (as a non-root user; postgres refuses root)
const { spawnSync } = require('child_process');
const fs = require('fs');

(async () => {
  console.log('Booting embedded Postgres for tests...');
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dir = '/tmp/rasoi-test-pg';
  fs.rmSync(dir, { recursive: true, force: true });
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'postgres',
    port: 55433,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  const DB = 'postgres://postgres:postgres@127.0.0.1:55433/postgres';
  console.log('Postgres up.\n');

  let code = 0;
  try {
    for (const f of ['test/voice-parse-test.js', 'test/smoke.js', 'test/suggest-test.js']) {
      console.log('\n===== ' + f + ' =====');
      const r = spawnSync('node', [f], {
        cwd: __dirname + '/..',
        env: Object.assign({}, process.env, { DATABASE_URL: DB }),
        stdio: 'inherit',
      });
      if (r.status !== 0) { code = r.status || 1; console.log(`-- ${f} FAILED (exit ${r.status})`); }
    }
  } finally {
    await pg.stop();
    console.log('\nPostgres stopped.');
  }
  console.log(code === 0 ? '\nFULL SUITE PASSED ✅' : '\nSUITE HAD FAILURES ❌');
  process.exit(code);
})().catch((e) => { console.error('runner error:', e); process.exit(2); });
