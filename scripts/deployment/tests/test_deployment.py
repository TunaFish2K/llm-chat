import contextlib
import http.client
import json
import fcntl
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from protocol import BASE_PATH, authenticated, signature
from service import Deployer, Jobs, handler, validate_payload
from notify import new_tag
import notify

SECRET = b'a-test-secret-with-at-least-thirty-two-bytes'
REPOSITORY = 'TunaFish2K/llm-chat'


def payload(number=1, **changes):
    return dict(repository=REPOSITORY, tag=f'v{number}', sha='a' * 40,
                run_id=number, run_number=number, attempt=1, **changes)


class ProtocolTests(unittest.TestCase):
    def test_signature_binds_method_path_time_and_exact_body(self):
        headers = {'X-Deploy-Timestamp': '1000',
                   'X-Deploy-Signature': signature(SECRET, '1000', 'POST', BASE_PATH, b'{}')}
        self.assertTrue(authenticated(SECRET, headers, 'POST', BASE_PATH, b'{}', now=1000))
        for method, path, body, now in [('GET', BASE_PATH, b'{}', 1000), ('POST', BASE_PATH + '/1', b'{}', 1000),
                                         ('POST', BASE_PATH, b'{ }', 1000), ('POST', BASE_PATH, b'{}', 1301)]:
            self.assertFalse(authenticated(SECRET, headers, method, path, body, now=now))
        self.assertFalse(authenticated(SECRET, {}, 'POST', BASE_PATH, now=1000))

    def test_only_new_tag_pushes_notify(self):
        event = dict(created=True, deleted=False, forced=False, ref='refs/tags/release/v1')
        self.assertTrue(new_tag(event))
        for changes in [dict(created=False), dict(deleted=True), dict(forced=True), dict(ref='refs/heads/main')]:
            self.assertFalse(new_tag(event | changes))

    def test_tag_validation_and_repository_boundary(self):
        self.assertEqual(validate_payload(payload() | {'tag': 'release/v1.2.3'}, REPOSITORY)['tag'], 'release/v1.2.3')
        for changes in [{'tag': '../outside'}, {'tag': 'v1\ncommand'}, {'sha': 'HEAD'}, {'run_id': True},
                        {'repository': 'other/repo'}, {'run_number': 0}, {'tag': ''}]:
            with self.assertRaises(ValueError):
                validate_payload(payload() | changes, REPOSITORY)


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / 'jobs.sqlite'
        self.jobs = Jobs(self.path)

    def test_duplicate_and_changed_identity(self):
        self.jobs.submit(payload())
        self.jobs.update(1, status='succeeded', phase='done')
        self.assertEqual(self.jobs.submit(payload())['status'], 'succeeded')
        with self.assertRaises(ValueError):
            self.jobs.submit(payload() | {'sha': 'b' * 40})

    def test_latest_pending_wins_and_delayed_notification_cannot_downgrade(self):
        self.jobs.submit(payload(2))
        self.jobs.submit(payload(4))
        self.assertEqual(self.jobs.get(2)['status'], 'superseded')
        self.assertEqual(self.jobs.submit(payload(3))['status'], 'superseded')
        self.assertEqual(self.jobs.next()['id'], 4)
        self.jobs.update(4, status='running')
        self.jobs.submit(payload(5))
        self.assertEqual(self.jobs.next()['id'], 4)
        self.assertTrue(self.jobs.newer(4))

    def test_failed_attempt_can_be_retried_without_replaying_success(self):
        self.jobs.submit(payload())
        self.jobs.update(1, status='failed', error='build failed')
        self.assertEqual(self.jobs.submit(payload())['status'], 'failed')
        self.assertEqual(self.jobs.submit(payload() | {'attempt': 2})['status'], 'queued')
        self.jobs.update(1, status='succeeded')
        self.assertEqual(self.jobs.submit(payload() | {'attempt': 3})['status'], 'succeeded')

    def test_state_and_pause_survive_reopening(self):
        self.jobs.submit(payload())
        self.jobs.update(1, status='running', phase='starting', details={'release': '/release'})
        self.jobs.block('migration needs recovery')
        reopened = Jobs(self.path)
        self.assertEqual(reopened.next()['details']['release'], '/release')
        self.assertEqual(reopened.blocked(), 'migration needs recovery')
        reopened.clear_block()
        self.assertEqual(self.jobs.blocked(), '')


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.jobs = Jobs(Path(self.temporary.name) / 'jobs.sqlite')
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), handler(self.jobs, SECRET, REPOSITORY))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def request(self, method='POST', path=BASE_PATH, value=None, signed=True):
        body = json.dumps(payload() if value is None else value).encode() if method == 'POST' else b''
        stamp = str(int(time.time()))
        headers = {'Content-Length': str(len(body)), 'X-Deploy-Timestamp': stamp}
        if signed:
            headers['X-Deploy-Signature'] = signature(SECRET, stamp, method, path, body)
        with contextlib.closing(http.client.HTTPConnection(*self.server.server_address, timeout=3)) as connection:
            connection.request(method, path, body, headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())

    def test_http_authentication_and_durable_ack(self):
        self.assertEqual(self.request(signed=False)[0], 401)
        self.assertIsNone(self.jobs.next())
        code, result = self.request()
        self.assertEqual(code, 202)
        self.assertEqual(result['id'], 1)
        self.assertEqual(self.request('GET', BASE_PATH + '/1')[1]['status'], 'queued')
        self.assertEqual(self.request('GET', BASE_PATH + '/999')[0], 404)
        self.assertEqual(self.request(value=payload() | {'repository': 'wrong/repo'})[0], 400)
        self.jobs.block('recover first')
        self.assertEqual(self.request()[0], 503)
        self.assertEqual(self.request('GET', BASE_PATH + '/1')[0], 200)

    def test_ci_client_posts_and_reads_a_real_signed_request(self):
        url = f'http://127.0.0.1:{self.server.server_port}{BASE_PATH}'
        self.assertEqual(notify.request(url, SECRET, 'POST', payload())['status'], 'queued')
        self.jobs.update(1, status='succeeded', phase='done')
        self.assertEqual(notify.request(url + '/1', SECRET, 'GET')['status'], 'succeeded')


class FakeRuntime(Deployer):
    """Use real Git archives/backups/SQLite, replacing only builds and served processes."""
    def __init__(self, config, jobs):
        super().__init__(config, jobs)
        self.active = 'old'
        self.stops = 0
        self.build_fails = self.new_start_fails = self.migrate = False

    def command(self, args, cwd=None, timeout=1800, capture=False):
        if args[0] == 'pnpm':
            if self.build_fails:
                raise RuntimeError('build failed')
            destination = Path(cwd) / 'apps/server/dist'
            destination.mkdir(parents=True, exist_ok=True)
            sha = (Path(cwd) / 'BUILD_REVISION').read_text().strip()
            (destination / 'build-info.json').write_text(json.dumps({'buildId': sha[:12]}))
            return
        return super().command(args, cwd, timeout, capture)

    def stop(self):
        self.stops += 1
        self.active = None

    def start(self):
        build = self.build_id(self.current_release())
        if build != 'old' and self.migrate:
            with sqlite3.connect(Path(self.config['data_dir']) / 'llm-chat.sqlite') as db:
                db.execute('PRAGMA user_version=47')
        self.active = None if build != 'old' and self.new_start_fails else build

    def wait_ready(self, expected, public=False):
        if self.active != expected:
            raise RuntimeError('readiness failed')


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = self.root = Path(self.temporary.name)
        self.repo = root / 'origin'
        self.repo.mkdir()
        self.git('init', '-q')
        self.git('config', 'user.name', 'Deployment tests')
        self.git('config', 'user.email', 'deployment@example.invalid')
        (self.repo / 'BUILD_REVISION').write_text('$Format:%H$\n')
        (self.repo / '.gitattributes').write_text('BUILD_REVISION export-subst\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'test release')
        self.sha = self.git('rev-parse', 'HEAD')
        self.git('tag', '-a', 'v1', '-m', 'annotated release')
        for directory in ['data', 'state/logs', 'backups', 'releases/old/apps/server/dist']:
            (root / directory).mkdir(parents=True)
        self.old = root / 'releases/old'
        (self.old / 'apps/server/dist/build-info.json').write_text('{"buildId":"old"}')
        with sqlite3.connect(root / 'data/llm-chat.sqlite') as db:
            db.execute('PRAGMA user_version=46')
        (root / 'data/user-content').write_text('preserve me')
        lifecycle = root / 'lifecycle.py'
        lifecycle.write_text(f'from pathlib import Path\nRELEASE = Path({str(self.old)!r})\n')
        (root / 'config.json').write_text('{}')
        config = dict(state_dir=str(root / 'state'), lifecycle=str(lifecycle), git_url=str(self.repo),
                      data_dir=str(root / 'data'), app_config=str(root / 'config.json'),
                      releases_dir=str(root / 'releases'), backups_dir=str(root / 'backups'),
                      deploy_lock=str(root / 'deploy.lock'))
        self.jobs = Jobs(root / 'state/jobs.sqlite')
        self.runtime = FakeRuntime(config, self.jobs)
        self.job = self.jobs.submit(payload() | {'sha': self.sha})

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], stderr=subprocess.DEVNULL, text=True).strip()

    def test_success_builds_exact_annotated_tag_and_backs_up_data(self):
        self.runtime.deploy(self.job)
        job = self.jobs.get(1)
        self.assertEqual(job['status'], 'succeeded')
        self.assertEqual(self.runtime.active, self.sha[:12])
        self.assertEqual((Path(job['details']['backup']) / 'data/user-content').read_text(), 'preserve me')
        self.assertEqual(self.runtime.current_release(), Path(job['details']['release']))

    def test_build_failure_does_not_stop_the_old_app(self):
        self.runtime.build_fails = True
        self.runtime.deploy(self.job)
        self.assertEqual(self.jobs.get(1)['status'], 'failed')
        self.assertEqual(self.runtime.stops, 0)
        self.assertEqual(self.runtime.active, 'old')

    def test_changed_tag_is_rejected_before_build_and_shutdown(self):
        (self.repo / 'new').write_text('changed')
        self.git('add', '.')
        self.git('commit', '-qm', 'changed tag')
        self.git('tag', '-f', 'v1')
        self.runtime.deploy(self.job)
        self.assertIn('Tag no longer', self.jobs.get(1)['error'])
        self.assertEqual(self.runtime.stops, 0)

    def test_superseded_build_never_switches(self):
        self.jobs.submit(payload(2) | {'sha': self.sha})
        self.runtime.deploy(self.job)
        self.assertEqual(self.jobs.get(1)['status'], 'superseded')
        self.assertEqual(self.runtime.stops, 0)

    def test_failed_start_rolls_back_program_without_overwriting_data(self):
        self.runtime.new_start_fails = True
        self.runtime.deploy(self.job)
        self.assertEqual(self.jobs.get(1)['status'], 'failed')
        self.assertEqual(self.runtime.active, 'old')
        self.assertEqual(self.runtime.current_release(), self.old)
        self.assertFalse(self.jobs.blocked())
        self.assertEqual((self.root / 'data/user-content').read_text(), 'preserve me')

    def test_migration_failure_preserves_new_database_and_pauses_deployment(self):
        self.runtime.new_start_fails = self.runtime.migrate = True
        self.runtime.deploy(self.job)
        self.assertEqual(self.jobs.get(1)['status'], 'failed')
        self.assertEqual(self.runtime.schema(), 47)
        self.assertIn('schema changed', self.jobs.blocked())
        self.assertIsNone(self.runtime.active)
        backup = Path(self.jobs.get(1)['details']['backup'])
        with sqlite3.connect(backup / 'data/llm-chat.sqlite') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 46)

    def test_recovery_recognizes_live_new_release(self):
        self.runtime.deploy(self.job)
        self.jobs.update(1, status='running', phase='probing')
        reopened = Jobs(self.jobs.path)
        self.runtime.jobs = reopened
        stops = self.runtime.stops
        self.runtime.recover(reopened.get(1))
        self.assertEqual(reopened.get(1)['status'], 'succeeded')
        self.assertEqual(self.runtime.stops, stops)

    def test_recovery_restores_old_release_after_interrupted_switch(self):
        self.runtime.deploy(self.job)
        self.jobs.update(1, status='running', phase='switching')
        self.runtime.active = None
        self.runtime.recover(self.jobs.get(1))
        self.assertEqual(self.jobs.get(1)['status'], 'failed')
        self.assertEqual(self.runtime.active, 'old')
        self.assertEqual(self.runtime.current_release(), self.old)

    def test_recovery_requeues_interrupted_build(self):
        self.jobs.update(1, status='running', phase='building')
        self.runtime.recover(self.jobs.get(1))
        self.assertEqual(self.jobs.get(1)['status'], 'queued')
        self.assertEqual(self.runtime.stops, 0)

    def test_backup_failure_recovers_old_application(self):
        original = self.runtime.command
        def fail_copy(args, *other, **kwargs):
            if args[0] == 'cp':
                raise RuntimeError('backup disk full')
            return original(args, *other, **kwargs)
        with patch.object(self.runtime, 'command', fail_copy):
            self.runtime.deploy(self.job)
        self.assertEqual(self.runtime.active, 'old')
        self.assertFalse(self.jobs.blocked())
        self.assertIn('backup disk full', self.jobs.get(1)['error'])

    def test_worker_waits_for_shared_manual_deployment_lock(self):
        stop = threading.Event()
        started = threading.Event()
        with open(self.runtime.config['deploy_lock'], 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            with patch.object(self.runtime, 'deploy', side_effect=lambda _: (started.set(), stop.set())):
                thread = threading.Thread(target=self.runtime.work, args=(stop,))
                thread.start()
                try:
                    self.assertFalse(started.wait(1.2))
                    self.assertEqual(self.jobs.get(1)['status'], 'queued')
                    fcntl.flock(lock, fcntl.LOCK_UN)
                    self.assertTrue(started.wait(3))
                finally:
                    stop.set()
                    thread.join(5)
                self.assertFalse(thread.is_alive())


if __name__ == '__main__':
    unittest.main()
