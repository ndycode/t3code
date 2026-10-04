import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import {
  buildDevinAcpSpawnInput,
  devinAcpCatalog,
  devinAcpRegistrySettings,
  devinAcpSpawnArgs,
} from "./DevinAcpSupport.ts";

describe("devinAcpSpawnArgs", () => {
  it("runs the local ACP server by default", () => {
    expect(devinAcpSpawnArgs(undefined)).toEqual(["acp"]);
    expect(devinAcpSpawnArgs(null)).toEqual(["acp"]);
    expect(devinAcpSpawnArgs({ binaryPath: "devin", cloud: false })).toEqual(["acp"]);
  });

  it("relays sessions to Devin Cloud when cloud is enabled", () => {
    expect(devinAcpSpawnArgs({ binaryPath: "devin", cloud: true })).toEqual(["acp", "--cloud"]);
  });
});

describe("buildDevinAcpSpawnInput", () => {
  it("defaults to the devin binary on PATH", () => {
    expect(buildDevinAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "devin",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("honors a configured binary path and cloud mode", () => {
    expect(
      buildDevinAcpSpawnInput({ binaryPath: "/opt/devin/bin/devin", cloud: true }, "/tmp/project"),
    ).toEqual({
      command: "/opt/devin/bin/devin",
      args: ["acp", "--cloud"],
      cwd: "/tmp/project",
    });
  });

  it("forwards the instance environment only when one is provided", () => {
    expect(
      buildDevinAcpSpawnInput({ binaryPath: "devin", cloud: false }, "/tmp/project"),
    ).not.toHaveProperty("env");
    expect(
      buildDevinAcpSpawnInput({ binaryPath: "devin", cloud: false }, "/tmp/project", {
        DEVIN_HOME: "/x",
      }).env,
    ).toEqual({ DEVIN_HOME: "/x" });
  });
});

describe("devinAcpRegistrySettings", () => {
  it("synthesizes the registry entry for the local devin binary", () => {
    const settings = devinAcpRegistrySettings({ binaryPath: "" });
    expect(settings.agentId).toBe("devin");
    expect(settings.commandPath).toBe("devin");
  });

  it("points the registry entry at the configured binary", () => {
    const settings = devinAcpRegistrySettings({ binaryPath: "/opt/devin/bin/devin" });
    expect(settings.agentId).toBe("devin");
    expect(settings.commandPath).toBe("/opt/devin/bin/devin");
  });
});

describe("devinAcpCatalog", () => {
  const stubResolved = {
    agent: { id: "devin" },
    distribution: "binary",
    spawn: { command: "devin", args: ["acp"], cwd: "/tmp/project" },
  } as unknown as AcpRegistrySupport.ResolvedAcpRegistryAgent;
  const stubCatalog = {
    resolve: () => Effect.succeed(stubResolved),
  } as unknown as AcpRegistrySupport.AcpRegistryCatalog["Service"];

  it("returns the base catalog unchanged for local mode", () => {
    expect(devinAcpCatalog(stubCatalog, { cloud: false })).toBe(stubCatalog);
  });

  it.effect("appends --cloud to the resolved devin spawn in cloud mode", () =>
    Effect.gen(function* () {
      const catalog = devinAcpCatalog(stubCatalog, { cloud: true });
      const resolved = yield* catalog.resolve(
        devinAcpRegistrySettings({ binaryPath: "" }),
        "/tmp/project",
      );
      expect(resolved.spawn).toEqual({
        command: "devin",
        args: ["acp", "--cloud"],
        cwd: "/tmp/project",
      });
    }),
  );
});
