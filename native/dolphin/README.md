# Korean prefix recognition worker

This candidate uses the Korean Zipformer transducer published by kangkyu at
revision `f0e73b1653c3ea75898c6d949dd71c690c9121da`, with sherpa-onnx 1.13.8.
The model is int8, chunk 32, modified beam search with 8 active paths and 2 CPU
threads. Japanese refinement continues to use the preceding speaker's audio
through Soniox; this local model receives Korean prefixes only.

The existing `DolphinWorker` client name, `/opt/dolphin` installation path and
`--dolphin` smoke option remain compatible. The worker now takes four model
arguments: encoder, decoder, joiner and tokens. `fetch.py` pins the runtime,
C API header and all four model files by SHA-256. Weights are outside Git.

A request starts with a four-byte little-endian total byte count, limited to
288,000 bytes (3 seconds). Each chunk has its own four-byte byte count followed
by 48 kHz mono s16le PCM. Chunk lengths must be even and fit the remaining total.
The client always sends 1,920-byte (20 ms) chunks, followed by a shorter final
chunk if needed. Partial chunks stay buffered until they are complete or all
expected PCM has arrived. This keeps resampler rounding and recognition output
independent of how callers partition the same audio.
The worker emits `READY` after model loading, then one UTF-8 line per request.
It creates a fresh stream and decodes chunks as they arrive. Once the expected
PCM is complete, it appends 1.28 seconds of synthetic silence to finish decoding.
A zero-length chunk before completion cancels the stream and returns an empty
line without padding. The client waits for that acknowledgement before reuse.
The native worker and client must be updated together for this framed protocol.
Token spacing is preserved; a whitespace-only result becomes an empty reply.
Malformed lengths, truncated frames and invalid results exit nonzero. There is
no network listener, credential access or audio recording in the worker.

Run the pure protocol/format regression without a recognizer or model:

```sh
g++ -std=c++17 -O2 -Wall -Wextra -Werror -DWORKER_CONTRACT_ONLY native/dolphin/worker.cpp -o /tmp/korean-worker-contract
/tmp/korean-worker-contract
```

On the Raspberry Pi, the image can verify loading, warm-up and a silent round
trip without credentials or network access:

```sh
docker run --rm --network none --entrypoint node IMAGE scripts/smoke-runtime.mjs --dolphin
```

Startup checks do not establish recognition quality or the 2.39-second complete
pipeline deadline. Independent same-PCM comparisons in both languages, current
candidate confirmation and the remaining validation limits are recorded in the
[evaluation report](../../docs/stt-optimization/independent-evaluation-20260920.md).

Sources and licenses:

- [Pinned model card, architecture and decoding example](https://huggingface.co/kangkyu/icefall-asr-ko-streaming-zipformer-174m/blob/f0e73b1653c3ea75898c6d949dd71c690c9121da/README.md)
- [Pinned sherpa-onnx C API](https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/sherpa-onnx/c-api/c-api.h)
- The model card declares Apache 2.0. `licenses/Korean-Zipformer.txt` contains
  that license; sherpa-onnx and ONNX Runtime notices are retained alongside it.
