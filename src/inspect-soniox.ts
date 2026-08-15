import { SonioxNodeClient } from "@soniox/node";

import {
  getSonioxRegionEndpoints,
  type SonioxRegion,
} from "./config.js";

const apiKey = process.env.SONIOX_API_KEY;
const rawRegion = process.env.SONIOX_REGION;
if (!apiKey) throw new Error("SONIOX_API_KEYを設定してください");
if (rawRegion !== "us" && rawRegion !== "eu" && rawRegion !== "jp") {
  throw new Error("SONIOX_REGIONはus、eu、jpのいずれかを設定してください");
}
const region: SonioxRegion = rawRegion;
const endpoints = getSonioxRegionEndpoints(region);
const client = new SonioxNodeClient({
  api_key: apiKey,
  region,
  base_url: endpoints.restBaseUrl,
  tts_api_url: endpoints.ttsRestBaseUrl,
  realtime: {
    ws_base_url: endpoints.sttWebSocketUrl,
    tts_ws_url: endpoints.ttsWebSocketUrl,
  },
});
const [sttModels, ttsModels] = await Promise.all([
  client.models.list(),
  client.tts.listModels(),
]);

console.log(JSON.stringify({
  region,
  stt_models: sttModels.map((model) => ({
    id: model.id,
    name: model.name,
  })),
  tts_models: ttsModels.map((model) => ({
    id: model.id,
    name: model.name,
    languages: model.languages.map((language) => language.code),
    voices: model.voices.map((voice) => ({
      id: voice.id,
      description: voice.description,
      gender: voice.gender,
    })),
  })),
}, null, 2));
