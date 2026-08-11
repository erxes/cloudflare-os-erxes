declare namespace Cloudflare {
  interface Env {
    BASE_URL?: string;
    ERXES_GRAPHQL_URL?: string;
    ERXES_ALLOW_INSECURE?: string;
    EXECUTOR_URL?: string;
    EXECUTOR_AUTH_SECRET?: string;
    MCP_ALLOW_INSECURE?: string;
    MCP_CLIENT_NAME?: string;
  }

  interface GlobalProps {
    mainModule: typeof import("./erxes.js");
    durableNamespaces: "ErxesLoginAccount" | "ExecutorGatekeeper";
  }
}

interface Env extends Cloudflare.Env {}
