import { authorizeOperationalSnapshot } from '@/lib/disburse/operational-authorization';
import { checkOperationalAlerts } from '@/lib/disburse/operational-alerts';
import { getOperationalSnapshot } from '@/lib/disburse/operational-snapshot';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  if (!authorizeOperationalSnapshot(request.headers.get('authorization'))) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }
  const snapshot = await getOperationalSnapshot();
  return Response.json(
    { snapshot, alerts: checkOperationalAlerts(snapshot) },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
