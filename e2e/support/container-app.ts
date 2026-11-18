import { mkdirSync } from "node:fs";
import path from "node:path";

/** Use the container entrypoint and an isolated capture/storage directory. */
export function containerApp(
  image: string,
  {
    port,
    outbox,
    env,
  }: { port: number; outbox: string; env: Record<string, string> },
) {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (!uid || gid === undefined) {
    throw new Error("Container browser tests require a non-root host user.");
  }
  const data = path.dirname(path.dirname(outbox));
  mkdirSync(data, { recursive: true });
  const host = "host.docker.internal";
  const hostNetwork = process.platform === "linux";

  function reachableFromContainer(value: string) {
    if (hostNetwork) return value;
    const url = new URL(value);
    if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      url.hostname = host;
    }
    return url.href;
  }

  const containerEnv = {
    ...env,
    ...(hostNetwork ? { HOSTNAME: "127.0.0.1", PORT: String(port) } : {}),
    DATABASE_URL: reachableFromContainer(env.DATABASE_URL),
    EIDEASY_API_URL: reachableFromContainer(env.EIDEASY_API_URL),
    EMAIL_CAPTURE_DIR: "/app/.data/e2e/outbox",
    STORAGE_LOCAL_DIR: "/app/.data/e2e/storage",
  };
  if (process.env.S3_ENDPOINT) {
    Object.assign(containerEnv, {
      S3_ENDPOINT: reachableFromContainer(process.env.S3_ENDPOINT),
    });
  }
  const inherited = [
    "S3_BUCKET",
    "S3_REGION",
    "S3_FORCE_PATH_STYLE",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
  ];
  const args = [
    "docker",
    "run",
    "--rm",
    "--init",
    "--platform",
    "linux/amd64",
    "--user",
    `${uid}:${gid}`,
    ...(hostNetwork
      ? ["--network", "host"]
      : ["--publish", `127.0.0.1:${port}:3000`]),
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/tmp:rw,nosuid,size=256m",
    "--tmpfs",
    `/app/.next/cache:rw,uid=${uid},gid=${gid},size=256m`,
    "--mount",
    `type=bind,source=${data},target=/app/.data`,
    ...[...Object.keys(containerEnv), ...inherited].flatMap((name) => [
      "--env",
      name,
    ]),
    image,
  ];
  // Playwright's web server uses a shell command; quote each argument.
  const command = args
    .map((arg) => "'" + arg.replaceAll("'", "'\\''") + "'")
    .join(" ");
  return {
    command,
    env: containerEnv,
    gracefulShutdown: { signal: "SIGTERM" as const, timeout: 10_000 },
    launchOptions: hostNetwork
      ? undefined
      : { args: [`--host-resolver-rules=MAP ${host} 127.0.0.1`] },
  };
}
