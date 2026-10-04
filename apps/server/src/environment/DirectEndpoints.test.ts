import type * as NodeOS from "node:os";
import { describe, expect, it } from "vite-plus/test";

import { resolveBoundEndpoints } from "./DirectEndpoints.ts";

const INTERFACES: ReturnType<typeof NodeOS.networkInterfaces> = {
  lo0: [
    {
      address: "127.0.0.1",
      netmask: "255.0.0.0",
      family: "IPv4",
      mac: "00:00:00:00:00:00",
      internal: true,
      cidr: "127.0.0.1/8",
    },
  ],
  en0: [
    {
      address: "192.168.1.10",
      netmask: "255.255.255.0",
      family: "IPv4",
      mac: "aa:bb:cc:dd:ee:ff",
      internal: false,
      cidr: "192.168.1.10/24",
    },
    {
      address: "fe80::1",
      netmask: "ffff:ffff:ffff:ffff::",
      family: "IPv6",
      mac: "aa:bb:cc:dd:ee:ff",
      internal: false,
      cidr: "fe80::1/64",
      scopeid: 4,
    },
  ],
  en1: [
    {
      address: "203.0.113.20",
      netmask: "255.255.255.0",
      family: "IPv4",
      mac: "aa:bb:cc:dd:ee:00",
      internal: false,
      cidr: "203.0.113.20/24",
    },
  ],
  utun4: [
    {
      address: "100.101.102.103",
      netmask: "255.255.255.255",
      family: "IPv4",
      mac: "00:00:00:00:00:00",
      internal: false,
      cidr: "100.101.102.103/32",
    },
  ],
};

describe("resolveBoundEndpoints", () => {
  it("lists nothing for a loopback-only server", () => {
    expect(resolveBoundEndpoints({ host: undefined, port: 3773, interfaces: INTERFACES })).toEqual(
      [],
    );
    expect(
      resolveBoundEndpoints({ host: "127.0.0.1", port: 3773, interfaces: INTERFACES }),
    ).toEqual([]);
  });

  it("lists every external IPv4 address for a wildcard bind, tagging the tailnet one", () => {
    expect(resolveBoundEndpoints({ host: "0.0.0.0", port: 3773, interfaces: INTERFACES })).toEqual([
      { kind: "lan", httpBaseUrl: "http://192.168.1.10:3773/" },
      { kind: "tailnet", httpBaseUrl: "http://100.101.102.103:3773/" },
    ]);
  });

  it("lists only the bound address for a specific bind", () => {
    expect(
      resolveBoundEndpoints({ host: "100.101.102.103", port: 3773, interfaces: INTERFACES }),
    ).toEqual([{ kind: "tailnet", httpBaseUrl: "http://100.101.102.103:3773/" }]);
  });

  it("never reports a public address, which would carry the credential over plain HTTP", () => {
    expect(
      resolveBoundEndpoints({ host: "203.0.113.20", port: 3773, interfaces: INTERFACES }),
    ).toEqual([]);
  });
});
