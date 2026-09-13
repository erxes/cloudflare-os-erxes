import { describe, expect, test } from "bun:test";
import { authShorthandFromProbe } from "../src/executor-connect.ts";

describe("authShorthandFromProbe", () => {
  test("oauth wins over bearer", () => {
    expect(
      authShorthandFromProbe({ requiresOAuth: true, requiresAuthentication: true }),
    ).toEqual({ kind: "oauth2" });
  });

  test("bearer header when auth required without oauth", () => {
    expect(authShorthandFromProbe({ requiresAuthentication: true })).toEqual({
      kind: "header",
      headerName: "Authorization",
      prefix: "Bearer ",
    });
  });

  test("none when open", () => {
    expect(authShorthandFromProbe({})).toEqual({ kind: "none" });
  });
});
