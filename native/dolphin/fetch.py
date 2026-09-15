"""Download pinned official CPU runtime/model files for the Docker build."""
import hashlib
from pathlib import Path
import platform
import shutil
import sys
import tarfile
import tempfile
import urllib.request

version = '1.13.8'
architectures = {
    'aarch64': ('linux-aarch64-shared-cpu', '4e3734f82bc1379fd91f219f5869c7e9d03b7a4f7561907d8abca4849c51a789'),
    'x86_64': ('linux-x64-shared', 'c0bdb7907d3a74bba1d55d22bf4d9fa75586cf1530614ebe88a27b9118e015c4'),
}
architecture, runtime_hash = architectures[platform.machine()]
output = Path(sys.argv[1])
output.mkdir(parents=True, exist_ok=True)


def fetch(url, destination, expected):
    digest = hashlib.sha256()
    with urllib.request.urlopen(url, timeout=120) as response, destination.open('wb') as handle:
        for chunk in iter(lambda: response.read(1024 * 1024), b''):
            handle.write(chunk)
            digest.update(chunk)
    if digest.hexdigest() != expected:
        raise RuntimeError('Asset checksum mismatch: ' + destination.name)


with tempfile.TemporaryDirectory() as temporary:
    archive = Path(temporary) / 'runtime.tar.bz2'
    fetch(f'https://github.com/k2-fsa/sherpa-onnx/releases/download/v{version}/sherpa-onnx-v{version}-{architecture}.tar.bz2', archive, runtime_hash)
    library = output / 'lib'
    library.mkdir(exist_ok=True)
    with tarfile.open(archive) as bundle:
        for entry in bundle.getmembers():
            path = Path(entry.name)
            if path.parent.name != 'lib' or not path.name.startswith('lib'):
                continue
            destination = library / path.name
            if entry.isfile():
                with bundle.extractfile(entry) as source, destination.open('wb') as target:
                    shutil.copyfileobj(source, target)
            elif entry.issym():
                if Path(entry.linkname).name != entry.linkname:
                    raise RuntimeError('Unexpected runtime symlink')
                destination.symlink_to(entry.linkname)
            else:
                raise RuntimeError('Unexpected runtime archive member')
    archive = Path(temporary) / 'model.tar.bz2'
    fetch('https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-dolphin-small-ctc-multi-lang-int8-2025-04-02.tar.bz2', archive, '7346b00ffe42396fff5c96d11892f0d4d72ac11418d47c5a8ada2b0f6ac8d27b')
    expected = {'model.int8.onnx': 'c1afcb9265de0ebd853eb8f570b371f399a6f9b2b9af9a3cb17c2e509171e697',
                'tokens.txt': 'c3788261a51df1899ea4b210b552cd42139204de72c0ad60f6cebb199078872e'}
    with tarfile.open(archive) as bundle:
        for name, digest in expected.items():
            entry = bundle.getmember('sherpa-onnx-dolphin-small-ctc-multi-lang-int8-2025-04-02/' + name)
            if not entry.isfile():
                raise RuntimeError('Unexpected model archive member')
            with bundle.extractfile(entry) as source, (output / name).open('wb') as target:
                shutil.copyfileobj(source, target)
            if hashlib.sha256((output / name).read_bytes()).hexdigest() != digest:
                raise RuntimeError('Model checksum mismatch')
fetch(f'https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v{version}/sherpa-onnx/c-api/c-api.h', output / 'c-api.h',
      '2a1b95084be8fd1deb3228fcad2fd3f7f0258b64582f7402281ec174c7b7f4ce')
