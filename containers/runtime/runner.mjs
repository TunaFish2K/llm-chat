import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
const [action, id, value] = process.argv.slice(2);
if (action === 'init') {
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  setInterval(() => {}, 60000);
} else {
  if (!/^[a-f0-9-]{36}$/.test(id ?? '')) throw new Error('Invalid execution id');
  const file = `/run/llm-chat/${id}.json`;
  const identity = pid => readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19];
  if (action === 'stop') {
    writeFileSync(file + '.cancel', '', { mode: 0o600 });
    try {
      const record = JSON.parse(readFileSync(file, 'utf8'));
      if (identity(record.pid) === record.identity) process.kill(record.pid, value === 'SIGKILL' ? 'SIGUSR2' : 'SIGTERM');
    } catch (error) { if (!['ENOENT','ESRCH'].includes(error.code)) throw error; }
  } else if (action === 'run') {
    let child;
    let killing;
    const signalGroup = signal => { if (child?.pid) { try { process.kill(-child.pid, signal); } catch {} } };
    const stop = () => {
      signalGroup('SIGTERM');
      killing ??= setTimeout(() => signalGroup('SIGKILL'), 1000);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    process.on('SIGUSR2', () => signalGroup('SIGKILL'));
    process.on('exit', () => { signalGroup('SIGKILL'); try { unlinkSync(file); } catch {} try { unlinkSync(file + '.cancel'); } catch {} });
    writeFileSync(file, JSON.stringify({ pid: process.pid, identity: identity(process.pid) }), { mode: 0o600 });
    if (existsSync(file + '.cancel')) process.exit(130);
    child = spawn('/bin/sh', ['-lc', value], { detached: true, stdio: 'inherit' });
    child.on('error', error => { process.stderr.write(`${error.message}\n`); process.exit(127); });
    child.on('exit', (code, signal) => { clearTimeout(killing); signalGroup('SIGKILL'); process.exit(code ?? (signal ? 128 : 1)); });
  } else throw new Error('Unknown runtime action');
}
