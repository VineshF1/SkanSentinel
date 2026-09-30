export function allowPrivateWebhooks(): boolean {
  return process.env.ALLOW_PRIVATE_WEBHOOKS === "1";
}

export function databasePath(): string {
  return process.env.DATABASE_PATH ?? "./data/skansentinel.db";
}

export function adminPassword(): string {
  return process.env.ADMIN_PASSWORD ?? "";
}

export function requireAdminPassword(): string {
  const pw = adminPassword();
  if (!pw) {
    throw new Error(
      "ADMIN_PASSWORD is not set. Refusing to start without an admin password."
    );
  }
  return pw;
}
