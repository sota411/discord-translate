#include "moonshine-streaming-model.h"
#include <algorithm>
#include <cassert>
#include <chrono>
#include <cmath>
#include <iostream>
#include <stdexcept>

int main(int argc, char** argv) {
  if (argc != 2) return 2;
  MoonshineStreamingModel model;
  const std::string directory = argv[1];
  if (model.load(directory.c_str(), (directory + "/tokenizer.bin").c_str(), 4)) return 3;
  std::vector<float> audio(1280 * 30);
  for (size_t i = 0; i < audio.size(); ++i) {
    audio[i] = 0.12f * std::sin(i * 0.08639379797371932) +
               0.04f * std::sin(i * 0.19202985177319);
  }
  MoonshineStreamingState reference;
  for (const size_t chunk_size : {1280, 2560, 5120, 10240}) {
    MoonshineStreamingState state;
    state.reset(model.config);
    auto start = std::chrono::steady_clock::now();
    int calls = 0;
    for (size_t offset = 0; offset < audio.size();) {
      const size_t count = audio.size() - offset >= chunk_size ? chunk_size : 1280;
      if (model.process_audio_chunk(&state, audio.data() + offset, count, nullptr)) return 4;
      offset += count;
      ++calls;
    }
    auto elapsed = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
    if (chunk_size == 1280) reference = state;
    double difference = 0;
    auto compare = [&](const std::vector<float>& left, const std::vector<float>& right) {
      if (left.size() != right.size()) throw std::runtime_error("frontend shape mismatch");
      for (size_t i = 0; i < left.size(); ++i) {
        if (!std::isfinite(left[i]) || !std::isfinite(right[i])) throw std::runtime_error("non-finite frontend output");
        difference = std::max(difference, std::abs(double(left[i]) - right[i]));
      }
    };
    compare(state.accumulated_features, reference.accumulated_features);
    compare(state.sample_buffer, reference.sample_buffer);
    compare(state.conv1_buffer, reference.conv1_buffer);
    compare(state.conv2_buffer, reference.conv2_buffer);
    assert(state.sample_len == reference.sample_len);
    assert(state.frame_count == reference.frame_count);
    assert(state.accumulated_feature_count == reference.accumulated_feature_count);
    std::cout << "{\"chunk_size\":" << chunk_size << ",\"calls\":" << calls
              << ",\"elapsed_ms\":" << elapsed << ",\"max_abs_diff\":" << difference << "}" << std::endl;
    if (difference > 0.0001) return 5;
  }
}
