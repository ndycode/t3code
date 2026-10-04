/**
 * DirectEndpoints - the LAN and tailnet addresses this server listens on now.
 *
 * Clients connected one way (often T3 Connect) save these as extra routes so
 * they can move to a faster path when one is reachable, and replace a saved
 * LAN address when DHCP or a new Wi-Fi network changes it. Only addresses the
 * server is actually bound to are listed: a loopback-only server lists none,
 * because its loopback address means a different machine to every client.
 */
import type { ServerDirectEndpoint } from "@t3tools/contracts";
import {
  buildTailscaleHttpsBaseUrl,
  isTailscaleIpv4Address,
  readTailscaleStatus,
} from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as NodeOS from "node:os";

import * as ServerConfig from "../config.ts";
import { formatHostForUrl, isLoopbackHost, isWildcardHost } from "../startupAccess.ts";

type NetworkInterfacesMap = ReturnType<typeof NodeOS.networkInterfaces>;

export class DirectEndpoints extends Context.Service<
  DirectEndpoints,
  {
    readonly resolve: () => Effect.Effect<ReadonlyArray<ServerDirectEndpoint>>;
  }
>()("t3/environment/DirectEndpoints") {}

const isUsableAddress = (address: string): boolean =>
  !address.startsWith("127.") && !address.startsWith("169.254.") && !address.startsWith("fe80:");

/**
 * Plain HTTP endpoints for the addresses a server bound to `host` accepts.
 * IPv4 only: link-local and temporary IPv6 addresses change too often to be
 * worth saving.
 */
export function resolveBoundEndpoints(input: {
  readonly host: string | undefined;
  readonly port: number;
  readonly interfaces: NetworkInterfacesMap;
}): ReadonlyArray<ServerDirectEndpoint> {
  if (isLoopbackHost(input.host)) return [];
  const addresses = isWildcardHost(input.host)
    ? Object.values(input.interfaces)
        .flatMap((entries) => entries ?? [])
        .filter(
          (entry) => !entry.internal && entry.family === "IPv4" && isUsableAddress(entry.address),
        )
        .map((entry) => entry.address)
    : [input.host!];
  return [...new Set(addresses)].map((address) => ({
    kind: isTailscaleIpv4Address(address) ? "tailnet" : "lan",
    httpBaseUrl: `http://${formatHostForUrl(address)}:${input.port}/`,
  }));
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const resolve = Effect.gen(function* () {
    const endpoints = [
      ...resolveBoundEndpoints({
        host: config.host,
        port: config.port,
        interfaces: NodeOS.networkInterfaces(),
      }),
    ];
    // Tailscale Serve terminates HTTPS on the tailnet name and forwards to
    // loopback, so it works even for a loopback-only server.
    if (config.tailscaleServeEnabled) {
      const magicDnsName = yield* readTailscaleStatus.pipe(
        Effect.map((status) => status.magicDnsName),
        Effect.orElseSucceed(() => null),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      if (magicDnsName !== null) {
        endpoints.push({
          kind: "tailnet",
          httpBaseUrl: buildTailscaleHttpsBaseUrl({
            magicDnsName,
            servePort: config.tailscaleServePort,
          }),
        });
      }
    }
    return endpoints;
  });

  return DirectEndpoints.of({ resolve: () => resolve });
});

export const layer = Layer.effect(DirectEndpoints, make);
