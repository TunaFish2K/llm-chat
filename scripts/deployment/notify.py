#!/usr/bin/env python3
"""Notify prv1 after a new tag's quality job succeeds and report its result."""
import json
import os
from pathlib import Path
import subprocess
import time
from urllib.parse import urlsplit

from protocol import BASE_PATH, TERMINAL, signature


def new_tag(event):
    return (event.get('created') is True and event.get('deleted') is False
            and event.get('forced') is not True and event.get('ref', '').startswith('refs/tags/'))


def request(url, secret, method, payload=None):
    body = json.dumps(payload, separators=(',', ':')).encode() if payload is not None else b''
    path = urlsplit(url).path
    for attempt in range(6):
        timestamp = str(int(time.time()))
        args = ['curl', '-4', '--silent', '--show-error', '--fail-with-body', '--connect-timeout', '10',
                '--max-time', '30', '--request', method, '--header', 'Content-Type: application/json',
                '--header', 'X-Deploy-Timestamp: ' + timestamp,
                '--header', 'X-Deploy-Signature: ' + signature(secret, timestamp, method, path, body), url]
        if body:
            args += ['--data-binary', '@-']
        result = subprocess.run(args, input=body, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=40)
        if result.returncode == 0:
            return json.loads(result.stdout)
        if attempt == 5:
            raise RuntimeError('Deployment endpoint unavailable or rejected the request; retry this job after checking server logs')
        time.sleep(min(2**attempt, 15))


def main():
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    if os.environ.get('GITHUB_EVENT_NAME') != 'push' or not new_tag(event):
        raise SystemExit('Only a newly pushed tag can request deployment')
    url = os.environ['LLM_CHAT_DEPLOY_URL'].rstrip('/')
    if urlsplit(url).scheme != 'https' or urlsplit(url).path != BASE_PATH or urlsplit(url).query:
        raise SystemExit('Invalid deployment URL')
    secret = os.environ['LLM_CHAT_DEPLOY_SECRET'].encode()
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    payload = {'repository': os.environ['GITHUB_REPOSITORY'], 'tag': event['ref'][len('refs/tags/'):],
               'sha': sha, 'run_id': int(os.environ['GITHUB_RUN_ID']),
               'run_number': int(os.environ['GITHUB_RUN_NUMBER']), 'attempt': int(os.environ['GITHUB_RUN_ATTEMPT'])}
    result = request(url, secret, 'POST', payload)
    deadline = time.monotonic() + 2400
    previous = None
    while True:
        label = result['status'] + '/' + result['phase']
        if label != previous:
            print(f"Deployment {result['id']}: {label}", flush=True)
            previous = label
        if result['status'] in TERMINAL:
            summary = f"Deployment `{payload['tag']}` (`{sha[:12]}`): **{result['status']}**\n"
            if os.environ.get('GITHUB_STEP_SUMMARY'):
                with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as stream:
                    stream.write(summary)
            if result['status'] == 'failed':
                raise SystemExit(result['error'])
            return
        if time.monotonic() >= deadline:
            raise SystemExit('Timed out waiting for deployment; the durable server task continues. Re-run this job to reconnect.')
        time.sleep(5)
        result = request(url + '/' + str(payload['run_id']), secret, 'GET')


if __name__ == '__main__':
    main()
