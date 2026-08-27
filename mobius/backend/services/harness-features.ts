export function harnessFeatureEnabled(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export function harnessCapacity(name: string, fallback: number, maximum = 64): number {
  const parsed = Number.parseInt(String(process.env[name] || ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(maximum, parsed);
}

export function adaptiveHarnessSchedulingEnabled(): boolean {
  return true;
}

export function harnessBatchCreateEnabled(): boolean {
  return true;
}

export function harnessRootResultWakeEnabled(): boolean {
  return harnessFeatureEnabled('HARNESS_ROOT_RESULT_WAKE_ENABLED', true);
}

export function harnessResultAckRequired(): boolean {
  return harnessFeatureEnabled('HARNESS_RESULT_ACK_REQUIRED', true);
}

export function harnessNotificationDigestEnabled(): boolean {
  return harnessFeatureEnabled('HARNESS_NOTIFICATION_DIGEST_ENABLED');
}
