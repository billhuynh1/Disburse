import { authorizeOperationalSnapshot } from '@/lib/disburse/operational-authorization';
import { checkOperationalAlerts } from '@/lib/disburse/operational-alerts';
import { getOperationalSnapshot } from '@/lib/disburse/operational-snapshot';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const noStoreHeaders = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  if (!authorizeOperationalSnapshot(request.headers.get('authorization'))) {
    return Response.json({ error: 'Not found' }, { status: 404, headers: noStoreHeaders });
  }
  try {
    const snapshot = await getOperationalSnapshot();
    return Response.json(
      { snapshot, alerts: checkOperationalAlerts(snapshot) },
      { headers: noStoreHeaders }
    );
  } catch {
    return new Response(null, { status: 500, headers: noStoreHeaders });
  }
}
