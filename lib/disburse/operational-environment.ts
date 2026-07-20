export function isOperationalCronExpected(environment: Readonly<Record<string, string | undefined>> = process.env) {
  if (environment.DISBURSE_CRON_EXPECTED === 'true') return true;
  if (environment.DISBURSE_CRON_EXPECTED === 'false') return false;
  return environment.DISBURSE_DEPLOYMENT_ENV === 'production';
}
