#include <algorithm>
#include <cstdint>
#include <iostream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#ifndef WORKER_CONTRACT_ONLY
#include "c-api.h"
#endif

void require(bool condition, const char *message) {
  if (!condition) throw std::runtime_error(message);
}

uint32_t byte_count(const unsigned char *header) {
  const uint32_t bytes = uint32_t(header[0]) | (uint32_t(header[1]) << 8) |
    (uint32_t(header[2]) << 16) | (uint32_t(header[3]) << 24);
  require(bytes > 0 && bytes <= 288000 && bytes % 2 == 0, "Invalid PCM length");
  return bytes;
}

float sample(unsigned char lo, unsigned char hi) {
  const int value = int(lo) | (int(hi) << 8);
  return float(value >= 32768 ? value - 65536 : value) / 32768.0f;
}

std::vector<unsigned char> read_chunk(std::istream &input, uint32_t remaining) {
  unsigned char header[4];
  input.read(reinterpret_cast<char *>(header), 4);
  require(bool(input), "Incomplete chunk header");
  if (!(header[0] | header[1] | header[2] | header[3])) return {};
  const auto bytes = byte_count(header);
  require(bytes <= remaining, "Chunk exceeds remaining PCM");
  std::vector<unsigned char> pcm(bytes);
  input.read(reinterpret_cast<char *>(pcm.data()), bytes);
  require(bool(input), "Incomplete chunk input");
  return pcm;
}

std::string reply_text(const char *flat, const char *const *tokens, int count) {
  require(flat && count >= 0 && count <= 40000 && (count == 0 || tokens), "Invalid token result");
  std::string text;
  for (int i = 0; i < count; ++i) {
    require(tokens[i], "Missing token");
    text += tokens[i];
    require(text.size() <= 40000, "Reply exceeds limit");
  }
  require(text.find('\n') == std::string::npos && text.find('\r') == std::string::npos,
          "Reply contains line break");
  std::string compact = text;
  compact.erase(std::remove(compact.begin(), compact.end(), ' '), compact.end());
  std::string normalized = flat;
  normalized.erase(std::remove(normalized.begin(), normalized.end(), ' '), normalized.end());
  require(compact == normalized, "Token text mismatch");
  return compact.empty() ? std::string{} : text;
}

void contract() {
  const unsigned char valid[] = {0, 0x84, 3, 0};
  require(byte_count(valid) == 230400, "Header contract failed");
  for (const std::vector<unsigned char> &invalid : {
      std::vector<unsigned char>{0,0,0,0}, {1,0,0,0}, {1,0x65,4,0}}) {
    bool rejected = false;
    try { byte_count(invalid.data()); } catch (const std::runtime_error &) { rejected = true; }
    require(rejected, "Invalid length accepted");
  }
  require(sample(0, 128) == -1 && sample(255,127) == 32767.0f/32768.0f,
          "PCM conversion contract failed");
  std::istringstream framed(std::string("\x02\0\0\0ab\0\0\0\0next", 14));
  require(read_chunk(framed, 4) == std::vector<unsigned char>({'a', 'b'}), "Chunk changed PCM");
  require(read_chunk(framed, 2).empty() && framed.peek() == 'n', "Cancel consumed next request");
  for (const std::string &invalid : {std::string("\0\0", 2), std::string("\x01\0\0\0a", 5),
       std::string("\x06\0\0\0abcdef", 10), std::string("\x04\0\0\0ab", 6)}) {
    std::istringstream frame(invalid);
    bool rejected = false;
    try { read_chunk(frame, 4); } catch (const std::runtime_error &) { rejected = true; }
    require(rejected, "Invalid chunk accepted");
  }
  const char *words[] = {"가", " ", "나"};
  require(reply_text("가나", words, 3) == "가 나", "Reply lost word boundaries");
  require(reply_text("", nullptr, 0).empty(), "Empty reply contract failed");
  const char *silence[] = {" "};
  require(reply_text("", silence, 1).empty(), "Silence must have an empty reply");
  const char *trailing[] = {"가", " ", "나", " "};
  require(reply_text("가나 ", trailing, 4) == "가 나 ", "Native trailing space rejected");
  const char *latin[] = {"a", " ", "b"};
  require(reply_text("a b", latin, 3) == "a b", "Native Latin space rejected");
  bool mismatch_rejected = false;
  try { reply_text("wrong", words, 3); } catch (const std::runtime_error &) { mismatch_rejected = true; }
  require(mismatch_rejected, "Mismatched token text accepted");
  for (const std::string &invalid : {std::string("bad\nline"), std::string(40001, 'x')}) {
    const char *tokens[] = {invalid.c_str()};
    bool rejected = false;
    try { reply_text(invalid.c_str(), tokens, 1); } catch (const std::runtime_error &) { rejected = true; }
    require(rejected, "Invalid reply accepted");
  }
  std::cout << "PCM_LENGTH_AND_REPLY_CONTRACT_PASS\n";
}

int main(int argc, char **argv) {
  try {
#ifdef WORKER_CONTRACT_ONLY
    (void)argc; (void)argv;
    contract();
    return 0;
#else
    if (argc == 2 && std::string(argv[1]) == "--check") { contract(); return 0; }
    require(argc == 5, "Expected encoder, decoder, joiner and tokens");
    SherpaOnnxOnlineRecognizerConfig config{};
    config.feat_config.sample_rate = 16000;
    config.feat_config.feature_dim = 80;
    config.model_config.transducer.encoder = argv[1];
    config.model_config.transducer.decoder = argv[2];
    config.model_config.transducer.joiner = argv[3];
    config.model_config.tokens = argv[4];
    config.model_config.num_threads = 2;
    config.model_config.provider = "cpu";
    config.decoding_method = "modified_beam_search";
    config.max_active_paths = 8;
    std::unique_ptr<const SherpaOnnxOnlineRecognizer, decltype(&SherpaOnnxDestroyOnlineRecognizer)>
      recognizer(SherpaOnnxCreateOnlineRecognizer(&config), SherpaOnnxDestroyOnlineRecognizer);
    require(bool(recognizer), "Recognizer creation failed");
    const std::vector<float> right(61440, 0);
    std::cout << "READY\n" << std::flush;
    while (true) {
      unsigned char header[4];
      std::cin.read(reinterpret_cast<char *>(header), 4);
      if (std::cin.eof() && std::cin.gcount() == 0) break;
      require(bool(std::cin), "Incomplete PCM header");
      const uint32_t bytes = byte_count(header);
      std::unique_ptr<const SherpaOnnxOnlineStream, decltype(&SherpaOnnxDestroyOnlineStream)>
        stream(SherpaOnnxCreateOnlineStream(recognizer.get()), SherpaOnnxDestroyOnlineStream);
      require(bool(stream), "Stream creation failed");
      uint32_t remaining = bytes;
      while (remaining) {
        const auto pcm = read_chunk(std::cin, remaining);
        if (pcm.empty()) break;
        remaining -= pcm.size();
        std::vector<float> audio(pcm.size() / 2);
        for (uint32_t i = 0; i < pcm.size(); i += 2) audio[i / 2] = sample(pcm[i], pcm[i + 1]);
        SherpaOnnxOnlineStreamAcceptWaveform(stream.get(), 48000, audio.data(), audio.size());
        while (SherpaOnnxIsOnlineStreamReady(recognizer.get(), stream.get())) {
          SherpaOnnxDecodeOnlineStream(recognizer.get(), stream.get());
        }
      }
      if (remaining) {
        std::cout << '\n' << std::flush;
        require(bool(std::cout), "Cancel acknowledgement failed");
        continue;
      }
      SherpaOnnxOnlineStreamAcceptWaveform(stream.get(), 48000, right.data(), right.size());
      SherpaOnnxOnlineStreamInputFinished(stream.get());
      while (SherpaOnnxIsOnlineStreamReady(recognizer.get(), stream.get())) {
        SherpaOnnxDecodeOnlineStream(recognizer.get(), stream.get());
      }
      std::unique_ptr<const SherpaOnnxOnlineRecognizerResult, decltype(&SherpaOnnxDestroyOnlineRecognizerResult)>
        result(SherpaOnnxGetOnlineStreamResult(recognizer.get(), stream.get()), SherpaOnnxDestroyOnlineRecognizerResult);
      require(result && result->text, "Missing recognition result");
      const auto text = reply_text(result->text, result->tokens_arr, result->count);
      std::cout << text << '\n' << std::flush;
      require(bool(std::cout), "Reply write failed");
    }
    return 0;
#endif
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
