# Dolphin CPU worker

Uses the official sherpa-onnx 1.13.8 C API and Dolphin small CTC multilingual int8
model (2025-04-02). Both Japanese and Korean are supported. The application sends
48 kHz mono s16le PCM through stdin; no network listener or audio file is created.

The input frame is a four-byte little-endian byte count followed by PCM. The
limit is 288,000 bytes (3 seconds). The process emits `READY\n` after loading the
model, then one UTF-8 line per request. Empty lines mean no recognized text.
Malformed, truncated, oversized input or an invalid native result exits nonzero.

`fetch.py` verifies the official archive, header and model checksums. Runtime
and model files stay in the Docker image, outside Git. The model uses about
354 MiB RSS in the Pi screening; this excludes the Bot and other processes.

Upstream sources:

- [Dolphin](https://github.com/DataoceanAI/Dolphin/tree/78ea615194777f91a3970ff010b5d678d0bbf5f0)
- [Supported languages](https://github.com/DataoceanAI/Dolphin/blob/78ea615194777f91a3970ff010b5d678d0bbf5f0/languages.md)
- [sherpa-onnx C API example](https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/c-api-examples/dolphin-ctc-c-api.c)
- [Official model conversion](https://k2-fsa.github.io/sherpa/onnx/Dolphin/pretrained.html)

Licenses for Dolphin, sherpa-onnx and ONNX Runtime are included in `licenses/`.

The final image can verify startup, warm-up and a silent PCM round trip without
credentials or a network connection:

```sh
docker run --rm --network none --entrypoint node IMAGE scripts/smoke-runtime.mjs --dolphin
```
