"""Wire authentication shared by the CI notifier and the deployment receiver."""
import hashlib
import hmac
import time

BASE_PATH = '/hooks/llm-chat'
TERMINAL = {'succeeded', 'failed', 'superseded'}


def signature(secret, timestamp, method, path, body=b''):
    message = f'{timestamp}\n{method}\n{path}\n'.encode() + body
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


def authenticated(secret, headers, method, path, body=b'', now=None):
    timestamp = headers.get('X-Deploy-Timestamp', '')
    supplied = headers.get('X-Deploy-Signature', '')
    try:
        if abs((time.time() if now is None else now) - int(timestamp)) > 300:
            return False
    except ValueError:
        return False
    return hmac.compare_digest(signature(secret, timestamp, method, path, body), supplied)
