import sys
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from verification import requires_validation

REPO = 'TunaFish2K/llm-chat'
SHA = 'a' * 40


def run(**changes):
    return dict(id=10, head_sha=SHA, head_branch='main', event='push',
                head_repository={'full_name': REPO}, status='completed', conclusion='success') | changes


class VerificationTests(unittest.TestCase):
    def check(self, runs, **options):
        return requires_validation(lambda: runs, REPO, SHA, 99, **options)

    def test_reuses_success_only_for_exact_commit_and_repository(self):
        self.assertFalse(self.check([run()]))
        for changes in [dict(head_sha='b' * 40), dict(head_branch='feature'), dict(event='pull_request'),
                        dict(head_repository={'full_name': 'other/repo'}), dict(id=99)]:
            self.assertTrue(self.check([run(**changes)]))
        self.assertTrue(self.check([]))

    def test_failed_or_cancelled_latest_run_blocks_older_success(self):
        for conclusion in ['failure', 'cancelled', 'timed_out', 'skipped', None]:
            with self.assertRaises(RuntimeError):
                self.check([run(), run(id=11, conclusion=conclusion)])

    def test_waits_for_pending_run_and_reuses_its_result(self):
        responses = iter([[run(status='in_progress', conclusion=None)], [run()]])
        with patch('verification.time.sleep'):
            self.assertFalse(requires_validation(lambda: next(responses), REPO, SHA, 99))

    def test_waits_long_enough_for_a_full_main_run(self):
        responses = iter([[run(status='in_progress', conclusion=None)]] * 40 + [[run()]])
        with patch('verification.time.sleep'), patch('verification.time.monotonic', side_effect=range(0, 2000, 20)):
            self.assertFalse(requires_validation(lambda: next(responses), REPO, SHA, 99))

    def test_pending_run_cannot_authorize_deployment(self):
        with self.assertRaises(RuntimeError):
            self.check([run(status='in_progress', conclusion=None)], timeout=0)


if __name__ == '__main__':
    unittest.main()
