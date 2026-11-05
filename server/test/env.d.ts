import type { Env as WorkerEnv } from "../src/index";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
      TEST_GOOGLE_PRIVATE_JWK: string;
    }
    interface GlobalProps {
      mainModule: typeof import("../src/index");
    }
  }
}
