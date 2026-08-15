import { once } from "node:events";

import {
  Client,
  Events,
  GatewayIntentBits,
} from "discord.js";

import { TranslationCommandService } from "./commands/translation-command-service.js";
import { loadConfig } from "./config.js";
import { loadTranslationTerms } from "./config/translation-terms.js";
import { DiscordBotController } from "./discord/bot-controller.js";
import { DiscordTranslationDriver } from "./discord/translation-driver.js";
import { createSafeLogger, type SafeLogger } from "./observability/logger.js";
import { SessionManager } from "./session/session-manager.js";
import {
  SonioxCapacityGate,
  SonioxSttFactory,
  SonioxUsageReconciler,
  createSonioxClient,
  verifySonioxConfiguration,
} from "./soniox/control.js";
import { RawSonioxTtsGateway } from "./soniox/raw-tts-gateway.js";
import { UsageLedger } from "./usage/usage-ledger.js";

export type RunningApplication = {
  shutdown(reason?: string): Promise<void>;
};

export async function startApplication(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunningApplication> {
  const config = loadConfig(env);
  const logger = createSafeLogger(config.logIdHmacKey);
  const terms = loadTranslationTerms(config.storage.translationTermsPath);
  const ledger = UsageLedger.open({
    databasePath: config.storage.sqlitePath,
    pricing: config.pricing,
    limits: {
      userMonthlyCostMicrousd: config.limits.userMonthlyCostMicrousd,
      guildMonthlyCostMicrousd: config.limits.guildMonthlyCostMicrousd,
      globalMonthlyCostMicrousd: config.limits.globalMonthlyCostMicrousd,
    },
    reconcileMaxStalenessSeconds: config.usage.reconcileMaxStalenessSeconds,
  });
  let client: Client | undefined;
  let reconciliationTimer: NodeJS.Timeout | undefined;
  try {
    const recovered = ledger.recoverInterruptedWork(new Date());
    logger.info("startup_recovery_complete", {
      sessions: recovered.sessions,
      provider_requests: recovered.providerRequests,
    });

    const soniox = createSonioxClient(config.soniox);
    await verifySonioxConfiguration(soniox, config.soniox);
    const capacityGate = new SonioxCapacityGate(soniox);
    await capacityGate.assertCanStart({
      sttStreams: 0,
      ttsStreams: 0,
      at: new Date(),
    });
    const reconciler = new SonioxUsageReconciler(soniox, ledger);
    await reconciler.reconcile(new Date());
    logger.info("soniox_preflight_complete", { region: config.soniox.region });

    const discordClient = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
      allowedMentions: { parse: [] },
    });
    client = discordClient;
    const sttFactory = new SonioxSttFactory(
      soniox,
      config.soniox.sttModel,
      terms,
    );
    const tts = new RawSonioxTtsGateway({
      url: config.soniox.ttsWebSocketUrl,
      apiKey: config.soniox.apiKey,
      model: config.soniox.ttsModel,
      voices: config.soniox.voices,
      terminationTimeoutMs: config.soniox.terminationTimeoutMs,
      ledger,
    });
    const controllerReference: { current?: DiscordBotController } = {};
    const driver = new DiscordTranslationDriver({
      client: discordClient,
      config,
      ledger,
      sttFactory,
      tts,
      onFailure: (guildId, reason, publicMessage, cause) => {
        void controllerReference.current?.handleRuntimeFailure(
          guildId,
          reason,
          publicMessage,
          cause,
        ).catch((error: unknown) => {
          logger.error("runtime_failure_cleanup_failed", error, {
            guild_id: logger.pseudonymize(guildId),
            reason,
          });
        });
      },
    });
    const sessions = new SessionManager({
      driver,
      usageGate: ledger,
      capacityGate,
    });
    const commands = new TranslationCommandService({
      allowedGuildIds: config.discord.allowedGuildIds,
      allowedUserIds: config.discord.allowedUserIds,
      maxSpeakersPerSession: config.limits.maxSpeakersPerSession,
      sessions,
    });
    const controller = new DiscordBotController({
      client: discordClient,
      commands,
      logger,
    });
    controllerReference.current = controller;
    controller.attach();
    discordClient.on(Events.Warn, (message) => {
      logger.warn("discord_client_warning", { warning_type: warningType(message) });
    });
    discordClient.on(Events.Error, (error) => {
      logger.error("discord_client_error", error);
    });

    const ready = once(discordClient, Events.ClientReady);
    await discordClient.login(config.discord.token);
    await ready;
    logger.info("application_ready", {
      allowed_guild_count: config.discord.allowedGuildIds.size,
      allowed_user_count: config.discord.allowedUserIds.size,
    });

    let reconciliationRunning = false;
    const timer = setInterval(() => {
      if (reconciliationRunning) return;
      reconciliationRunning = true;
      void reconciler.reconcile(new Date())
        .catch((error: unknown) => {
          logger.error("usage_reconciliation_failed", error);
        })
        .finally(() => {
          reconciliationRunning = false;
        });
    }, config.usage.reconcileIntervalSeconds * 1_000);
    reconciliationTimer = timer;
    timer.unref();

    let shutdownPromise: Promise<void> | undefined;
    return {
      shutdown: (reason = "PROCESS_SHUTDOWN") => {
        shutdownPromise ??= shutdownApplication({
          reason,
          logger,
          controller,
          sessions,
          client: discordClient,
          ledger,
          reconciliationTimer: timer,
        });
        return shutdownPromise;
      },
    };
  } catch (error) {
    if (reconciliationTimer) clearInterval(reconciliationTimer);
    await client?.destroy();
    ledger.close();
    logger.error("application_start_failed", error);
    throw error;
  }
}

function warningType(message: string): string {
  const firstWord = message.trim().split(/\s+/u)[0];
  return firstWord?.slice(0, 40) ?? "unknown";
}

async function shutdownApplication(input: {
  reason: string;
  logger: SafeLogger;
  controller: DiscordBotController;
  sessions: SessionManager;
  client: Client;
  ledger: UsageLedger;
  reconciliationTimer: NodeJS.Timeout;
}): Promise<void> {
  input.logger.info("application_shutdown_started", { reason: input.reason });
  input.controller.stopAcceptingCommands();
  clearInterval(input.reconciliationTimer);
  try {
    await input.sessions.stopAll(input.reason);
  } finally {
    input.controller.detach();
    await input.client.destroy();
    input.ledger.close();
  }
  input.logger.info("application_shutdown_complete", { reason: input.reason });
}
