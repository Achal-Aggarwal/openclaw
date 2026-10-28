import { expect, it } from "vitest";
import { assertCodexNativeCommandAuthConfig } from "./native-auth-validation.js";

it.each(["http_headers", "env_http_headers"])(
  "rejects mixed native credentials through %s",
  (field) => {
    expect(() =>
      assertCodexNativeCommandAuthConfig({
        provider: "fixture",
        baseUrl: "https://inference.example.test/v1",
        effectiveConfig: {
          model_providers: {
            fixture: {
              base_url: "https://inference.example.test/v1",
              wire_api: "responses",
              auth: { command: "/synthetic/token-command" },
              [field]: { "x-api-key": "synthetic-extra-credential" },
            },
          },
        },
      }),
    ).toThrow("no other credential source");
  },
);
