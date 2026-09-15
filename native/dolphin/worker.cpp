#include <cstdint>
#include <iostream>
#include <string>
#include <vector>
#include "c-api.h"

// A single local pipe carries bounded 48 kHz mono s16le requests and UTF-8 replies.
// No listener, recording, or credentials are needed by the native process.
int main(int argc, char **argv) {
  if (argc != 3) return 2;
  SherpaOnnxOfflineRecognizerConfig config{};
  config.model_config.dolphin.model = argv[1];
  config.model_config.tokens = argv[2];
  config.model_config.num_threads = 4;
  config.model_config.provider = "cpu";
  config.decoding_method = "greedy_search";
  const auto *recognizer = SherpaOnnxCreateOfflineRecognizer(&config);
  if (!recognizer) return 3;
  std::cout << "READY\n" << std::flush;
  while (true) {
    unsigned char header[4];
    std::cin.read(reinterpret_cast<char *>(header), 4);
    if (std::cin.eof() && std::cin.gcount() == 0) break;
    if (!std::cin) return 4;
    const uint32_t bytes = uint32_t(header[0]) | (uint32_t(header[1]) << 8) |
                           (uint32_t(header[2]) << 16) | (uint32_t(header[3]) << 24);
    if (bytes == 0 || bytes > 288000 || bytes % 2) return 5;
    std::vector<unsigned char> pcm(bytes);
    std::cin.read(reinterpret_cast<char *>(pcm.data()), bytes);
    if (!std::cin) return 6;
    std::vector<float> samples(bytes / 2);
    for (uint32_t i = 0; i < bytes; i += 2) {
      const int value = int(pcm[i]) | (int(pcm[i + 1]) << 8);
      samples[i / 2] = float(value >= 32768 ? value - 65536 : value) / 32768.0f;
    }
    const auto *stream = SherpaOnnxCreateOfflineStream(recognizer);
    if (!stream) return 7;
    SherpaOnnxAcceptWaveformOffline(stream, 48000, samples.data(), samples.size());
    SherpaOnnxDecodeOfflineStream(recognizer, stream);
    const auto *result = SherpaOnnxGetOfflineStreamResult(stream);
    if (!result || !result->text) return 8;
    const std::string text(result->text);
    if (text.size() > 40000 || text.find('\n') != std::string::npos ||
        text.find('\r') != std::string::npos) return 9;
    std::cout << text << '\n' << std::flush;
    SherpaOnnxDestroyOfflineRecognizerResult(result);
    SherpaOnnxDestroyOfflineStream(stream);
  }
  SherpaOnnxDestroyOfflineRecognizer(recognizer);
  return 0;
}
