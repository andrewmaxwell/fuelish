import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { generateKeyPairSync } from "node:crypto";

// A stand-in for Google's signing key: the Worker trusts its public half, the tests sign with the private half.
const google = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...google.publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
const privateJwk = { ...google.privateKey.export({ format: "jwk" }), kid: "test-key" };

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          DEVICE_TOKEN: "test-device-token",
          WEB_TOKEN: "test-web-token",
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          TEST_GOOGLE_JWKS: JSON.stringify({ keys: [publicJwk] }),
          TEST_GOOGLE_PRIVATE_JWK: JSON.stringify(privateJwk),
        },
      },
    })),
  ],
  test: { setupFiles: ["./test/setup.ts"] },
});
