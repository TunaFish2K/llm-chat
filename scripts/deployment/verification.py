#!/usr/bin/env python3
"""Reuse the latest main CI result only for the exact tagged commit."""
import json
import os
from pathlib import Path
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def latest_run(runs, repository, sha, current_id):
    eligible = [run for run in runs if
                run.get('head_sha') == sha and run.get('head_branch') == 'main' and
                run.get('event') == 'push' and run.get('id') != current_id and
                run.get('head_repository', {}).get('full_name') == repository]
    return max(eligible, key=lambda run: run['id'], default=None)


def requires_validation(fetch_runs, repository, sha, current_id, timeout=300):
    deadline = time.monotonic() + timeout
    while True:
        run = latest_run(fetch_runs(), repository, sha, current_id)
        if run is None:
            print('No main CI result for this commit; running full validation.', flush=True)
            return True
        if run['status'] == 'completed':
            if run['conclusion'] != 'success':
                raise RuntimeError(f"Main CI run {run['id']} finished with {run['conclusion']}; deployment blocked")
            print(f"Reusing successful main CI run {run['id']} for {sha}.", flush=True)
            return False
        if time.monotonic() >= deadline:
            raise RuntimeError(f"Main CI run {run['id']} is still running; wait for it before publishing the tag")
        print(f"Waiting for main CI run {run['id']} ({run['status']}).", flush=True)
        time.sleep(min(10, max(0, deadline - time.monotonic())))


def main():
    required = True
    if os.environ['GITHUB_EVENT_NAME'] == 'push' and os.environ['GITHUB_REF'].startswith('refs/tags/'):
        repository = os.environ['GITHUB_REPOSITORY']
        sha = os.environ['GITHUB_SHA']
        query = urlencode({'branch': 'main', 'event': 'push', 'head_sha': sha, 'per_page': 100})
        url = f'https://api.github.com/repos/{repository}/actions/workflows/ci.yml/runs?{query}'

        def fetch_runs():
            request = Request(url, headers={
                'Authorization': 'Bearer ' + os.environ['GITHUB_TOKEN'],
                'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'
            })
            with urlopen(request, timeout=30) as response:
                return json.load(response)['workflow_runs']

        required = requires_validation(fetch_runs, repository, sha, int(os.environ['GITHUB_RUN_ID']))
    with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:
        output.write(f'validation_required={str(required).lower()}\n')


if __name__ == '__main__':
    main()
