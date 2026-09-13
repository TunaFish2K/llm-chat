#!/usr/bin/env python3
"""Refresh the bundled Alpine file lock. Uses apk only to resolve dependencies.
Run explicitly when updating Alpine; application downloads never invoke this script.
"""
import concurrent.futures
import hashlib
import json
import pathlib
import platform
import subprocess
import urllib.request
import tarfile

VERSION = '3.24.1'
BRANCH = 'v3.24'
CACHE = pathlib.Path('/tmp/llm-chat-alpine-catalog')
CACHE.mkdir(exist_ok=True)
ROOT = pathlib.Path(__file__).resolve().parents[1]
ORIGIN = 'https://dl-cdn.alpinelinux.org/alpine/'
MIRRORS = {'tuna': 'https://mirrors.tuna.tsinghua.edu.cn/alpine/', 'ustc': 'https://mirrors.ustc.edu.cn/alpine/'}
PACKAGES = {
    'runtime': ['nodejs', 'sudo', 'shadow', 'ca-certificates'],
    'tools': ['npm', 'python3', 'py3-pip', 'py3-virtualenv', 'git', 'curl', 'ripgrep', 'bash', 'util-linux', 'procps-ng']
}

def artifact(url):
    path = CACHE / hashlib.sha256(url.encode()).hexdigest()
    if not path.exists():
        request = urllib.request.Request(url.replace(ORIGIN, MIRRORS['ustc']))
        for attempt in range(3):
            try:
                with urllib.request.urlopen(request, timeout=60) as response:
                    data = response.read()
                path.write_bytes(data)
                break
            except Exception:
                if attempt == 2: raise
    data = path.read_bytes()
    return {'name': url.rsplit('/', 1)[1], 'url': url, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
            'mirrors': {node: url.replace(ORIGIN, mirror) for node, mirror in MIRRORS.items()}}

resources = [dict(id='alpine', name='Alpine', description='Minimal Alpine root filesystem', version=VERSION,
                  dependencies=[], variants=[])]
for name in PACKAGES:
    resources.append(dict(id=name, name='Runtime components' if name == 'runtime' else 'Common tools',
                         description='', version=VERSION + '-1', dependencies=['alpine'] if name == 'runtime' else ['runtime'], variants=[]))
native_arch = platform.machine()
if native_arch not in ('x86_64', 'aarch64'): raise RuntimeError('Unsupported host architecture')
architectures = sorted([('x86_64', 'linux/amd64'), ('aarch64', 'linux/arm64')], key=lambda pair: pair[0] != native_arch)
for arch, target_platform in architectures:
    base = artifact(f'{ORIGIN}{BRANCH}/releases/{arch}/alpine-minirootfs-{VERSION}-{arch}.tar.gz')
    expected = urllib.request.urlopen(base['url'] + '.sha256', timeout=30).read().decode().split()[0]
    if expected != base['sha256']: raise RuntimeError('Alpine rootfs checksum mismatch')
    if arch == native_arch:
        subprocess.run(['docker', 'import', str(CACHE / hashlib.sha256(base['url'].encode()).hexdigest()), 'llm-chat-catalog-helper:3.24.1'], check=True, stdout=subprocess.DEVNULL)
    keys = CACHE / ('keys-' + arch)
    keys.mkdir(exist_ok=True)
    with tarfile.open(CACHE / hashlib.sha256(base['url'].encode()).hexdigest()) as archive:
        for entry in archive.getmembers():
            if entry.isfile() and '/etc/apk/keys/' in '/' + entry.name and entry.name.endswith('.pub'):
                (keys / pathlib.Path(entry.name).name).write_bytes(archive.extractfile(entry).read())
    resources[0]['variants'].append(dict(platform=target_platform, distro='alpine-3.24', files=[base], install='true', verify='true'))
    for index, (name, packages) in enumerate(PACKAGES.items(), 1):
        command = ['docker', 'run', '--rm', '--network', 'host', '--mount', f'type=bind,src={keys},dst=/etc/apk/keys,readonly', 'llm-chat-catalog-helper:3.24.1',
                   '/bin/sh', '-ec', 'printf "%s\\n" "$1" "$2" > /etc/apk/repositories; shift 2; apk --arch "$1" update >/dev/null; apkarch="$1"; shift; apk --arch "$apkarch" fetch --recursive --url --simulate "$@"']
        # Package arguments never enter shell source.
        command += ['resolve', MIRRORS['ustc'] + BRANCH + '/main', MIRRORS['ustc'] + BRANCH + '/community', arch, *packages]
        output = subprocess.check_output(command, text=True)
        urls = sorted({line.strip().replace(MIRRORS['ustc'], ORIGIN) for line in output.splitlines() if line.startswith('https://') and line.endswith('.apk')})
        if not urls: raise RuntimeError('apk did not resolve download URLs: ' + output)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            files = list(pool.map(artifact, urls))
        if name == 'tools':
            shared = {f['sha256'] for variant in resources[1]['variants'] if variant['platform'] == target_platform for f in variant['files']}
            files = [f for f in files if f['sha256'] not in shared]
        verify = 'node --version; sudo --version >/dev/null; command -v useradd' if name == 'runtime' else 'npm --version; python3 -m venv /tmp/verify-venv; rm -rf /tmp/verify-venv; git --version; curl --version; rg --version; bash --version'
        resources[index]['variants'].append(dict(platform=target_platform, distro='alpine-3.24', files=files,
            install='apk --no-network add /resources/*.apk', verify=verify))
        print(target_platform, name, len(files), sum(f['size'] for f in files), flush=True)
(ROOT / 'apps/server/src/container-resource-lock.json').write_text(json.dumps(resources, indent=2) + '\n')
