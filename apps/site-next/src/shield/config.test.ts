import { describe, expect, it } from "vitest";
import { DEFAULT_NODES, MIN_NODES, SUBMIT_PATH, listProblem, originProblem, usableOrigins } from "./config";

describe("node origins", () => {
  it("accepts https origins", () => {
    expect(originProblem("https://api.rougechain.io", false)).toBeNull();
    expect(originProblem("https://node.example:8443", false)).toBeNull();
  });
  it("refuses spellings the site and the wallet core would read differently", () => {
    expect(originProblem("https://[::ffff:7f00:1]", false)).toBe("ip6_literal");
    expect(originProblem("https://[2001:db8::1]", false)).toBe("ip6_literal");
    expect(originProblem("https://node.example.", false)).toBe("trailing_dot");
    expect(originProblem("https://[64:ff9b:1::1]", false)).toBe("local_nat64");
  });
  it("allows plain http only for a loopback node in a development build", () => {
    expect(originProblem("http://localhost:5101", true)).toBeNull();
    expect(originProblem("http://localhost:5101", false)).toBe("not_https");
    expect(originProblem("http://node.example", true)).toBe("not_https");
  });
  it("a list: no duplicates, an odd number", () => {
    expect(listProblem(["https://a.example", "https://b.example", "https://c.example"])).toBeNull();
    expect(listProblem(["https://a.example", "https://A.example", "https://c.example"])).toBe("duplicate");
    expect(listProblem(["https://a.example", "https://b.example", "https://c.example", "https://d.example"])).toBe("even");
  });
});

describe("default node set", () => {
  it("mainnet: the project's three machines, each a valid https origin on its own host, named as the project's", () => {
    const origins = usableOrigins(DEFAULT_NODES.mainnet);
    expect(origins).toEqual(["https://api.rougechain.io", "https://api2.rougechain.io", "https://api3.rougechain.io"]);
    expect(origins.length).toBeGreaterThanOrEqual(MIN_NODES);
    expect(listProblem(origins)).toBeNull();
    for (const n of DEFAULT_NODES.mainnet) expect(n.operator).toMatch(/^RougeChain \(project\)/);
  });
  it("testnet: the project's three machines, each a valid https origin on its own host, named as the project's", () => {
    const origins = usableOrigins(DEFAULT_NODES.testnet);
    expect(origins).toEqual(["https://testnet.rougechain.io", "https://testnet2.rougechain.io", "https://testnet3.rougechain.io"]);
    expect(origins.length).toBeGreaterThanOrEqual(MIN_NODES);
    expect(listProblem(origins)).toBeNull();
    for (const n of DEFAULT_NODES.testnet) expect(n.operator).toMatch(/^RougeChain \(project\)/);
  });
  it("submits on the V2-only route, never the generic broadcast", () => {
    expect(SUBMIT_PATH).toBe("/api/shield-v2/submit");
  });
});
