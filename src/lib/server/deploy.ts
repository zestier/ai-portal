export type DeployMetadata = {
  deployedAt: string;
};

const processStartedAt = new Date(
  Date.now() - process.uptime() * 1000,
).toISOString();
const deployedAt =
  readDeployTime(process.env.ZAP_DEPLOYED_AT) ?? processStartedAt;

export function getDeployMetadata(): DeployMetadata {
  return { deployedAt };
}

function readDeployTime(value: string | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp).toISOString();
}
