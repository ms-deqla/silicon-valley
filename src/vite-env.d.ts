/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** the leaderboard service's base URL (server/); set at build time, the HTTP transport is used when it is non-empty */
  readonly VITE_LEADERBOARD_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
