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
    model = 'https://huggingface.co/kangkyu/icefall-asr-ko-streaming-zipformer-174m/resolve/f0e73b1653c3ea75898c6d949dd71c690c9121da'
    expected = {
        'encoder-epoch-99-avg-1-chunk-32-left-128.int8.onnx': 'd07cbf5198c8c6d41108cc9c9e057b0a3591846867b6a4d2e283add3bbb84413',
        'decoder-epoch-99-avg-1-chunk-32-left-128.int8.onnx': 'f5dfa6c8609b29da86c739d4904889475c33b62e28e70c619952a0ee6c31416f',
        'joiner-epoch-99-avg-1-chunk-32-left-128.int8.onnx': '64efd9aeb71fb2278c713b3d5eb5ec45edf6b2ccd8716d3709044f17723c13fd',
        'tokens.txt': '435dfb9e0a2b6a79124f1a4d8f0f33a951b25384726e2e0d854f081533e6ec9d',
    }
    for name, digest in expected.items():
        fetch(f'{model}/{name}', output / name, digest)
fetch(f'https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v{version}/sherpa-onnx/c-api/c-api.h', output / 'c-api.h',
      '2a1b95084be8fd1deb3228fcad2fd3f7f0258b64582f7402281ec174c7b7f4ce')
