import { describe, expect, it } from "@effect/vitest";

import {
  buildDevinAcpSpawnInput,
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
