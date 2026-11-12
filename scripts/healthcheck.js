import { statSync } from 'node:fs';
try {
  const age=Date.now()-statSync(process.env.HEALTH_FILE||'/tmp/maple-ready').mtimeMs;
  process.exit(age<30_000?0:1);
} catch {process.exit(1);}
