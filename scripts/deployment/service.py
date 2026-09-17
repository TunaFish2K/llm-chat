#!/usr/bin/env python3
"""Single-worker, durable tag deployment for the existing served lifecycle."""
import argparse
import ast
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from protocol import BASE_PATH, authenticated


def atomic_write(path, text, mode=0o600):
    path = Path(path)
    temporary = path.with_name(path.name + '.new')
    with temporary.open('w') as stream:
        os.chmod(temporary, mode)
        stream.write(text)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class Jobs:
    def __init__(self, path):
        self.path = str(path)
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS jobs (
                    id INTEGER PRIMARY KEY, number INTEGER NOT NULL UNIQUE,
                    payload TEXT NOT NULL, status TEXT NOT NULL, phase TEXT NOT NULL,
                    details TEXT NOT NULL DEFAULT '{}', error TEXT NOT NULL DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            ''')

    @contextlib.contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def decode(row):
        if row is None:
            return None
        result = dict(row)
        result['payload'] = json.loads(result['payload'])
        result['details'] = json.loads(result['details'])
        return result

    def get(self, job_id):
        with self.connect() as db:
            return self.decode(db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone())

    def blocked(self):
        with self.connect() as db:
            row = db.execute("SELECT value FROM settings WHERE key='blocked'").fetchone()
            return row[0] if row else ''

    def block(self, reason):
        with self.connect() as db:
            db.execute("INSERT OR REPLACE INTO settings VALUES ('blocked', ?)", (reason,))

    def clear_block(self):
        with self.connect() as db:
            db.execute("DELETE FROM settings WHERE key='blocked'")

    def submit(self, payload):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            old = self.decode(db.execute('SELECT * FROM jobs WHERE id=?', (payload['run_id'],)).fetchone())
            if old:
                for key in ['repository', 'tag', 'sha', 'run_number']:
                    if old['payload'][key] != payload[key]:
                        raise ValueError('Run identity changed')
                if old['status'] != 'failed' or payload['attempt'] <= old['payload']['attempt']:
                    return old
                db.execute('DELETE FROM jobs WHERE id=?', (payload['run_id'],))
            maximum = db.execute('SELECT MAX(number) FROM jobs').fetchone()[0] or 0
            status = 'superseded' if payload['run_number'] < maximum else 'queued'
            if status == 'queued':
                db.execute("UPDATE jobs SET status='superseded', phase='done' WHERE status='queued' AND number<?", (payload['run_number'],))
            db.execute('INSERT INTO jobs (id,number,payload,status,phase) VALUES (?,?,?,?,?)',
                       (payload['run_id'], payload['run_number'], json.dumps(payload), status, 'queued'))
        return self.get(payload['run_id'])

    def update(self, job_id, status=None, phase=None, details=None, error=None):
        values = {key: value for key, value in [('status', status), ('phase', phase),
                  ('details', json.dumps(details) if details is not None else None), ('error', error)] if value is not None}
        with self.connect() as db:
            db.execute('UPDATE jobs SET ' + ','.join(f'{key}=?' for key in values) + ' WHERE id=?', (*values.values(), job_id))

    def next(self):
        with self.connect() as db:
            return self.decode(db.execute("SELECT * FROM jobs WHERE status IN ('running','queued') ORDER BY status='running' DESC, number DESC LIMIT 1").fetchone())

    def newer(self, number):
        with self.connect() as db:
            return db.execute('SELECT 1 FROM jobs WHERE number>? LIMIT 1', (number,)).fetchone() is not None


def validate_payload(payload, repository):
    if not isinstance(payload, dict) or payload.get('repository') != repository:
        raise ValueError('Unexpected repository')
    tag = payload.get('tag')
    if not isinstance(tag, str) or len(tag) > 256 or subprocess.run(
        ['git', 'check-ref-format', 'refs/tags/' + tag], stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, timeout=5).returncode:
        raise ValueError('Invalid tag')
    if not isinstance(payload.get('sha'), str) or not re.fullmatch('[0-9a-f]{40}', payload['sha']):
        raise ValueError('Invalid commit')
    for key in ['run_id', 'run_number', 'attempt']:
        if type(payload.get(key)) is not int or not 0 < payload[key] < 2**63:
            raise ValueError('Invalid run identity')
    return {key: payload[key] for key in ['repository', 'tag', 'sha', 'run_id', 'run_number', 'attempt']}


class Deployer:
    def __init__(self, config, jobs):
        self.config, self.jobs = config, jobs
        self.state = Path(config['state_dir'])
        self.lifecycle = Path(config['lifecycle'])
        self.log = None
        self.lock_fd = None

    def command(self, args, cwd=None, timeout=1800, capture=False):
        environment = dict(os.environ)
        for name in ['CLOUDFLARE_API_TOKEN', 'LLM_CHAT_DEPLOY_SECRET', 'GITHUB_TOKEN', 'GH_TOKEN']:
            environment.pop(name, None)
        with subprocess.Popen(args, cwd=cwd, env=environment, stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE if capture else self.log,
                              stderr=self.log, start_new_session=True,
                              pass_fds=(self.lock_fd,) if self.lock_fd is not None else ()) as process:
            try:
                output, _ = process.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                raise RuntimeError(f'{Path(args[0]).name} exceeded its time limit')
            if process.returncode:
                raise RuntimeError(f'{Path(args[0]).name} failed (exit {process.returncode}); see deployment log')
            return output.decode().strip() if capture else None

    def current_release(self):
        tree = ast.parse(self.lifecycle.read_text())
        for item in tree.body:
            if isinstance(item, ast.Assign) and any(isinstance(v, ast.Name) and v.id == 'RELEASE' for v in item.targets):
                return Path(ast.literal_eval(item.value.args[0]))
        raise RuntimeError('Lifecycle RELEASE not found')

    def point_to(self, release):
        source, count = re.subn(r'^RELEASE = Path\(.*\)$', lambda _: f'RELEASE = Path({str(release)!r})',
                               self.lifecycle.read_text(), flags=re.M)
        if count != 1:
            raise RuntimeError('Lifecycle RELEASE is ambiguous')
        compile(source, str(self.lifecycle), 'exec')
        atomic_write(self.lifecycle, source, self.lifecycle.stat().st_mode & 0o777)

    def schema(self):
        path = Path(self.config['data_dir']) / 'llm-chat.sqlite'
        with contextlib.closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as db:
            return db.execute('PRAGMA user_version').fetchone()[0]

    @staticmethod
    def build_id(release):
        return json.loads((Path(release) / 'apps/server/dist/build-info.json').read_text())['buildId']

    def probe(self, url, expected, family='4'):
        raw = self.command(['curl', '--noproxy', '*', '-' + family, '--fail', '--silent', '--show-error',
                            '--max-time', '10', url], capture=True, timeout=15)
        result = json.loads(raw)
        if result.get('ok') is not True or result.get('buildId') != expected:
            raise RuntimeError('Readiness returned an unexpected build')

    def wait_ready(self, expected, public=False):
        probes = self.config['public_probes'] if public else [{'url': self.config['ready_url'], 'family': '4'}]
        deadline = time.monotonic() + 60
        while True:
            try:
                for probe in probes:
                    self.probe(probe['url'], expected, probe.get('family', '4'))
                return
            except (RuntimeError, ValueError):
                if time.monotonic() >= deadline:
                    raise
                time.sleep(2)

    def stop(self):
        # The lifecycle waits up to 45 seconds before served's short stop deadline.
        self.command(['python3', str(self.lifecycle), 'drain-if-running'], timeout=60)
        self.command(['served', 'disable', 'llm-chat'], timeout=15)

    def start(self):
        self.command(['served', 'enable'], cwd=self.config['app_service_dir'], timeout=15)

    def verify_tag(self, payload, repo):
        self.command(['git', '--git-dir', str(repo), 'fetch', '--no-tags', self.config['git_url'],
                      'refs/tags/' + payload['tag']], timeout=180)
        sha = self.command(['git', '--git-dir', str(repo), 'rev-parse', 'FETCH_HEAD^{commit}'], capture=True, timeout=10)
        if sha != payload['sha']:
            raise RuntimeError('Tag no longer points to the CI-verified commit')

    def rollback(self, job):
        details = job['details']
        self.stop()
        if self.schema() != details['schema_before']:
            raise RuntimeError('Database schema changed; restore the saved backup manually before resuming deployment')
        self.point_to(details['old_release'])
        self.start()
        self.wait_ready(self.build_id(details['old_release']))
        self.wait_ready(self.build_id(details['old_release']), public=True)

    def recover(self, job):
        if job['phase'] in ['queued', 'building']:
            self.jobs.update(job['id'], status='queued', phase='queued')
            return
        try:
            if job['phase'] in ['starting', 'probing'] and self.current_release() == Path(job['details']['release']):
                try:
                    self.wait_ready(job['payload']['sha'][:12])
                    self.wait_ready(job['payload']['sha'][:12], public=True)
                    self.jobs.update(job['id'], status='succeeded', phase='done')
                    return
                except Exception:
                    pass
            self.rollback(job)
            self.jobs.update(job['id'], status='failed', error='Interrupted deployment recovered to the previous release')
        except Exception as error:
            self.jobs.block(str(error))
            self.jobs.update(job['id'], status='failed', error='Recovery requires operator attention: ' + str(error))

    def deploy(self, job):
        payload = job['payload']
        repo = self.state / 'repository.git'
        release = Path(self.config['releases_dir']) / f"{payload['sha'][:12]}-ci-{job['id']}-{time.time_ns()}"
        details = {'release': str(release)}
        self.jobs.update(job['id'], status='running', phase='building', details=details)
        try:
            if not repo.exists():
                self.command(['git', 'init', '--bare', str(repo)], timeout=15)
            self.verify_tag(payload, repo)
            release.mkdir(parents=True)
            archive = self.state / 'source.tar'
            self.command(['git', '--git-dir', str(repo), 'archive', '--format=tar', '-o', str(archive), payload['sha']], timeout=60)
            self.command(['tar', '-xf', str(archive), '-C', str(release)], timeout=60)
            archive.unlink()
            for command in [['pnpm', 'install', '--frozen-lockfile'], ['pnpm', 'build'], ['pnpm', 'test:deploy']]:
                self.command(command, cwd=release)
            if self.build_id(release) != payload['sha'][:12]:
                raise RuntimeError('Build identity does not match the requested commit')
            self.verify_tag(payload, repo)
            if self.jobs.newer(job['number']):
                self.jobs.update(job['id'], status='superseded', phase='done')
                return
            backup = Path(self.config['backups_dir']) / release.name
            backup.mkdir(parents=True)
            details.update(old_release=str(self.current_release()), backup=str(backup), schema_before=self.schema())
            self.jobs.update(job['id'], phase='stopping', details=details)
            self.stop()
            self.jobs.update(job['id'], phase='backing_up')
            for source, name in [(self.config['data_dir'], 'data'), (self.config['app_config'], 'config.json'),
                                 (str(self.lifecycle), 'lifecycle.py')]:
                self.command(['cp', '-a', '--reflink=auto', source, str(backup / name)], timeout=600)
            self.jobs.update(job['id'], phase='switching')
            self.point_to(release)
            self.jobs.update(job['id'], phase='starting')
            self.start()
            self.jobs.update(job['id'], phase='probing')
            self.wait_ready(payload['sha'][:12])
            self.wait_ready(payload['sha'][:12], public=True)
            self.jobs.update(job['id'], status='succeeded', phase='done')
        except Exception as error:
            message = str(error)
            current = self.jobs.get(job['id'])
            if current['phase'] != 'building':
                try:
                    self.rollback(current)
                    message += '; previous release restored'
                except Exception as recovery_error:
                    message += '; recovery requires operator attention: ' + str(recovery_error)
                    self.jobs.block(message)
            self.jobs.update(job['id'], status='failed', error=message)

    def work(self, stop):
        while not stop.wait(1):
            if self.jobs.blocked():
                continue
            job = self.jobs.next()
            if job is None:
                continue
            with open(self.config['deploy_lock'], 'a') as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    continue
                self.lock_fd = lock.fileno()
                log_path = self.state / 'logs' / f"{job['id']}.log"
                with log_path.open('a') as log:
                    self.log = log
                    try:
                        # Another request may have superseded a queued job before we obtained the lock.
                        job = self.jobs.get(job['id'])
                        if job['status'] == 'running':
                            self.recover(job)
                        elif job['status'] == 'queued':
                            self.deploy(job)
                    except Exception as error:
                        self.jobs.block(str(error))
                        self.jobs.update(job['id'], status='failed', error=str(error))
                    finally:
                        self.log = None
                        self.lock_fd = None


def handler(jobs, secret, repository):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *_):
            pass

        def send_json(self, code, value):
            body = json.dumps(value).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def respond(self):
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if self.headers.get('Transfer-Encoding') or not 0 <= size <= 8192:
                    return self.send_json(413, {'error': 'Request too large or unsupported encoding'})
                body = self.rfile.read(size)
                if len(body) != size or not authenticated(secret, self.headers, self.command, self.path, body):
                    return self.send_json(401, {'error': 'Invalid signature or timestamp'})
                if self.command == 'POST' and self.path == BASE_PATH:
                    payload = validate_payload(json.loads(body), repository)
                    if jobs.blocked():
                        return self.send_json(503, {'error': 'Deployment paused; operator recovery required'})
                    result = jobs.submit(payload)
                    code = 202
                elif self.command == 'GET' and re.fullmatch(re.escape(BASE_PATH) + r'/[0-9]+', self.path):
                    result = jobs.get(int(self.path.rsplit('/', 1)[1]))
                    if result is None:
                        return self.send_json(404, {'error': 'Unknown deployment'})
                    code = 200
                else:
                    return self.send_json(404, {'error': 'Unknown endpoint'})
                return self.send_json(code, {key: result[key] for key in ['id', 'status', 'phase', 'error']})
            except (ValueError, TypeError, sqlite3.IntegrityError):
                self.send_json(400, {'error': 'Invalid deployment request'})
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass

        do_GET = respond
        do_POST = respond

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--clear-block', action='store_true', help='Resume after manual recovery and a successful local readiness check')
    args = parser.parse_args()
    os.umask(0o077)
    config = json.loads(Path(args.config).read_text())
    state = Path(config['state_dir'])
    (state / 'logs').mkdir(parents=True, exist_ok=True)
    jobs = Jobs(state / 'jobs.sqlite')
    deployer = Deployer(config, jobs)
    if args.clear_block:
        with open(config['deploy_lock'], 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            deployer.wait_ready(deployer.build_id(deployer.current_release()))
            jobs.clear_block()
        print('Deployment resumed')
        return
    with (state / 'service.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        secret = Path(config['secret_file']).read_bytes().strip()
        if len(secret) < 32:
            raise ValueError('Deployment secret must contain at least 32 bytes')
        stop = threading.Event()
        server = ThreadingHTTPServer(('127.0.0.1', config.get('port', 11113)), handler(jobs, secret, config['repository']))
        server.timeout = 1
        for sig in [signal.SIGTERM, signal.SIGINT]:
            signal.signal(sig, lambda *_: stop.set())
        worker = threading.Thread(target=deployer.work, args=(stop,))
        worker.start()
        print('Deployment receiver ready on loopback', flush=True)
        try:
            while not stop.is_set():
                server.handle_request()
        finally:
            server.server_close()
            worker.join()


if __name__ == '__main__':
    main()
