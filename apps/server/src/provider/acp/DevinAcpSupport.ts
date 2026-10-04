import { AcpRegistrySettings, type DevinSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import type * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export const DEVIN_ACP_AGENT_ID = "devin";

type DevinAcpRuntimeDevinSettings = Pick<DevinSettings, "binaryPath" | "cloud">;

interface DevinAcpRuntimeInput extends Omit<AcpSessionRuntime.AcpSessionRuntimeOptions, "spawn"> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeDevinSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * `devin acp` runs the local ACP server; `--cloud` relays every session to
 * Devin Cloud on the same account. Model and mode stay off argv: they are
 * session config options applied after `session/new`.
 */
export function devinAcpSpawnArgs(
  devinSettings: DevinAcpRuntimeDevinSettings | null | undefined,
): ReadonlyArray<string> {
  return devinSettings?.cloud ? ["acp", "--cloud"] : ["acp"];
}

export function buildDevinAcpSpawnInput(
  devinSettings: DevinAcpRuntimeDevinSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: devinSettings?.binaryPath || "devin",
    args: [...devinAcpSpawnArgs(devinSettings)],
    cwd,
    ...(environment === undefined ? {} : { env: environment }),
  };
}

export const makeDevinAcpRuntime = (
  input: DevinAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDevinAcpSpawnInput(input.devinSettings, input.cwd, input.environment),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * Auth, session-management, and configuration probes are agent-agnostic ACP
 * helpers that take `AcpRegistrySettings`. The Devin driver synthesizes the
 * entry for the local `devin` binary so those helpers resolve the same spawn
 * they already do for registry-installed Devin instances — no Devin-specific
 * duplicate of that machinery.
 */
const decodeAcpRegistrySettings = Schema.decodeSync(AcpRegistrySettings);

export function devinAcpRegistrySettings(
  devinSettings: Pick<DevinSettings, "binaryPath">,
): AcpRegistrySettings {
  return decodeAcpRegistrySettings({
    agentId: DEVIN_ACP_AGENT_ID,
    commandPath: devinSettings.binaryPath || "devin",
  });
}

/**
 * The registry helpers above resolve their spawn through
 * `AcpRegistryCatalog.resolve`, which takes its args from the registry
 * distribution (`devin acp`). In Devin Cloud mode those same helpers must
 * target `devin acp --cloud`, so the Devin driver injects this decorated
 * catalog that rewrites the resolved spawn to match the orchestration
 * transport.
 */
export function devinAcpCatalog(
  catalog: AcpRegistrySupport.AcpRegistryCatalog["Service"],
  devinSettings: Pick<DevinSettings, "cloud">,
): AcpRegistrySupport.AcpRegistryCatalog["Service"] {
  if (!devinSettings.cloud) return catalog;
  return {
    ...catalog,
    resolve: (settings, cwd, environment) =>
      catalog.resolve(settings, cwd, environment).pipe(
        Effect.map((resolved) =>
          settings.agentId === DEVIN_ACP_AGENT_ID
            ? {
                ...resolved,
                spawn: {
                  ...resolved.spawn,
                  args: [...resolved.spawn.args, "--cloud"],
                },
              }
            : resolved,
        ),
      ),
  };
}
